# 兰芯云朵行政——订阅资产管理系统

一个独立部署的轻量化订阅资产与报销系统：Cloudflare Workers 提供页面和 API，D1 保存独立账本，R2 保存凭证对象，Cron 驱动定时汇率同步，Cloudflare Access 负责入口认证。它不需要自建服务器，也不会向现有飞书多维表格回写任何数据。

系统计划由同一 Cloudflare Worker 提供两个受 Access 保护的入口：企业入口 [https://ie-oa.lancloudtech.com](https://ie-oa.lancloudtech.com) 与外部绑定入口 [https://external-ie-oa.lancloudtech.com](https://external-ie-oa.lancloudtech.com)。旧入口 `https://ie_oa.lancloudtech.com` 仅作临时安全迁移。当前仓库是待上线配置与实现，不以本文宣称已完成生产部署；凭据仅存在于 Cloudflare Workers Secrets，绝不写入仓库。

## 业务边界

系统覆盖以下工作流：

1. 记录内部人员的账号资产，并允许管理员追加非财务关键字段。
2. 管理订阅、供应商、订阅条款、付款者及报销系统账号（均支持有效期与状态）。
3. 按实际账单或按天摊销生成报销候选，锁定原币金额、汇率和 CNY 分金额。
4. 批量勾选候选费用后，一次提交自动按**付款者**拆成一个或多个报销批次。
5. 从已付款明细的连续覆盖区间推导上次已报销日期；中间有缺口时，不能用未来已付款项目越过缺口。
6. 记录汇率来源、抓取时间、快照状态和导入/审批/付款等审计轨迹。
7. 使用 Cloudflare Access + D1 角色授权，而不是让前端页面自行决定权限。

不在本系统保存密码、OTP、MFA 恢复码、飞书用户 Token、完整银行卡号或报销平台登录凭据。报销系统账号只保存别名、脱敏标识和可选的外部凭据库引用（`vault_ref`）。

## 现有飞书数据基线与只读映射

当前被参考的飞书多维表格是“兰芯云朵资产管理”。系统将其视为**只读导入来源**，而非新的业务主库；导入成功后 D1 是独立系统的唯一业务账本。

已核对的原始表结构：

| 原表 | 当前数据量 | 已识别字段 | 目标用途 |
| --- | ---: | --- | --- |
| `人员账号、邮箱管理` | 3 条 | `账号资产 ID`、`人员`、`个人私有邮箱`、`手机号`、`leadsHunter 用户名`、`github 邮箱账号`、`github_ID`、`兰芯域名邮箱` | 人员匹配候选、账号资产、可追加账号字段；邮箱/手机号不能直接作为生产登录身份 |
| `资产订阅` | 22 条 | `订阅 ID`、`订阅者`、`订阅开始日期`、`发票（可选）`、`备注`、`订阅项目名称`、`付款者`、`订阅周期`、`是否自动续费`、`付款方式`、`订阅币种`、`订阅总价（不换算与币种保持一致）` | 供应商/订阅、条款版本、付款者分配、附件引用与审计元数据 |

导入不是“按列盲拷贝”，而是下列受控流程：

```text
飞书 Base（只读）
  -> 字段 ID / 表 ID 映射预览
  -> source_import_runs + source_records（血缘与差异）
  -> 管理员确认映射版本
  -> D1 业务表（独立账本）
```

首期映射原则：

- `订阅项目名称`、`订阅开始日期`、`订阅周期`、`订阅币种`、`订阅总价`进入订阅及其条款版本；后续改价必须新建条款版本，不能覆盖历史候选。
- `付款者`进入付款者及其有效期分配；报销批次始终只属于一个付款者。
- `订阅者`用于关联人员，但外部登录身份必须在 Access 登录后由管理员以稳定 `subject` 绑定，不能仅靠姓名或邮箱自动授权。
- `付款方式`仅保存为脱敏说明；不会导入卡号或支付平台凭据。
- `是否自动续费`、`备注`、来源附件等先保留为来源元数据/审计信息，确认业务字段定义后再提升为可检索的正式属性。
- `发票（可选）`只保存附件元数据和 R2 对象引用；文件本体不进入 D1，更不会回写飞书。
- 人员表中的 GitHub、LeadsHunter、域名邮箱等账号可映射为 `account_assets` 与 `account_field_definitions`；“追加字段”仅适合非财务关键属性。

导入应用前必须先跑预览。字段名或字段类型发生漂移、人员匹配不唯一、币种/金额不合法时，系统写入映射错误并停止该记录的提升，而不是猜测或覆盖账本。

## 架构

```text
浏览器
  -> Cloudflare Access（认证）
  -> Worker + Hono（服务端页面、API、权限检查）
       -> D1（独立业务账本、导入血缘、审计）
       -> R2（发票/凭证对象，D1 只保存对象键）
       -> Cron（每日汇率同步任务）
       -> 飞书开放接口（仅 GET 读取 Base）
```

页面由 `src/ui.ts` 直接随 Worker 返回，不依赖一个单独的 Node 服务、前端服务器或 CDN 构建产物。前端只是操作界面；所有角色校验、金额计算、幂等和账本写入都必须由 API 在 Worker 内完成。

### D1 账本模型

`migrations/0001_initial.sql` 建立的主要边界：

- `users`、`roles`、`user_roles`：登录主体与业务角色。
- `vendors`、`subscriptions`、`subscription_term_versions`：订阅主数据及不可重叠的价格/周期版本。
- `payers`、`payer_assignments`、`reimbursement_accounts`：付款者、订阅付款者有效期和脱敏报销平台账号。
- `account_assets`、`account_field_definitions`、`account_field_values`：账号资产和可追加字段。
- `fx_quotes`：以正整数有理数保存汇率快照，定义为“1 原币最小单位 = `numerator / denominator` CNY 分”。
- `reimbursement_candidates`、`reimbursement_submissions`、`reimbursement_batches`、`reimbursement_items`：候选、一次提交、按付款者拆分的批次、锁定明细。
- `source_*`、`sync_runs`、`audit_events`、`attachments`：飞书来源血缘、任务结果、审计和 R2 文件引用。

财务约束：

- 金额一律存为最小货币单位 `INTEGER`，不得用浮点数；CNY 使用分，USD 使用美分。
- 候选生成时复制原币金额、汇率分子/分母、CNY 分金额与覆盖期间。历史候选不随日后改价或改汇率重算。
- 同一候选只能有一条未冲销的报销明细；一次提交中同一付款者只生成一个批次。
- 已付款批次和明细由 D1 触发器保护，不能编辑或硬删；更正需通过冲销/调整留下新记录。
- 一键报销请求必须携带 `Idempotency-Key`。同一操作者、动作与 Key 返回同一结果，避免双击或网络重试重复建单。

### 角色与权限

| 角色 | 主要权限 |
| --- | --- |
| `system_admin` | 系统配置、用户与角色、来源连接 |
| `asset_admin` | 订阅、账号资产、字段定义与导入映射 |
| `finance_reviewer` | 报销审核、付款确认、汇率人工复核 |
| `payer` | 查看本人作为付款者的批次 |
| `employee` | 查看自己被授权的账号/订阅范围 |
| `auditor` | 只读查看审计、导入、汇率和报销记录 |

生产环境不接受浏览器自报身份：Worker 按 Host 校验 Cloudflare Access JWT 的签名、对应 `aud`、`iss` 与过期时间，再用稳定 `(issuer, sub)` 查询 D1 中的用户和角色。企业邮箱首次通过企业入口验证后自动创建 active 用户并授予 `employee`；开发环境的 `DEV_AUTH=1` 仅可用于本地测试，绝不能部署到生产。

## 轻量化部署配置（Cloudflare）

本系统采用同一 Worker/D1/R2 的双入口架构，详细且可复核的远端 Access、DNS、D1、Worker 部署、验收和回滚顺序见 [Cloudflare Access 双入口上线手册](../docs/runbooks/cloudflare-access-dual-entry.md)。执行前不得假设资源已存在或生产已上线。

外部绑定入口使用一级子域 `external-ie-oa.lancloudtech.com`，可由 Cloudflare Universal SSL 覆盖。因此它和企业/旧入口一样采用普通 proxied DNS 与 Worker route；本方案不使用 Workers Custom Domain，也不购买 Advanced Certificate Manager (ACM) 或其他付费证书。

### Access 与身份模型

- 企业入口仅允许 `@lancloudtech.com` 邮箱通过 Access；首次验证后 Worker 自动开通 active 用户并授予默认 `employee`。
- 外部入口仅允许 Cloudflare 和 GitHub Access 登录方式到达 Worker。外部身份并不自动获得业务授权，必须由已登录的企业主身份发起、外部入口提交一次性码、再回企业入口明确确认后才能绑定。
- 系统永远用已验签的 `(issuer, subject)` 作为身份键，不按相同邮箱自动合并。外部入口的未绑定身份只能看到绑定码页面，不能读取业务数据。
- `employee` 只看到本人拥有的订阅和账号资产；全局财务、人员、附件、汇率、导入与审计数据仍需要显式业务角色。
- `ACCESS_AUD_CORPORATE`、`ACCESS_AUD_EXTERNAL`、`ACCESS_ISSUER`、`ACCESS_JWKS_URL` 和一次性 `MIGRATION_SYSTEM_ADMIN_EMAIL` 均为 Workers Secrets，不属于 `wrangler.jsonc` 的 vars。确认指定企业管理员已有 `system_admin` 后立即删除迁移 secret；遗留 `BOOTSTRAP_ADMIN_*` secret 也在此时清理。

飞书应用应只授予读取目标多维表格及其字段/记录所需的最小权限，并仅把原表共享给该应用。导入适配器必须拒绝除获取租户令牌外的一切非 `GET` 飞书数据请求；禁止使用飞书写记录、建表、改字段、改权限等接口。

## 页面与 API 约定

`src/ui.ts` 是无构建依赖的服务端页面壳。高权限角色可见总览、订阅资产、账号资产（可追加字段）、报销中心、汇率、人员与权限、导入与审计；只有 `employee` 的用户只可见本人范围的总览、订阅资产、账号资产与个人设置。它通过同源 API 读取/提交，不在浏览器端保存任何密钥。

页面默认使用以下 API 契约，后端仍必须自行进行认证、角色检查、输入校验和 D1 事务/批处理：

| 用途 | API |
| --- | --- |
| 总览 | `GET /api/dashboard` |
| 订阅 | `GET/POST /api/subscriptions`、`POST /api/subscriptions/:id/term-versions`、`POST /api/subscriptions/:id/payer-assignments` |
| 账号资产与追加字段 | `GET/POST /api/account-assets`、`GET/POST /api/account-field-definitions` |
| 报销 | `POST /api/reimbursements/generate-candidates`、`GET /api/reimbursements/candidates`、`POST /api/reimbursements/preview`、`POST /api/reimbursements/create-batches`、`GET /api/reimbursements/batches` |
| 汇率 | `GET/POST /api/fx-quotes`、`POST /api/exchange-rates/sync` |
| 人员与权限 | `GET/POST /api/users`、`PUT /api/users/:id/roles`、`GET /api/roles`、`GET/POST /api/payers`、`GET/POST /api/reimbursement-accounts` |
| 飞书导入、附件与审计 | `GET /api/imports`、`POST /api/imports/feishu/preview`、`POST /api/imports/feishu/schema-versions/:id/approve`、`POST/GET /api/attachments/...`、`GET /api/audit-events` |

接口未启用、用户没有角色或导入尚未配置时，页面显示安全的空状态/错误消息，不应把底层错误、密钥或原始飞书响应输出给浏览器。

## 无服务器边界与运维注意事项

- Worker、D1、R2、Cron 和 Access 均为 Cloudflare 托管能力，不需要租用 VM 或维护常驻进程。
- D1 适合本系统的结构化业务账本；附件走 R2，不能把二进制发票塞入 D1 行数据。
- Cron 是定时触发，不是实时行情系统；汇率服务不可用时必须保留失败记录并等待人工复核。
- R2 仅保存经权限校验的凭证对象。下载和上传 API 要验证实体归属和角色，不能把对象键作为公开 URL。
- Cloudflare Access 保护入口，D1 角色再做业务授权；二者缺一不可。
- 飞书是可同步的来源，不是当前独立系统的权限系统或最终账本。任何反向同步都不在本期范围内，需要单独设计、审计和授权。
- 报销系统账号管理只管理授权范围、别名、脱敏标识和凭据库引用；自动登录第三方报销平台不在范围内。

## 本地开发

```bash
cd /Users/i/myCode/LAN_Cloud_Internal_Expense/app
npm install
npm run db:migrations:local
npm run dev
```

开发数据库位于 Wrangler 的本地状态目录，不应当作生产数据。不要提交本地 `.dev.vars`、`.wrangler` 状态、导出的飞书数据或任何访问令牌。
