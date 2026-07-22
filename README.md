# 兰芯云朵行政 · 订阅资产与报销系统

> A lightweight, serverless system for subscription assets, payer-based reimbursements, FX snapshots, and enterprise access control.

兰芯云朵行政是一套独立部署的内部订阅资产与报销管理系统。它以 Cloudflare Workers、D1、R2 和 Access 为基础，不需要自建服务器；飞书多维表格可以作为只读导入来源，但不会成为业务账本，也不会被本系统回写。

## 为什么使用它

- **管理订阅资产**：统一记录供应商、订阅、版本化条款、续费周期、付款者和状态。
- **管理账号资产**：记录内部账号、许可证、服务账号和可扩展的非财务字段。
- **按付款者一键报销**：批量选择候选费用后，系统按付款者自动拆分报销批次。
- **保留财务可追溯性**：金额以最小货币单位存储；候选费用会锁定原币金额、汇率快照和 CNY 金额。
- **自动计算报销周期**：从连续已付款覆盖区间推导上次已报销日期，避免重复报销或跨越未报销缺口。
- **轻量化身份与权限**：Cloudflare Access 负责入口认证，D1 角色负责业务授权；企业用户可绑定经过明确确认的 Cloudflare 或 GitHub 外部登录方式。
- **安全导入飞书数据**：飞书 Base 仅作为受控、可审计的只读来源，导入前先进行字段映射预览。

## 架构

```text
Browser
  │
  ├─ Cloudflare Access
  │    ├─ 企业入口：企业邮箱首次验证后自动开通 employee
  │    └─ 外部入口：Cloudflare / GitHub 身份经企业主身份确认后绑定
  │
  └─ Cloudflare Worker + Hono
       ├─ D1：业务账本、角色、导入血缘与审计
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
| 身份 | 使用已验签的 `(issuer, subject)`，不按邮箱自动合并身份。 |
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
    ├── runbooks/           # Cloudflare Access 双入口部署与回滚手册
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
npm run dev
```

本地 D1 migration：

```bash
npm run db:migrations:local
```

> 不要提交 `.dev.vars`、`.wrangler`、构建产物、二维码、导出数据或任何 Access / Cloudflare / 飞书凭据。根目录 `.gitignore` 已覆盖这些本地文件。

## 部署到 Cloudflare

生产环境由一个 Worker 提供页面和 API，并使用 D1、R2、Cron 和 Cloudflare Access。部署前请阅读完整手册：

- [Cloudflare Access 双入口上线手册](docs/runbooks/cloudflare-access-dual-entry.md)
- [详细技术参考](app/README.md)
- [双入口身份绑定设计](docs/superpowers/specs/2026-07-22-dual-entry-access-identity-design.md)

部署配置中只保留非敏感绑定和变量；以下内容必须通过 Cloudflare Workers Secrets 配置，绝不能写入仓库：

- Access audience、issuer 与 JWKS 地址
- 飞书应用凭据与 Base 访问令牌
- 汇率服务 API Key（如使用的供应商要求）
- 一次性管理员迁移设置

## 安全模型

- Cloudflare Access 负责认证，Worker 在服务端验证 JWT 的签名、受众、签发方和过期时间。
- D1 角色控制业务数据范围；`employee` 默认只看本人被授权的订阅与账号资产。
- 外部 Cloudflare / GitHub 身份不能仅凭相同邮箱获得权限，必须由已登录企业主身份发起、提交短时绑定码并明确确认。
- 绑定码只保存散列值；不得出现在 URL、审计详情、日志或仓库中。
- 已付款的报销明细通过追加式冲销/调整保留历史，不允许硬删除或覆盖。

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
