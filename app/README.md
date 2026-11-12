# 兰芯云朵行政——订阅资产管理系统

一个独立部署的轻量化订阅资产与报销系统。Cloudflare Workers 提供页面和 API，D1 保存独立账本，R2 保存凭证对象，Cron 驱动定时汇率同步，OnePass 负责身份认证、应用访问、成员和角色管理。

系统由单一企业入口 [https://ie-oa.lancloudtech.com](https://ie-oa.lancloudtech.com) 提供服务，仅支持 OnePass 登录；旧入口 `https://ie_oa.lancloudtech.com` 仅作临时安全迁移。当前仓库是待上线配置与实现，不以本文宣称已完成生产部署；凭据仅存在于 Cloudflare Workers Secrets，绝不写入仓库。

## 业务边界

系统覆盖以下工作流：

1. 记录内部人员的账号资产：显示名称、固定且可筛选的资产标识、账号标识与归属人员；仅 `system_admin` 与 `asset_admin` 可创建、编辑或永久删除。永久删除不可恢复，会先移除该资产的已弃用 `account_field_values`，再移除资产本身。
2. 管理订阅、订阅条款与付款者（均支持有效期与状态）。
3. 按实际账单或按天摊销生成报销候选，锁定原币金额、汇率和 CNY 分金额。
4. 批量勾选候选费用后，一次提交自动按**付款者**拆成一个或多个报销批次。
5. 从已付款明细的连续覆盖区间推导上次已报销日期；中间有缺口时，不能用未来已付款项目越过缺口。
6. 记录汇率来源、抓取时间、快照状态和审批/付款等审计轨迹。
7. 通过 OnePass 管理成员和业务角色。Worker 校验会话及签名同步状态后执行角色权限。

不在本系统保存密码、OTP、MFA 恢复码、外部用户 Token、完整银行卡号或报销平台登录凭据。

## 架构

```text
浏览器
  -> OnePass（登录、组织身份、应用授权与角色）
  -> Worker + Hono（服务端页面、API、权限检查）
       -> D1（独立业务账本、审计）
       -> R2（发票/凭证对象，D1 只保存对象键）
       -> Cron（每日汇率同步任务）
```

页面由 `src/ui.ts` 直接随 Worker 返回，不依赖一个单独的 Node 服务、前端服务器或 CDN 构建产物。前端只是操作界面；所有角色校验、金额计算、幂等和账本写入都必须由 API 在 Worker 内完成。

### D1 账本模型

当前 D1 账本模型由追加式 migration 演进；`asset_identifier` 由 `0015_account_asset_identifier.sql` 添加。主要边界：

- `users`：保留本地人员 ID，供资产、报销与审计引用。`roles`、`user_roles` 保存切换前的角色目录和分配记录。
- `onepass_local_accounts`、`onepass_grants`：OnePass 成员映射、应用授权和签名同步的角色快照。
- `subscriptions`、`subscription_term_versions`：订阅主数据及不可重叠的价格/周期版本。
- `payers`、`payer_assignments`：付款者与订阅付款者有效期。
- `account_assets`：显示名称、资产标识、账号标识与归属人员。
- `account_field_definitions`、`account_field_values`：保留的历史弃用表，不再提供创建或编辑功能。
- `fx_quotes`：以正整数有理数保存汇率快照，定义为“1 原币最小单位 = `numerator / denominator` CNY 分”。
- `reimbursement_candidates`、`reimbursement_submissions`、`reimbursement_batches`、`reimbursement_items`：候选、一次提交、按付款者拆分的批次、锁定明细。
- `sync_runs`、`audit_events`、`attachments`：汇率同步任务结果、审计和 R2 文件引用。

财务约束：

- 金额一律存为最小货币单位 `INTEGER`，不得用浮点数；CNY 使用分，USD 使用美分。
- 候选生成时复制原币金额、汇率分子/分母、CNY 分金额与覆盖期间。历史候选不随日后改价或改汇率重算。
- 同一候选只能有一条未冲销的报销明细；一次提交中同一付款者只生成一个批次。
- 已付款批次和明细由 D1 触发器保护，不能编辑或硬删；更正需通过冲销/调整留下新记录。
- 一键报销请求必须携带 `Idempotency-Key`。同一操作者、动作与 Key 返回同一结果，避免双击或网络重试重复建单。

### 角色与权限

| 角色 | 主要权限 |
| --- | --- |
| `system_admin` | IE-OA 系统配置、资产管理与财务审核 |
| `asset_admin` | 订阅与账号资产 |
| `finance_reviewer` | 报销审核、付款确认、汇率人工复核 |
| `payer` | 查看本人作为付款者的批次、访问授权范围内的报销附件 |
| `employee` | 查看自己被授权的账号/订阅范围 |
| `auditor` | 只读查看审计、汇率和报销记录 |

生产环境只接受 OnePass 的有效组织身份和应用授权。切换完成后，Worker 在每次受保护请求中实时检查 OnePass 会话及业务角色，并与 D1 的成员映射和签名角色快照核对。已停用的映射或本地账号不可访问。组织如启用了邮箱策略，成员须先在 OnePass 验证符合要求的邮箱。

### OnePass 接入

生产 Worker 必须配置 `ONEPASS_ENABLED=1`、`ONEPASS_ORIGIN`、`ONEPASS_CLIENT_ID`、`ONEPASS_REDIRECT_URI`、`ONEPASS_PRODUCT_CODE`、`ONEPASS_ENVIRONMENT`、`ONEPASS_INSTANCE_ID`、`ONEPASS_ORG_ID` 和 `ONEPASS_DELIVERY_KEY_ID`，并通过 Worker Secrets 配置 `ONEPASS_CLIENT_SECRET` 与 `ONEPASS_DELIVERY_SECRET`。未正确配置时认证失败关闭；`ONEPASS_LOGIN_MODE` 不能启用 Cloudflare Access 登录。

已有成员使用经核实的组织成员 ID 与系统用户 ID 建立稳定映射。同邮箱冲突需人工核对，新成员按 OnePass 的已验证邮箱同步合同创建本地账号。应用授权和业务角色均由 OnePass 管理，切换前的本地角色分配保留作历史记录。登出使用同源 POST 撤销 OnePass 应用会话。

部署前先备份 D1 并隔离恢复，核对账号映射、授权状态和 Worker 绑定。发布后验证匿名拒绝、签名接收端、已授权及未授权身份、邮箱策略和业务角色。旧 `ie_oa` 域仅将 GET/HEAD 重定向至正式域；写请求返回 410。发生故障时先恢复入口保护并使用已验证的兼容 Worker 版本，不得通过配置恢复 Cloudflare 登录，也不得以旧快照覆盖新增业务数据。

## 轻量化部署配置（Cloudflare）

本系统使用一个 Worker、D1、R2 和 Cron。部署与恢复应以已核验的 OnePass 接入配置、精确 Worker 版本及备份为准。原 [Cloudflare Access 双入口手册](../docs/runbooks/cloudflare-access-dual-entry.md) 仅供历史记录，不再作为登录或部署依据。

- OnePass 管理登录、组织身份、应用授权和业务角色。Worker 根据 OnePass 会话及 D1 签名快照校验订阅资产、报销和财务权限。
- 已有账号按稳定 ID 明确绑定，不凭相同邮箱自动合并；`employee` 默认只查看本人范围。
- 敏感配置只放在 Worker Secrets，不写入仓库或日志。

## 页面与 API 约定

`src/ui.ts` 是无构建依赖的服务端页面壳。高权限角色可见总览、订阅资产、账号资产、报销中心、财务总览和汇率。`system_admin` 与 `asset_admin` 可新增、编辑、永久删除和按资产标识筛选账号资产，`employee` 只读查看本人范围的账号资产。页面通过同源 API 读取和提交。

页面默认使用以下 API 契约，后端仍必须自行进行认证、角色检查、输入校验和 D1 事务/批处理：

| 用途 | API |
| --- | --- |
| 总览 | `GET /api/dashboard` |
| 订阅 | `GET/POST /api/subscriptions`、`POST /api/subscriptions/:id/term-versions`、`POST /api/subscriptions/:id/payer-assignments` |
| 账号资产 | `GET/POST /api/account-assets`、`PUT/DELETE /api/account-assets/:id` |
| 报销 | `POST /api/reimbursements/generate-candidates`、`GET /api/reimbursements/candidates`、`POST /api/reimbursements/preview`、`POST /api/reimbursements/create-batches`、`GET /api/reimbursements/batches` |
| 汇率 | `GET/POST /api/fx-quotes`、`POST /api/exchange-rates/sync` |
| 资产归属及付款者 | `GET /api/account-owners`、`GET /api/account-owners?active=1`、`GET/POST /api/payers` |
| 附件与审计 | `POST/GET /api/attachments/...`、`GET /api/audit-events` |

接口未启用或用户没有角色时，页面显示安全的空状态/错误消息，不把底层错误或密钥输出给浏览器。

账号资产的 `asset_identifier` 是固定字段，创建时必填、编辑时可更新，并用于账号资产清单的筛选和展示。动态追加字段功能已退役：`GET/POST /api/account-field-definitions` 与 `PUT /api/account-assets/:id/field-values` 固定返回 `410 Gone`；常规情况下历史表只读保留，既不读取、创建也不编辑。仅 `system_admin` 与 `asset_admin` 可永久删除账号资产：系统会先删除该资产的 `account_field_values`，再删除资产；`account_field_definitions` 会保留，且绝不会作为资产删除的一部分被删除。系统写入的审计事件不含账号标识、归属人员或 `vault_ref`；审计仅保留安全元数据，绝不记录凭据。此功能不需要新的 D1 migration，且当前仓库不以本文宣称已完成生产部署。

### 成员和角色切换至 OnePass

产品环境的角色目录由 IE-OA 定义。使用绑定目标环境的 OnePass MCP 调用 `onepass_set_application_role_catalog`，传入产品 `code` 和以下字段。组织超级管理员管理标记为 `privileged` 的角色。`employee` 为新开通成员的默认角色，显式空数组表示没有业务角色。

```json
{
  "roles": [
    { "code": "asset_admin", "name": "资产管理员", "privileged": true },
    { "code": "auditor", "name": "审计只读", "privileged": true },
    { "code": "employee", "name": "普通员工", "privileged": false },
    { "code": "finance_reviewer", "name": "财务审核员", "privileged": true },
    { "code": "payer", "name": "付款者", "privileged": true },
    { "code": "system_admin", "name": "系统管理员", "privileged": true }
  ],
  "default_roles": ["employee"],
  "max_roles": 6
}
```

1. 验证 D1 备份可恢复，应用迁移 `0020_onepass_application_roles.sql`，部署支持角色投递的 Worker，设置 `ONEPASS_MANAGED_MEMBER_ROLES=staging`。该阶段冻结旧成员写入，隐藏“人员与权限”，让 `/people` 跳转 OnePass，原本地角色在中心尚未投递相应角色时继续生效。
2. 在受控执行环境按组织绑定 ID 读取以下结果。将该组织的 OnePass active 和 pending 授权与本地结果核对，只导入同一绑定下的现有角色。仅对已确认待创建且没有旧账号的 `verified_email_v2` 授权显式填 `['employee']`。身份不明、角色冲突或范围变化时先核对授权，避免猜测账号映射。

   ```sql
   SELECT a.membership_id, g.application_user_id, r.code AS role_code
   FROM onepass_local_accounts a
   JOIN users u ON u.id = a.user_id
   LEFT JOIN onepass_grants g ON g.org_id = a.org_id AND g.membership_id = a.membership_id
   LEFT JOIN user_roles ur ON ur.user_id = u.id
   LEFT JOIN roles r ON r.id = ur.role_id
   WHERE a.org_id = ?1 AND a.enabled = 1 AND u.employment_status = 'active'
   ORDER BY a.membership_id, r.code;
   ```

   `?1` 是受信的 OnePass 组织 ID。每个成员合并为 `{ "membership_id": "…", "application_roles": ["…"] }`，空角色保留为 `[]`。仅将 OnePass 当前 active 或 pending 授权列入导入清单，迁移数据只通过受控管道传给 MCP。
3. 使用 `onepass_activate_organization_application_roles` 提交 `code`、`orgId` 和 `assignments`。核对当前有效成员均已确认签名同步、角色及映射一致。尚待邮箱验证的新成员在验证通过后由既有 v2 开户流程创建。完成验收后设 `ONEPASS_MANAGED_MEMBER_ROLES=1`，要求所有业务会话的 `membership.application_roles` 与 D1 已接收的签名成员事件角色一致。

两个切换模式下，旧 `/api/users`、`/api/users/*`、`/api/roles` 和 `/api/login-whitelist` 管理接口均返回 410。成员禁用或移除角色不会改写历史报销、资产归属和财务凭证。审批人选择使用已启用的成员映射和最近一次成功同步的财务审核角色。

启用 OnePass 角色管理后，恢复服务需使用仍支持签名角色校验的 Worker 制品。旧 Worker 会读取切换前的本地角色，重新启动旧制品可能恢复已撤销的权限。

## 无服务器边界与运维注意事项

- Worker、D1、R2 和 Cron 均为 Cloudflare 托管能力。
- D1 适合本系统的结构化业务账本；附件走 R2，不能把二进制发票塞入 D1 行数据。
- Cron 是定时触发，不是实时行情系统；汇率服务不可用时必须保留失败记录并等待人工复核。
- R2 仅保存经权限校验的凭证对象。下载和上传 API 要验证实体归属和角色，不能把对象键作为公开 URL。
- OnePass 验证组织身份、应用访问和业务角色，D1 保留业务账本与接收的角色快照。

## 本地开发

```bash
cd /Users/i/myCode/LAN_Cloud_Internal_Expense/app
npm ci
npm run db:migrations:local
npm run dev
```

开发数据库位于 Wrangler 的本地状态目录，不应当作生产数据。更新 schema 后，先执行 `npm run db:migrations:local` 再启动本地 Worker；生产环境必须先完成 D1 migration，随后才部署 Worker。不要提交本地 `.dev.vars`、`.wrangler` 状态或任何访问令牌。
