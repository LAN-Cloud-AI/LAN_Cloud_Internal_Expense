# Task 6 — Production configuration and dual-entry runbook

状态：已完成补救，待独立复核；未执行任何 Cloudflare 远端变更。

## 变更文件

- `app/wrangler.jsonc`
  - `APP_ORIGINS` 固定为企业与外部入口两个精确 HTTPS origin。
  - 结合后续 Task 7 的已批准域名迁移，当前 routes 固定为 `ie-oa`、`external-ie-oa` 与临时 `ie_oa` 三个 hostname。
  - 移除单值 `APP_ORIGIN` 与 bootstrap secret 注释；将双 AUD、issuer、JWKs 与一次性管理员迁移值记录为 Workers Secrets。
- `docs/runbooks/cloudflare-access-dual-entry.md`
  - 新增无密钥泄露的 Access/DNS/D1/Worker staged deployment、GET 回验、浏览器验收、清理与回滚流程。
  - 仅记录账户、zone、Worker、D1、R2 等非敏感资源常量；没有 Token、Access JWT、绑定码或管理员邮箱。
  - 补救：所有 Access/DNS/organization 原始 API 响应均写入 `umask 077` 的临时目录，终端只输出经筛选的 ID/hostname/状态；退出时清理临时目录。
  - 补救：增加 Cloudflare IdP 的“任意外部账号可登录”人工预检门禁；若是账户成员限制或无法确认，明确停止并要求有 IdP 权限的操作人变更配置。
  - 补救：增加旧入口 DNS/企业 Access destination 门禁；旧 host 必须已存在、代理且受企业 App 保护，流程绝不自动创建它。
  - 补救：企业 policy 审计门禁要求唯一精确的企业域 Allow；只容许已审计的 Block/Deny，任何 Bypass、Service Auth、Everyone 或其他 grant 形状都停止，且不进行笼统删除。
- `app/README.md`
  - 删除旧单入口、bootstrap 初始化及“已经上线”的不准确叙述，改为待执行的双入口身份模型与 runbook 链接。

## 验证

在 `app/` 目录执行：

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir dist
```

结果：Vitest 13 个文件、101 项测试均通过；TypeScript exit 0；dry-run 完成 bundle，未发布 Worker。已用不输出匹配内容的本地扫描确认指定管理员本地部分不再出现在仓库；测试和历史设计示例改用通用企业示例地址。

## 约束与快照

- 未调用 Cloudflare API、未部署、未运行 remote migration，也未读取或打印任何 secret。
- 初始审阅快照：`/tmp/lan-expense-task6-before.xha6da`；本次补救前快照：`/tmp/lan-expense-task6-fix1-before.vhUdQd`。
