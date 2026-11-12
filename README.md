# 兰芯云朵行政 · 订阅资产与报销系统

> A lightweight, serverless system for subscription assets, payer-based reimbursements, FX snapshots, and enterprise access control.

兰芯云朵行政是一套独立部署的内部订阅资产与报销管理系统。它以 Cloudflare Workers、D1、R2 和 OnePass 为基础，不需要自建服务器；飞书多维表格可以作为只读导入来源，但不会成为业务账本，也不会被本系统回写。

## 为什么使用它

- **管理订阅资产**：统一记录供应商、订阅、版本化条款、续费周期、付款者和状态。
- **管理账号资产**：统一记录显示名称、固定且可筛选的资产标识、账号标识和归属人员；仅 `system_admin` 与 `asset_admin` 可创建、编辑或永久删除。
- **按付款者一键报销**：批量选择候选费用后，系统按付款者自动拆分报销批次。
- **保留财务可追溯性**：金额以最小货币单位存储；候选费用会锁定原币金额、汇率快照和 CNY 金额。
- **自动计算报销周期**：从连续已付款覆盖区间推导上次已报销日期，避免重复报销或跨越未报销缺口。
- **身份与权限**：OnePass 管理组织身份、应用访问、成员和业务角色。
- **安全导入飞书数据**：飞书 Base 仅作为受控、可审计的只读来源，导入前先进行字段映射预览。

## 架构

```text
Browser
  │
  ├─ OnePass：登录、组织身份、应用授权与业务角色
  │
  └─ Cloudflare Worker + Hono
       ├─ D1：业务账本、签名角色快照、导入血缘与审计
       ├─ R2：发票和报销凭证对象
       ├─ Cron：每日汇率同步
       └─ Feishu OpenAPI：仅 GET 读取 Base 来源数据
```

## 核心边界

| 范围 | 说明 |
| --- | --- |
| 账本 | D1 是独立业务账本；飞书是可选只读来源，不会回写。 |
| 金额 | 使用整数最小单位，避免浮点误差；历史候选不随日后价格或汇率重算。 |
| 报销 | 一次提交按付款者拆分批次；创建请求需要 `Idempotency-Key`。 |
| 身份 | 按 OnePass 组织成员 ID 明确绑定应用账号，不按邮箱自动合并既有账号。 |
| 凭据 | 不保存密码、OTP、MFA 恢复码、访问令牌、完整银行卡号或第三方报销平台密码。 |
| 附件 | 凭证对象存储在 R2；D1 仅保存受权限控制的元数据和对象引用。 |

## 仓库结构

```text
.
├── app/                    # Cloudflare Worker、D1 migration、测试与部署配置
│   ├── src/                # Worker、身份、账本、汇率、导入与 UI 实现
│   ├── migrations/         # 追加式 D1 schema migration
│   ├── test/               # Vitest 测试
│   └── README.md           # 详细技术参考
└── docs/
    ├── runbooks/           # 历史 Cloudflare Access 部署记录
    └── superpowers/        # 设计、实施计划与验证记录
```

## 快速开始

要求：Node.js 22+、npm，以及已安装并认证的 Wrangler（仅部署时需要）。

```bash
git clone https://github.com/LAN-Cloud-AI/LAN_Cloud_Internal_Expense.git
cd LAN_Cloud_Internal_Expense/app
npm ci
npm test
npm run typecheck
npm run db:migrations:local
npm run dev
```

账号资产的 `asset_identifier` 是固定字段：管理员可在新增或编辑时维护，并在账号资产清单中筛选。旧的动态追加字段功能已退役；本地开发请先执行上述 migration，再启动 Worker。生产环境也必须先完成 D1 migration，随后才部署 Worker。

> 不要提交 `.dev.vars`、`.wrangler`、构建产物、二维码、导出数据或任何 Access / Cloudflare / 飞书凭据。根目录 `.gitignore` 已覆盖这些本地文件。

## 部署到 Cloudflare

生产环境由一个 Worker 提供页面和 API，并使用 D1、R2、Cron 和 OnePass。部署前请阅读详细技术参考：

- [详细技术参考](app/README.md)

部署配置中只保留非敏感绑定和变量；以下内容必须通过 Cloudflare Workers Secrets 配置，绝不能写入仓库：

- OnePass 客户端密钥与签名接收密钥
- 飞书应用凭据与 Base 访问令牌
- 汇率服务 API Key（如使用的供应商要求）

## 安全模型

- Worker 对每次受保护请求校验 OnePass 会话、组织范围、应用授权和业务角色。完成角色切换后，角色须与 D1 签名快照一致。
- `employee` 默认只看本人被授权的订阅与账号资产。
- 不支持 Cloudflare Access 或其他外部身份直接登录；已有账号须经核实后绑定 OnePass，不能仅凭相同邮箱认领。
- 已付款的报销明细通过追加式冲销/调整保留历史，不允许硬删除或覆盖。
- 仅 `system_admin` 与 `asset_admin` 可永久删除账号资产；此操作不可恢复，会同时移除该资产对应的已弃用 `account_field_values`。审计仅保留安全元数据，不包含账号标识、归属人员、`vault_ref` 或任何凭据。

## 开发与贡献

欢迎通过 Issue 和 Pull Request 参与改进。提交前请至少运行：

```bash
cd app
npm test
npm run typecheck
npm run build
```

涉及权限、账本、身份、导入或部署的改动，请同时更新对应的测试与 `docs/` 中的设计/运行手册；不要把真实业务数据、Token、访问断言、绑定码或个人信息放入 Issue、提交信息或测试夹具。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
