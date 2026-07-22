# 双入口 Cloudflare Access 身份绑定与域名迁移设计

状态：用户已确认架构，待规格复核
日期：2026-07-22
范围：`兰芯云朵行政——订阅资产管理系统`

## 1. 目标与不可变规则

系统继续使用 Cloudflare Access，不新增应用内密码、Passkey、邮件发信或自建身份服务。

1. 任一 `@lancloudtech.com` 邮箱首次通过企业入口的 Cloudflare Access 验证后，自动创建正式、`active` 的 D1 用户，并自动授予 `employee` 角色。
2. `employee` 只拥有本人范围的业务可见性；系统管理员、资产管理员、财务审核人、付款者和审计员仍由管理员显式授予。
3. 企业主身份建立后，用户可在个人设置中绑定任意验证邮箱的 Cloudflare 身份或 GitHub 身份；外部邮箱不需要属于 `lancloudtech.com`。
4. 外部身份绝不因邮箱相同而自动合并。只有经过已登录企业主身份发起、短期一次性码证明、企业入口最终确认的身份才会绑定。
5. 主域名迁移至 `https://ie-oa.lancloudtech.com`，D1、R2、Worker 名称及现有业务数据不迁移、不重建。

## 2. 推荐架构：双入口、同一 Worker

```text
企业入口：ie-oa.lancloudtech.com
  Access App A：仅允许 @lancloudtech.com
  -> 验签企业 JWT
  -> 幂等自动创建 users + corporate_primary identity + employee role
  -> 个人设置、生成绑定码、确认/解绑外部身份

外部入口：external-ie-oa.lancloudtech.com
  Access App B：仅 Cloudflare 与 GitHub 登录方式，不按邮箱域限制
  -> 验签外部 JWT
  -> 未绑定时只显示绑定码页面
  -> 已绑定时解析到同一 users.id，进入同一业务系统

两入口 -> 同一 Cloudflare Worker -> 同一 D1 / R2
```

两个 Access App 使用独立 Audience（AUD）。Worker 依据请求 Host 选择对应的预期 AUD；来自企业入口的 JWT 不能在外部入口使用，反之亦然。两个入口都使用同一 Access organization 的 issuer 与 JWKs，但仍必须进行签名、issuer、expiry 和 host-specific AUD 校验。

### 选择此架构的原因

企业入口保留“仅企业邮箱”的 Access 边界。若将同一入口放宽至所有 Cloudflare/GitHub 用户，任何外部身份都能先到达业务站点，安全性会退化为只依赖 Worker 内部拦截。若使用同一 host 的路径级 Access App，则所有外部页面、API、附件和 CSRF origin 都需要前缀改造，复杂度显著更高。

外部入口允许任意 Cloudflare/GitHub 已验证邮箱到达 Worker，但只有 D1 中已经绑定的身份能读取业务数据或获得业务 Principal。未绑定身份只能执行绑定流程，不能看到用户、订阅、付款者、报销、附件或审计信息。

## 3. Access、域名和迁移配置

### 3.1 企业入口 App A

- Host：`ie-oa.lancloudtech.com`。
- Allow policy：`email_domain = lancloudtech.com`。
- 保留现有企业邮箱验证路径；Cloudflare 或 GitHub 登录只有在 Access 返回的已验证邮箱为 `@lancloudtech.com` 时才能首次自动开通。
- 现有 `ie_oa.lancloudtech.com` 作为 App A 的旧 destination 暂时保留，访问后仅做迁移提示/安全重定向；主入口和所有新生成链接都使用新域名。

### 3.2 外部入口 App B

- Host：`external-ie-oa.lancloudtech.com`。
- Allow policy：仅匹配 Cloudflare 与 GitHub 两个既有 Identity Provider 的 `login_method`，不使用 `Everyone`、Email OTP 或企业邮箱域规则。
- `auto_redirect_to_identity` 保持关闭，使用户能够选择 Cloudflare 或 GitHub。若浏览器复用错误的 Access 会话，页面提供 Access 登出后重试提示，不以客户端声称的 Provider 作为授权依据。

### 3.3 Worker 与 DNS

- 为新主域名和外部入口建立代理 DNS 记录与 Worker routes；两个 route 指向 `lan-cloud-internal-expense`。
- 将 `APP_ORIGIN` 替换为精确 origin allowlist：`https://ie-oa.lancloudtech.com` 与 `https://external-ie-oa.lancloudtech.com`。写请求只接受这两个值，不能放宽为任意子域。
- 新增 Workers secrets：`ACCESS_AUD_CORPORATE`、`ACCESS_AUD_EXTERNAL`。现有 issuer/JWKs secret 可复用；迁移完成后废弃单值 `ACCESS_AUD`。
- 旧域名保留 30 天作为受 Access 保护的 GET/HEAD 迁移入口，返回到新企业入口的安全重定向；旧域名的写请求返回明确迁移错误，不跨 host 重放 POST/PUT/PATCH/DELETE。

## 4. 身份数据模型与迁移

现有 `users.external_subject` 不再作为唯一解析源，但在迁移期保留以兼容既有数据。新增 migration：

```sql
CREATE TABLE user_access_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  verified_email TEXT,
  identity_kind TEXT NOT NULL
    CHECK (identity_kind IN ('corporate_primary', 'linked_external', 'legacy_primary')),
  provider_hint TEXT
    CHECK (provider_hint IN ('cloudflare', 'github') OR provider_hint IS NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT,
  UNIQUE (issuer, subject)
);

CREATE UNIQUE INDEX user_access_identities_one_active_corporate_primary
  ON user_access_identities(user_id)
  WHERE identity_kind = 'corporate_primary' AND revoked_at IS NULL;

CREATE TABLE identity_link_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  initiator_identity_id TEXT NOT NULL REFERENCES user_access_identities(id),
  secret_hash TEXT NOT NULL UNIQUE,
  candidate_issuer TEXT,
  candidate_subject TEXT,
  candidate_verified_email TEXT,
  candidate_provider_hint TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'candidate_presented', 'confirmed', 'cancelled', 'expired'
  )),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

迁移时，只有历史记录有可信 `@lancloudtech.com` 邮箱证据的 `users.external_subject` 才回填为 `corporate_primary` identity；其余记录回填为 `legacy_primary`。`legacy_primary` 不能自行发起新的外部绑定；管理员完成企业主身份恢复后才可解除该限制。业务身份解析改为按 `(issuer, subject, revoked_at IS NULL)` 查询 `user_access_identities`，返回关联的 `users.id` 和 D1 角色。`users.email` 只用于展示和联系，不能用于权限合并。

Cloudflare Access 的 `get-identity` 结果可用于保存可信 Provider 提示（Cloudflare/GitHub）以供 UI 展示；该提示不参与授权判断。真正的授权键始终是已验签的 `(issuer, subject)`。

企业入口只解析 `corporate_primary` identity；外部入口只解析 `linked_external` identity。若某 GitHub/Cloudflare 登录最终返回了与企业主身份完全相同的 subject，则它不是一个需要额外绑定的外部身份，用户继续从企业入口登录即可；不复制或双写同一个 subject。

## 5. 登录、自动开通与绑定流程

### 5.1 企业首次登录

1. 请求到达企业入口，Worker 验证 Access JWT 与企业入口 AUD。
2. Worker 将返回邮箱标准化为小写并严格校验其域为 `lancloudtech.com`；拒绝 `name@lancloudtech.com.example` 等相似域。
3. 若 `(issuer, subject)` 不存在，D1 事务创建 `users`（`active`）、`corporate_primary` identity 和 `employee` 角色，写入 `auto_provision_corporate_user` 审计事件。
4. 若 identity 已存在，更新 `last_seen_at`，不重复创建用户或角色。
5. 若同一 subject 已被绑定为外部身份或企业邮箱变更为不合规，不自动迁移、合并或提升权限，返回受控错误并要求管理员处理。

### 5.2 外部身份绑定

1. 用户从企业入口的“个人设置 → 登录身份”发起绑定，必须已经解析为 `corporate_primary` identity。
2. Worker 生成至少 128-bit 随机值，展示短期一次性绑定码；D1 只存 SHA-256 hash，TTL 为 10 分钟。
3. 用户访问外部入口并选择 Cloudflare 或 GitHub，Access 验证完成后提交绑定码。
4. Worker 验证外部入口 AUD；只将该 `(issuer, subject)` 和经过 Access 验证的候选邮箱记录在 binding transaction 中，不立即创建 identity 或授予业务访问。
5. 用户回到仍受企业入口保护的个人设置，查看掩码后的候选邮箱/Provider 并明确确认。
6. D1 事务验证绑定码未过期、未消费、候选 identity 未归属其他用户，然后创建/激活 `linked_external` identity，消费绑定码并写入审计事件。
7. 此后该外部身份登录外部入口时解析到同一个 `users.id`，继承相同角色和本人数据范围。

绑定码不出现在 URL、Referrer、日志或审计详情中；审计只记录 transaction id、user id、provider 提示和结果。重复使用、过期、碰撞、取消和已解绑身份都返回不泄漏归属信息的错误。

### 5.3 解绑与恢复

- 用户可撤销任一 `linked_external` identity；撤销后下一次请求即不再解析 Principal。
- `corporate_primary` 不能通过自助界面解绑。
- 企业主身份的 subject 改变、企业邮箱回收、已绑定外部身份冲突等情况走系统管理员离线恢复流程；管理员必须有审计理由，不能依据相同邮箱自动合并。

## 6. `employee` 默认权限与数据范围

`employee` 是正式业务成员，但不是全局数据读取角色。实现必须调整当前接口，确保：

- Dashboard 仅返回本人拥有的账号资产、本人负责的订阅等个人计数，不返回全公司待报销金额、审核数量、汇率异常或导入异常。
- 订阅与账号资产列表严格使用 `owner_user_id = principal.userId`；无本人归属数据时返回空集合。
- 不允许读取付款者、报销账号、报销候选、批次、附件、汇率、导入记录、用户列表或审计日志。
- 不允许创建/修改业务资产、角色、付款者、报销、汇率或飞书导入配置。
- 个人设置只允许查看/管理本人的外部登录身份，不能查询其他用户的身份或邮箱。

资产管理员、财务审核人、付款者、审计员和系统管理员的现有权限继续遵循 D1 角色及付款者归属范围；任何高权限角色都由系统管理员显式分配。

## 7. 首位系统管理员迁移

当前系统的既有管理员可能使用历史非企业邮箱身份；该身份不能在新企业入口策略下继续作为常规入口。为避免切换后没有管理员，部署前由系统所有者提供一个指定的 `@lancloudtech.com` 管理员邮箱。

- 部署时设置短期 Workers secret `MIGRATION_SYSTEM_ADMIN_EMAIL` 为该企业邮箱。
- 该邮箱首次在企业入口完成自动开通时，Worker 在同一 D1 事务内保留 `employee` 并额外授予一次 `system_admin`，写入 `migrate_system_administrator` 审计事件。
- 该迁移只能发生一次；成功后部署操作立即删除该 secret，并移除旧 `BOOTSTRAP_ADMIN_*` 逻辑与历史个人邮箱的 Access allow policy。
- 若指定邮箱已对应另一活跃企业身份、迁移已完成或邮件不匹配，操作失败且不改变角色。不得以相同邮箱或旧外部 subject 自动合并。

这不是企业员工的常规自动授权路径，只有部署前由系统所有者明确指定的一个企业邮箱可获得此一次性管理员迁移资格。

## 8. UI 与 API 边界

新增或调整：

- `GET /api/session`：返回当前入口类型、当前 Principal、企业主身份状态和已绑定外部身份的掩码状态。
- `POST /api/me/identities/link-transactions`：仅企业入口、已认证企业主身份；创建绑定交易并返回一次性码与外部入口地址。
- `POST /api/external/identity-presentations`：仅外部入口；提交绑定码，按其 hash 查找绑定交易并登记候选 identity，不向外部页面暴露 transaction id。
- `POST /api/me/identities/link-transactions/:id/confirm`：仅企业入口；最终确认绑定。
- `GET /api/me/identities`：仅当前用户，返回 identity 状态与掩码信息。
- `DELETE /api/me/identities/:id`：仅企业入口，只允许撤销自己的 `linked_external` identity。

个人设置页新增“登录身份”卡片：企业主身份固定显示、Cloudflare 与 GitHub 的绑定状态、绑定/解绑操作、外部入口地址和会话冲突提示。人员与权限页删除人工填写 Access subject 的创建流程，改为管理员管理已自动开通的 D1 用户及角色。

未绑定外部用户在外部入口只看到绑定码表单和隐私安全说明；企业入口的非企业邮箱永远在 Access 边缘被拒绝，Worker 不尝试自动开通。

## 9. 安全、审计与错误处理

- 所有身份 JWT 先验签，再读取任何身份/角色数据；不信任 header、浏览器提交的邮箱、Provider 或 subject。
- 绑定交易使用高熵单次 secret、哈希存储、10 分钟 TTL、用户级并发限制和失败限速。
- 使用 D1 条件更新/事务保证同一码不能双花，且一个 `(issuer, subject)` 不能同时关联两个用户。
- 所有自动开通、候选出现、确认、取消、解绑、恢复和拒绝事件写入现有审计表；详情不存明文 binding code 或完整外部邮箱。
- 跨入口的 Origin 防护使用精确 allowlist；旧 host 的写请求被拒绝，不采用保留 HTTP 方法的跨域重定向。
- Access App B 的放行仅提供到 Worker 的认证门槛，不等于业务授权；外部入口必须对所有非绑定 API 返回 401/403，页面不能嵌入任何业务数据。

## 10. 验收与测试

单元/集成测试至少覆盖：

1. 企业入口的正确 issuer/AUD、合规企业邮箱首次请求自动创建一个且仅一个 `active` 用户、企业主身份和 `employee` 角色。
2. 错误 AUD、错误 issuer、过期 JWT、相似域邮箱、非企业邮箱均无法自动开通。
3. `employee` 无法读取全局 dashboard、付款者、报销、附件、汇率、导入、人员或审计数据；只看到本人归属的订阅和账号资产。
4. 既有 `users.external_subject` 正确回填，迁移后仍能解析原用户。
5. 外部入口的未绑定身份不能读取业务数据，也不能创建企业用户或发起绑定。
6. 仅企业主身份可创建绑定交易；码过期、重放、错误码、碰撞、未确认、跨用户确认均失败。
7. 确认后，外部身份解析到同一 `users.id`；解绑后旧 JWT 立即失去 Principal。
8. 邮箱相同但 subject 不同永不自动合并；subject 已绑定其他用户时不泄漏归属。
9. 企业/外部 JWT 不能跨 host 使用；两个精确 origin 的合法写请求通过，任意其他 origin 被拒绝。
10. 新主域名可通过 Access 到达 Worker；旧域名仅安全引导到新域名；D1/R2 数据和现有业务接口保持可用。
11. 指定企业管理员仅能通过一次性迁移 secret 获得 `system_admin`；迁移成功后删除 secret，历史个人邮箱无法再经企业入口访问。

部署验证包括：远端 D1 migration、Worker 类型检查/测试、两个 Access App 的 IdP 与 policy 读取回验、两个 hostname 的 Access challenge、企业自动开通、外部绑定和解绑的真实浏览器验证。

## 11. 非目标

- 不创建或保存应用密码、Passkey、邮箱验证码、第三方 OAuth client secret、Cloudflare/GitHub 密码或 Token。
- 不在 Worker 中自动修改 Cloudflare Access policy 来逐个白名单外部邮箱。
- 不以 email 作为授权主键或恢复自动化依据。
- 不改变现有订阅、汇率、付款者和报销计算的业务规则，除为 `employee` 进行必要的数据范围收紧。
