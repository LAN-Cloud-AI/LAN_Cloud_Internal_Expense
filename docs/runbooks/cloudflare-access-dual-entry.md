# Cloudflare Access 双入口历史记录

> 历史资料：IE-OA 已改为仅支持 OnePass 登录。本文保留旧 Access 配置与回退记录，不得用于恢复 Cloudflare 登录；当前接入与回退边界见 [详细技术参考](../../app/README.md)。

适用系统：兰芯云朵行政——订阅资产管理系统。本文是待执行的生产变更手册；除非“执行记录”另有经验证的非敏感结果，不表示任何变更已经发生。

## 安全边界

- API Token、Access JWT、绑定码、完整外部邮箱和迁移管理员邮箱绝不写入本手册、命令历史、shell 输出、仓库或审计详情。
- 仅在已授权的终端环境中保留 `CF_DEPLOY_TOKEN`，不得 `echo`、`env`、`set -x` 或把它拼进 URL。
- 所有 Access/DNS 变更先读取后写入；每次 mutation 后立即 GET 同一资源回验。Access 必须先于能到达业务页面的 DNS/Worker 流量完成。
- 旧 `ie_oa` 是暂时受 Access 保护的迁移入口。Worker 仅安全重定向其 GET/HEAD，绝不跨 Host 重放写请求。

## 已知非敏感常量

```sh
CF_ACCOUNT_ID=889e913c81be632234cb26e2b75b0b9a
CF_ZONE_ID=12d261b22fda850521cbfc9dba0bc644
CF_WORKER=lan-cloud-internal-expense
CF_D1=lan-cloud-expense
CF_D1_ID=b67c7b23-30ed-4077-b5d2-9452d2e69578
CF_R2=lan-cloud-expense-receipts
CF_ZONE=lancloudtech.com
CF_CORPORATE_HOST=ie-oa.lancloudtech.com
CF_EXTERNAL_HOST=external-ie-oa.lancloudtech.com
CF_LEGACY_HOST=ie_oa.lancloudtech.com
```

在当前 shell 中验证已经导出的受限 Token；该命令只输出 Cloudflare 的校验响应，不显示 Token 本身：

```sh
curl --silent --show-error --fail-with-body \
  -H "Authorization: Bearer $CF_DEPLOY_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify
```

继续前确认 Token 有 D1、Workers Script/Route、DNS、R2 和 Access Application/Policy 所需最小权限；若缺权，停止，不要用更高权限 Token 替换。

## 0. 本地预检（不改变 Cloudflare）

```sh
cd /Users/i/myCode/LAN_Cloud_Internal_Expense/app
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir dist
```

只有三项均成功，才进行远端变更。

## 1. 先读取 Access 与 DNS 现状

以下命令把每一份 API 原始响应写入仅当前用户可读的临时目录，终端只输出经 `jq` 提取的资源 ID、hostname、状态和布尔检查结果。**不得**把原始 JSON `cat`、打印到终端、复制进工单或提交仓库。实际路径以 Access organization 的 API 响应为准。

```sh
umask 077
CF_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lan-cloud-access.XXXXXX")"
trap 'rm -rf "$CF_RUN_DIR"' EXIT HUP INT TERM

cf_get() {
  # $1 is an approved local basename, $2 is a Cloudflare API path.
  curl --silent --show-error --fail-with-body \
    -H "Authorization: Bearer $CF_DEPLOY_TOKEN" \
    "https://api.cloudflare.com/client/v4$2" >"$CF_RUN_DIR/$1.json"
}

cf_get organization "/accounts/$CF_ACCOUNT_ID/access/organizations"
cf_get apps "/accounts/$CF_ACCOUNT_ID/access/apps"
cf_get idps "/accounts/$CF_ACCOUNT_ID/access/identity_providers"
cf_get corporate-dns "/zones/$CF_ZONE_ID/dns_records?name=$CF_CORPORATE_HOST"
cf_get external-dns "/zones/$CF_ZONE_ID/dns_records?name=$CF_EXTERNAL_HOST"
cf_get legacy-dns "/zones/$CF_ZONE_ID/dns_records?name=$CF_LEGACY_HOST"

# Only non-secret identifiers and hostnames are emitted.
jq -r '.result | {id: (.id // null), auth_domain: (.auth_domain // null)}' "$CF_RUN_DIR/organization.json"
jq -r '.result[] | [.id, .domain] | @tsv' "$CF_RUN_DIR/apps.json"
jq -r '.result[] | select(.type == "cloudflare" or .type == "github") | [.id, .type] | @tsv' "$CF_RUN_DIR/idps.json"
for record in corporate external legacy; do
  jq -r --arg expected "${record}" '.result | if length == 0 then "absent" else .[] | [.id, .name, (.proxied|tostring)] | @tsv end' \
    "$CF_RUN_DIR/$record-dns.json"
done
```

从 apps 列表中取得现有企业 App ID、从 identity providers 列表中取得 Cloudflare/GitHub IdP ID，并将它们仅保存到当前受限 shell（以下变量值不属于仓库）。下面的每一次精确 GET 仍只落入 `CF_RUN_DIR`；只打印所需 ID/域名/规则形状：

```sh
# 值来自上一步 API 响应；不要把响应或这些赋值粘贴进提交、日志或工单附件。
CF_CORPORATE_APP_ID='<existing-corporate-app-id>'

cf_get corporate-app "/accounts/$CF_ACCOUNT_ID/access/apps/$CF_CORPORATE_APP_ID"
cf_get corporate-policies "/accounts/$CF_ACCOUNT_ID/access/apps/$CF_CORPORATE_APP_ID/policies"
jq -r '.result | [.id, .domain, (.aud // null)] | @tsv' "$CF_RUN_DIR/corporate-app.json"
jq -r '.result[] | [.id, .decision, .precedence] | @tsv' "$CF_RUN_DIR/corporate-policies.json"
```

记录且仅在受限操作记录中保存以下 ID：Access organization、现有企业 App、企业 policy、Cloudflare IdP、GitHub IdP，以及后续新增的外部 App/policy/DNS record。确认现有企业 App 的完整对象和 policy 后才可 PUT；Access App 的 PUT 需要完整 payload，不能只发送想变更的 `domain` 字段，否则可能重置 `destinations`、session/cookie/visibility 配置或已允许的 IdP。

### 1.1 Cloudflare IdP 必须允许任意外部 Cloudflare 账号

外部入口的 Cloudflare 登录不可以被限制为本 Cloudflare 账户的成员；绑定身份的邮箱不受企业邮箱域限制。Token 只有 IdP 读取权限，因此本手册**不**尝试修改 IdP。先在 Zero Trust Dashboard 打开上一步读取到的 Cloudflare IdP，核对其可登录范围明确为“所有 Cloudflare 账号/不限制为本账户成员”，再作下列人工确认门禁；看不清该设置、设置为仅成员、或无法确认时都必须停止。由有该 IdP 管理权限的人修改后，重新从步骤 1 开始读取和复核。

```sh
printf '%s' 'Cloudflare IdP has been checked as allowing arbitrary external Cloudflare accounts (type YES): '
IFS= read -r CF_CLOUDFLARE_IDP_UNRESTRICTED
[ "$CF_CLOUDFLARE_IDP_UNRESTRICTED" = YES ] || {
  echo 'STOP: Cloudflare IdP scope is not confirmed unrestricted; do not create/update external Access App.' >&2
  exit 1
}
```

这不是允许“默认通过”的提示：只有已核对 IdP 配置的操作人输入精确确认值才会继续。浏览器验收还必须使用一个并非本 Cloudflare 账户成员的 Cloudflare 账号完成绑定和重新登录。

### 1.2 旧入口 DNS 与保护门禁

旧 `ie_oa` 必须已存在、为 `proxied: true`，并且仍是企业 Access App 的 destination，才允许部署 Worker route。它是迁移期间的受保护入口，**不得**由本流程自动创建；任何一项不满足都停止，先由授权操作人恢复既有记录/企业 App 后重新读取：

```sh
jq -e --arg host "$CF_LEGACY_HOST" '
  .result | length == 1 and .[0].name == $host and .[0].proxied == true
' "$CF_RUN_DIR/legacy-dns.json" >/dev/null || {
  echo 'STOP: legacy DNS must exist exactly once and be proxied.' >&2
  exit 1
}

jq -e --arg host "$CF_LEGACY_HOST" '
  .result.destinations | any(.type == "public" and .uri == $host)
' "$CF_RUN_DIR/corporate-app.json" >/dev/null || {
  echo 'STOP: legacy hostname is not protected by the corporate Access App.' >&2
  exit 1
}
```

## 2. 建立受保护入口，随后才承接流量

外部绑定入口使用一级子域 `external-ie-oa.lancloudtech.com`，可由 Cloudflare Universal SSL 覆盖。它必须和企业/旧入口一样使用普通的 proxied DNS 记录与 Worker route；**不得**改为 Workers Custom Domain，也不得购买或启用 Advanced Certificate Manager (ACM) 或其他付费证书。

### 2.1 DNS 占位记录

仅当上一步的 DNS 查询确认新 hostname **不存在**时，创建代理（`proxied: true`）A 记录。使用与既有 Worker route 相同的占位源站约定（例如团队当前统一的无业务占位 IP）；不要猜测、替换或暴露真实业务源站。若记录已存在，只核对它是代理状态，不重复创建。旧 `ie_oa` 永远不在此处创建，必须已通过步骤 1.2 的门禁。

```sh
# 将 CF_WORKER_PLACEHOLDER_IP 替换为既有 route 使用的同一占位值；不要把真实源站写入本手册。
create_new_dns_if_absent() {
  # $1 is corporate/external; source JSON comes only from the protected temp dir.
  local label="$1" short_name full_host
  case "$label" in
    corporate) short_name=ie-oa; full_host=$CF_CORPORATE_HOST ;;
    external) short_name=external-ie-oa; full_host=$CF_EXTERNAL_HOST ;;
    *) echo 'STOP: unsupported DNS label.' >&2; exit 1 ;;
  esac
  if jq -e '.result | length == 0' "$CF_RUN_DIR/$label-dns.json" >/dev/null; then
    curl --silent --show-error --fail-with-body -X POST \
      -H "Authorization: Bearer $CF_DEPLOY_TOKEN" -H 'Content-Type: application/json' \
      --data "{\"type\":\"A\",\"name\":\"$short_name\",\"content\":\"$CF_WORKER_PLACEHOLDER_IP\",\"proxied\":true}" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" >"$CF_RUN_DIR/$label-dns-create.json"
  fi
  cf_get "$label-dns-verify" "/zones/$CF_ZONE_ID/dns_records?name=$full_host"
  jq -e --arg host "$full_host" '.result | length == 1 and .[0].name == $host and .[0].proxied == true' \
    "$CF_RUN_DIR/$label-dns-verify.json" >/dev/null || {
      echo "STOP: $label DNS is not exactly one proxied record." >&2
      exit 1
    }
  jq -r '.result[0] | [.id, .name, (.proxied|tostring)] | @tsv' "$CF_RUN_DIR/$label-dns-verify.json"
}

create_new_dns_if_absent corporate
create_new_dns_if_absent external
```

每个 POST 后对该完整 hostname 重做 GET，确认 `proxied: true` 和记录 ID。

### 2.2 企业入口 Access App A

更新现有企业 App，使其主 `domain` 为 `ie-oa.lancloudtech.com`，并明确保留 destinations：

```json
[
  { "type": "public", "uri": "ie-oa.lancloudtech.com" },
  { "type": "public", "uri": "ie_oa.lancloudtech.com" }
]
```

保留当前企业认可 IdP、session/cookie/visibility 等已读出的字段。App PUT 的完整 payload 必须包含服务器返回并适用的 `name`、`domain`、`type`、`destinations`、`session_duration`、`app_launcher_visible`、`auto_redirect_to_identity`、`eager_redirect_cookie_setting`、`enable_binding_cookie`、`http_only_cookie_attribute`、`options_preflight_bypass`、`tags`、`policies` 和 `allowed_idps`。不要把外部 App 的登录方式混入此 App。

在权限受限的临时文件中由“刚刚 GET 的完整对象”制作 PUT payload，再执行 PUT；不要复用旧文档的最小 JSON，也不要把该临时文件放进仓库：

```sh
curl --silent --show-error --fail-with-body -X PUT \
  -H "Authorization: Bearer $CF_DEPLOY_TOKEN" -H 'Content-Type: application/json' \
  --data @/private/path/corporate-access-app-complete.json \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$CF_CORPORATE_APP_ID" \
  >"$CF_RUN_DIR/corporate-app-put.json"
cf_get corporate-app-verify "/accounts/$CF_ACCOUNT_ID/access/apps/$CF_CORPORATE_APP_ID"
jq -r '.result | [.id, .domain, (.aud // null)] | @tsv' "$CF_RUN_DIR/corporate-app-verify.json"
jq -e --arg corporate "$CF_CORPORATE_HOST" --arg legacy "$CF_LEGACY_HOST" '
  .result.domain == $corporate and
  (.result.destinations | any(.type == "public" and .uri == $corporate)) and
  (.result.destinations | any(.type == "public" and .uri == $legacy))
' "$CF_RUN_DIR/corporate-app-verify.json" >/dev/null || {
  echo 'STOP: corporate App no longer protects both corporate and legacy hosts.' >&2
  exit 1
}
```

企业 App 的最终有效 policy 集合必须只有一个授予入口的 Allow policy，其 include **精确且仅**为下列规则：

```json
[{ "email_domain": { "domain": "lancloudtech.com" } }]
```

它不是 `everyone`、单个邮箱清单或相似域匹配。先在受限临时响应中逐个审计 policy 的 `decision` 和 selector 形状。安全的 Block policy 可以保留，但也必须检查其不会因 precedence 意外阻断企业成员；任何第二个 Allow、任何 Bypass/Service Auth/Everyone 或其他可授予入口的 policy 都是部署停止条件。不得笼统删除“多余 policy”：先记录精确 policy ID 和其作用，取得负责人的明确确认后，才以读后写方式删除或重配那一条特定 policy，再重新 GET 完整 policy 列表。

```sh
verify_corporate_policy_set() {
  # This prints no selectors/emails. It accepts only the exact Allow plus safe Block/Deny policies.
  jq -e '
  .result as $policies |
  ([ $policies[] | select((.decision | ascii_downcase) == "allow") ]) as $allows |
  ($allows | length == 1) and
  ($allows[0].include == [{"email_domain":{"domain":"lancloudtech.com"}}]) and
  ([ $policies[] |
     select((.decision | ascii_downcase) as $d | $d != "allow" and $d != "deny")
   ] | length == 0)
' "$1" >/dev/null
}

verify_corporate_policy_set "$CF_RUN_DIR/corporate-policies.json" || {
  echo 'STOP: corporate policy set is not exactly one email-domain Allow, or contains another grant policy.' >&2
  exit 1
}

# Block/Deny policies may remain; inspect their ID/decision/precedence without printing selectors.
jq -r '.result[] | select((.decision | ascii_downcase) == "deny") | [.id, .decision, .precedence] | @tsv' \
  "$CF_RUN_DIR/corporate-policies.json"
```

在通过以上门禁后，才以列表响应中的唯一 Allow policy ID 制作只含该 include 规则的 policy payload 并 PUT。PUT 后必须重新 GET policy 列表并重新执行上述门禁：

```sh
CF_CORPORATE_POLICY_ID='<existing-corporate-policy-id>'
curl --silent --show-error --fail-with-body -X PUT \
  -H "Authorization: Bearer $CF_DEPLOY_TOKEN" -H 'Content-Type: application/json' \
  --data @/private/path/corporate-email-domain-policy.json \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$CF_CORPORATE_APP_ID/policies/$CF_CORPORATE_POLICY_ID" \
  >"$CF_RUN_DIR/corporate-policy-put.json"
cf_get corporate-policies-verify "/accounts/$CF_ACCOUNT_ID/access/apps/$CF_CORPORATE_APP_ID/policies"
verify_corporate_policy_set "$CF_RUN_DIR/corporate-policies-verify.json" || {
  echo 'STOP: corporate policy update did not leave the exact allowed policy set.' >&2
  exit 1
}
```

确认主 domain、两个 destinations、允许 IdP，以及有效 policy 集合仍只有唯一允许规则 `email_domain: lancloudtech.com`；已保留的 Block policy 仅作为明确审计过的限制规则存在。

### 2.3 外部入口 Access App B

创建 `external-ie-oa.lancloudtech.com` 的独立 self-hosted Access App。其 `allowed_idps` 只能包含步骤 1 读取的 Cloudflare 与 GitHub IdP ID；不包含 Email OTP 或其他 IdP。`auto_redirect_to_identity` 保持 `false`，使用户可选择登录方式。

为该 App 创建一个 Allow policy，include 必须且只能有两个 selector：

```json
[
  { "login_method": { "id": "<cloudflare-idp-id>" } },
  { "login_method": { "id": "<github-idp-id>" } }
]
```

禁止 `everyone`、`email_domain`、Email OTP、bypass 和额外 include selector。创建后 GET App/policy，逐项确认 domain、`allowed_idps` 正好为两项，且 policy 只含上面的两个 `login_method` selector。将两个 App 的 Access AUD 从 GET 响应安全地输入 Worker secret，不写进仓库。

创建外部 App 和 policy 时，同样先把非敏感 JSON payload 放在受限临时路径，调用 API 后立即记录返回的 ID 并 GET 回验；不得使用含 `everyone` 的临时规则来让 hostname 先可访问：

```sh
curl --silent --show-error --fail-with-body -X POST \
  -H "Authorization: Bearer $CF_DEPLOY_TOKEN" -H 'Content-Type: application/json' \
  --data @/private/path/external-access-app.json \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
  >"$CF_RUN_DIR/external-app-create.json"

# 从上一条响应读取新 App ID，只在当前受限 shell 保存，再创建该 App 的 policy。
CF_EXTERNAL_APP_ID="$(jq -er '.result.id' "$CF_RUN_DIR/external-app-create.json")"
curl --silent --show-error --fail-with-body -X POST \
  -H "Authorization: Bearer $CF_DEPLOY_TOKEN" -H 'Content-Type: application/json' \
  --data @/private/path/external-access-policy.json \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$CF_EXTERNAL_APP_ID/policies" \
  >"$CF_RUN_DIR/external-policy-create.json"

cf_get external-app-verify "/accounts/$CF_ACCOUNT_ID/access/apps/$CF_EXTERNAL_APP_ID"
cf_get external-policies-verify "/accounts/$CF_ACCOUNT_ID/access/apps/$CF_EXTERNAL_APP_ID/policies"
jq -r '.result | [.id, .domain, (.aud // null)] | @tsv' "$CF_RUN_DIR/external-app-verify.json"
jq -r '.result[] | [.id, .decision, .precedence] | @tsv' "$CF_RUN_DIR/external-policies-verify.json"
# External policy must be exactly one Allow using only the two expected IdPs.
jq -e --arg cf "$CF_CLOUDFLARE_IDP_ID" --arg gh "$CF_GITHUB_IDP_ID" '
  .result as $policies |
  ([ $policies[] | select((.decision | ascii_downcase) == "allow") ]) as $allows |
  ($allows | length == 1) and
  ($allows[0].include | length == 2) and
  (([ $allows[0].include[] | .login_method.id ] | sort) == ([$cf, $gh] | sort)) and
  ([ $policies[] | select((.decision | ascii_downcase) != "allow") ] | length == 0)
' "$CF_RUN_DIR/external-policies-verify.json" >/dev/null || {
  echo 'STOP: external App policy is not exactly the Cloudflare and GitHub login-method Allow.' >&2
  exit 1
}
```

## 3. 数据库、Worker 与 Secrets

在两个 Access App/policy 已经 GET 回验通过后，执行 remote D1 migration；migration 是追加式，不能用删除/重建 D1 作为部署方式。

```sh
cd /Users/i/myCode/LAN_Cloud_Internal_Expense/app
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js d1 migrations apply lan-cloud-expense --remote
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js d1 migrations list lan-cloud-expense --remote
```

用交互式 secret 输入设置以下值。不要使用 `--value`、shell history 文件或任何会回显内容的重定向；迁移管理员邮箱仅由操作人交互输入：

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret put ACCESS_AUD_CORPORATE
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret put ACCESS_AUD_EXTERNAL
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret put ACCESS_ISSUER
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret put ACCESS_JWKS_URL
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret put MIGRATION_SYSTEM_ADMIN_EMAIL
```

随后部署配置中的三条普通 Worker route（不包含 Custom Domain）：

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js deploy
```

部署后 GET Worker route 列表，确认仅本系统相关的三条普通 route patterns 指向 `lan-cloud-internal-expense`：`ie-oa.lancloudtech.com/*`、`external-ie-oa.lancloudtech.com/*` 和临时 `ie_oa.lancloudtech.com/*`。外部入口不得显示为 Workers Custom Domain；也重新 GET 两个 Access App 与 policy，并检查上一条 remote migration list 已列出新增 migration；任一个不一致时停止浏览器验收。Secret 值不可读取回验，只确认 Wrangler 命令成功且不输出值。

## 4. 上线验证与验收

### 4.1 边缘与配置检查

```sh
curl -I https://ie-oa.lancloudtech.com/
curl -I https://external-ie-oa.lancloudtech.com/
curl -I https://ie_oa.lancloudtech.com/
```

预期三者均到达 Cloudflare Access challenge，而不是占位源站或直接 origin 响应。确认下列事实后才宣告成功：

- 企业 App domain 为 `ie-oa.lancloudtech.com`，policy 为 `email_domain lancloudtech.com`。
- 外部 App domain 为 `external-ie-oa.lancloudtech.com`，policy 只含 Cloudflare 与 GitHub 的两个 `login_method` selector。
- Worker routes 包含 `ie-oa`、`external-ie-oa` 和临时 `ie_oa` 三条普通 route；外部入口由 Universal SSL 覆盖而非 Custom Domain/ACM。
- Worker 已安全设置 `ACCESS_AUD_CORPORATE`、`ACCESS_AUD_EXTERNAL`、`ACCESS_ISSUER`、`ACCESS_JWKS_URL`。

### 4.2 真实浏览器验收

在现有已登录浏览器中，按以下顺序记录不含凭据的结果：

1. 企业邮箱登录企业入口；确认自动创建 active 用户、默认 `employee`，指定迁移管理员额外拥有 `system_admin`。
2. 确认普通 employee 仅能读取自己拥有的订阅/账号资产，无法加载全局财务、用户、附件、汇率、导入或审计数据。
3. 从企业个人设置生成绑定码；用未绑定的 Cloudflare 身份访问外部入口，只能见到代码表单，不能见到业务数据。
4. 回到企业入口确认绑定；外部入口重新登录后 `/api/session` 返回与企业入口相同的 user id。分别验证 Cloudflare 与 GitHub 的绑定路径。
5. 撤销一个外部身份；用该身份的下一次外部 API 请求必须立即不再获得 Principal/业务访问。
6. 访问旧 host，确认 GET/HEAD 安全迁移到新企业入口，写请求得到迁移拒绝；用两个新 host 分别验证跨入口 Origin 规则。

## 5. 清理、回滚与执行记录

仅当浏览器已确认指定企业管理员具有 `system_admin` 后，才执行：

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret delete MIGRATION_SYSTEM_ADMIN_EMAIL
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret delete BOOTSTRAP_ADMIN_SUBJECT
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js secret delete BOOTSTRAP_ADMIN_EMAIL
```

同时移除任一精确邮箱的遗留 Access policy。若尚未达到上述管理员验收，禁止删除迁移 secret。

若在清理前需要回滚：恢复上一 Worker version，保留旧企业 App destination/policy，不删除或回滚远端 D1 migration（新表是追加式，安全保留），并保持新 host 不承接业务流量。若发生 Access 配置错误，优先恢复已读取的完整 App/policy payload；不要以临时 `everyone` 或 bypass 策略作为修复方式。

执行完成后，在本节只记录非敏感证据：日期、部署 Worker version、Access App/Policy ID、D1 migration 状态、三 host 的 HTTP 状态及浏览器验收结论。不得记录 Token、secret 值、Access JWT、绑定码、完整外部邮箱或迁移管理员邮箱。

| 项目 | 结果（执行后填写） |
| --- | --- |
| 日期 / Worker version | 2026-07-22 / `a7f0e56c-a8a7-4bc4-b8e4-bd68809e1c21` |
| Corporate / External Access App 与 policy ID | 企业入口保持既有已验证配置；新外部入口已创建并回验为仅 Cloudflare、GitHub 两个登录方法（标识符保留在私有部署证据中） |
| D1 migration 状态 | remote 已执行至 `0007_drop_vendors.sql`（执行前确认 vendors 表与 vendor_id 引用均为空）；无待执行项 |
| 三 host Access 边缘检查 | `ie-oa`、`external-ie-oa`、`ie_oa` 均为 TLS 校验通过且 Access `302` |
| 本次变更内容 | 飞书正式导入 apply（预览→审批→受控导入）、页面登出入口、供应商维度移除（账本列与表单）、关联字段下拉选择 |
| 企业开通、绑定、撤销与 employee 隔离 | 待指定企业管理员完成真实浏览器登录与绑定/撤销验收；在此之前保留迁移管理员 secret |
| 外部入口退役（2026-07-23） | 系统改为仅企业 OTP 登录：Worker 外部路由与绑定体系已下线（版本 `cbcff839`），迁移 `0011` 已删身份链接交易与外部绑定身份。待控制台手工收尾：删除 external-ie-oa 的 Access 应用与 DNS 记录；企业应用 IdP 只保留 One-time PIN；session duration 设为 720h（30 天） |
| 企业 Access 应用误删恢复（2026-07-23） | 已通过 API 重建企业应用（id `54d008f7-a2fe-431a-ba01-03b025860ebd`）：目的地 ie-oa + ie_oa、仅 One-time PIN IdP、session 720h、`email_domain lancloudtech.com` 唯一 Allow policy；新 AUD 已写入 `ACCESS_AUD_CORPORATE` secret，双域名 302 挑战已回验恢复 |
