# 账号资产永久删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为数据管理员提供不可恢复的账号资产删除能力，同时级联清理该资产的历史追加字段值，并保留不含敏感账号数据的审计记录。

**Architecture:** Worker 在已有账号资产路由旁增加受 DATA_ADMIN_ROLES 保护的 DELETE 路由。路由先读取最小安全快照，再将子表删除、父表删除和审计插入放进同一 D1 批处理。服务端 UI 仅在 canManageAccounts 分支中生成删除按钮和事件处理器，因此只读角色的 HTML 不含删除契约。

**Tech Stack:** Cloudflare Workers、Hono、D1/SQLite、TypeScript、Vitest、better-sqlite3、Wrangler。

## Global Constraints

- 删除是不可恢复的物理删除；不新增 deleted_at、回收站、恢复接口或数据库 migration。
- 仅 system_admin 与 asset_admin 能调用或看到删除能力；所有其他角色继续只读。
- 删除 account_assets 前必须删除同一 account_asset_id 的 account_field_values，以满足现有外键约束；不得删除 account_field_definitions。
- 成功审计固定为 delete_account_asset/account_asset，detail_json 只包含 display_name、asset_identifier、status；不得记录账号标识、归属人员、vault_ref 或任何凭据。
- 变更请求继续经过现有 Origin 防护；不存在资产必须返回 404 account_asset_not_found，且不创建审计。
- 在 app/ 目录运行 Node 命令。实现完成前不得自动推送 Git、执行远程 D1 写入或部署 Worker；这些动作均需要用户另外确认。

---

### Task 1: 以 API 测试实现原子永久删除与安全审计

**Files:**

- Modify: app/test/index-users-whitelist.test.ts
- Modify: app/src/index.ts: account asset routes after PUT /api/account-assets/:accountId

**Interfaces:**

- Consumes: DATA_ADMIN_ROLES、requireRoles()、account_assets、account_field_values、audit_events 和现有 Origin 防护。
- Produces: DELETE /api/account-assets/:accountId -> 200 { account_asset_id, deleted: true }；404 account_asset_not_found；安全的 delete_account_asset 审计事件。

- [ ] **Step 1: 写入会因缺少 DELETE 路由而失败的成功、权限与审计测试**

在 app/test/index-users-whitelist.test.ts 的 account asset editing describe 中新增测试。先在 import 中把 sqliteD1 改为：

~~~ts
import { sqliteD1, withD1StatementFailure } from './helpers/sqlite-d1';
~~~

新增永久删除成功测试，使用现有 setup()、adminSession() 和 mutate()；测试夹具只使用非生产的通用值：

~~~ts
it('permanently deletes an asset, its retired field values, and records only safe audit details', async () => {
  const { app, env, database } = setup();
  await adminSession(app, env, database);
  database.prepare(
    "INSERT INTO users (id, display_name) VALUES ('owner-delete', 'Delete Owner')",
  ).run();
  database.prepare(
    "INSERT INTO account_field_definitions (id, field_key, label, field_type) VALUES ('field-delete', 'legacy_text', 'Legacy text', 'text')",
  ).run();
  database.prepare(
    "INSERT INTO account_assets (id, owner_user_id, account_identifier_masked, display_name, asset_identifier, vault_ref, status) VALUES ('asset-delete', 'owner-delete', 'safe-delete-identifier', '待删除资产', 'Delete Service', 'vault/delete', 'retired')",
  ).run();
  database.prepare(
    "INSERT INTO account_field_values (account_asset_id, field_definition_id, value_text) VALUES ('asset-delete', 'field-delete', 'retired value')",
  ).run();

  const removed = await mutate(app, env, 'DELETE', '/api/account-assets/asset-delete');
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toEqual({ account_asset_id: 'asset-delete', deleted: true });
  expect(database.prepare("SELECT count(*) AS count FROM account_assets WHERE id = 'asset-delete'").get()).toEqual({ count: 0 });
  expect(database.prepare("SELECT count(*) AS count FROM account_field_values WHERE account_asset_id = 'asset-delete'").get()).toEqual({ count: 0 });

  const audit = database.prepare(
    "SELECT detail_json FROM audit_events WHERE action = 'delete_account_asset' AND entity_id = 'asset-delete'",
  ).get() as { detail_json: string };
  expect(JSON.parse(audit.detail_json)).toEqual({
    display_name: '待删除资产',
    asset_identifier: 'Delete Service',
    status: 'retired',
  });
  expect(audit.detail_json).not.toContain('safe-delete-identifier');
  expect(audit.detail_json).not.toContain('owner-delete');
  expect(audit.detail_json).not.toContain('vault/delete');

  const repeated = await mutate(app, env, 'DELETE', '/api/account-assets/asset-delete');
  expect(repeated.status).toBe(404);
  expect(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'delete_account_asset' AND entity_id = 'asset-delete'").get()).toEqual({ count: 1 });
});
~~~

同一 describe 再增加一个测试：先把当前用户从 role-system-admin 切换为 role-asset-admin，断言可以删除另一条资产；仍处于 role-asset-admin 时，对第三条资产用不带 Origin 的 request() 调用 DELETE，断言为 403 且资产仍存在；最后切换为 role-employee，断言 DELETE 返回 403 且资产仍存在。

再增加批处理回滚测试：创建带 account_field_values 的资产后，将 env.DB 替换为下列包装器，再 DELETE。断言返回 500/internal_error，父资产和子值仍各有一条记录，且没有 delete_account_asset 审计。

~~~ts
env.DB = withD1StatementFailure(
  sqliteD1(database),
  (query) => query.includes('INSERT INTO audit_events'),
);
~~~

- [ ] **Step 2: 运行测试并确认 RED**

Run:

~~~bash
cd app
npm test -- test/index-users-whitelist.test.ts
~~~

Expected: FAIL；新的永久删除测试收到 404 或其他缺少路由的预期失败，而不是 TypeScript、夹具或 migration 错误。

- [ ] **Step 3: 添加最小 DELETE API 实现**

在 app/src/index.ts 中紧跟 PUT /api/account-assets/:accountId 路由后、已弃用 field-values 路由前添加：

~~~ts
app.delete('/api/account-assets/:accountId', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const accountId = c.req.param('accountId');
  const existing = await c.env.DB.prepare(
    'SELECT id, display_name, asset_identifier, status FROM account_assets WHERE id = ?',
  ).bind(accountId).first<{
    id: string;
    display_name: string;
    asset_identifier: string;
    status: string;
  }>();
  if (!existing) return problem(c, 404, 'account_asset_not_found', '账号资产不存在。');

  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM account_field_values WHERE account_asset_id = ?',
    ).bind(accountId),
    c.env.DB.prepare(
      'DELETE FROM account_assets WHERE id = ?',
    ).bind(accountId),
    c.env.DB.prepare(
      'INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      crypto.randomUUID(),
      auth.userId,
      'delete_account_asset',
      'account_asset',
      accountId,
      JSON.stringify({
        display_name: existing.display_name,
        asset_identifier: existing.asset_identifier,
        status: existing.status,
      }),
    ),
  ]);
  return c.json({ account_asset_id: accountId, deleted: true });
});
~~~

不要把现有 appendAudit() 用在此路由：它会单独执行 SQL，不能与两条删除语句放入同一 D1 批处理。不要向现有 GET、POST、PUT 端点增加额外字段或修改数据库 schema。

- [ ] **Step 4: 运行 GREEN 和类型检查**

Run:

~~~bash
cd app
npm test -- test/index-users-whitelist.test.ts
npm run typecheck
~~~

Expected: 两条命令均通过；成功、资产管理员、拒绝、404、Origin、审计字段与批处理回滚断言全部为绿。

- [ ] **Step 5: 检查范围并提交 API 任务**

Run:

~~~bash
git diff --check
git diff -- app/src/index.ts app/test/index-users-whitelist.test.ts
git add app/src/index.ts app/test/index-users-whitelist.test.ts
git commit -m "feat: delete account assets"
~~~

Expected: diff 检查无输出，提交仅含 DELETE API 和其行为测试。

### Task 2: 以 UI 契约测试实现管理员删除入口

**Files:**

- Modify: app/test/ui.test.ts
- Modify: app/src/ui.ts: styles()、accounts table actionCell()、account action event branch

**Interfaces:**

- Consumes: canManageAccounts、api.accountOperational、collectionRows.accounts、refreshAll() 和现有 toast/jsonRequest()。
- Produces: 管理员账号资产行中的 data-action="delete-account" 按钮；二次确认、DELETE 请求、成功刷新、编辑面板清理和失败恢复。

- [ ] **Step 1: 写入会因缺少删除 UI 而失败的页面契约测试**

扩展 app/test/ui.test.ts 的 “emits account management controls and script branches only to asset administrators” 测试。管理员 HTML 必须包含：

~~~ts
expect(assetAdmin).toContain('data-action="delete-account"');
expect(assetAdmin).toContain('data-account-name');
expect(assetAdmin).toContain('class="button danger"');
expect(assetAdmin).toContain('确定永久删除「');
expect(assetAdmin).toContain("method: 'DELETE'");
expect(assetAdmin).toContain("toast('账号资产已永久删除。')");
expect(assetAdmin).toContain("form.elements.account_id.value === accountId");
~~~

对现有 readOnlyPrincipals 循环增加下列断言标识：

~~~ts
'delete-account',
'data-account-name',
'确定永久删除「',
'账号资产已永久删除。',
~~~

这些标识应在只读 HTML 中全部不存在；继续保留现有对 account-operational 和 /api/account-assets/:id 的隔离断言。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

~~~bash
cd app
npm test -- test/ui.test.ts
~~~

Expected: FAIL；管理员 HTML 尚不含 delete-account 或不可恢复确认文案。

- [ ] **Step 3: 在服务端管理分支内生成危险操作按钮和处理器**

在 app/src/ui.ts 的 button 样式中紧跟 secondary 样式增加：

~~~css
.button.danger { color:#fff; background:var(--danger); }
.button.danger:hover { background:#9f2e2e; }
~~~

在 accounts 的 actionCell() 分支中，将仅返回编辑按钮替换为同一操作单元格中的编辑和删除按钮。删除按钮必须使用已经转义的行 ID 和显示名称：

~~~ts
return '<td><button class="button secondary" type="button" data-action="edit-account" data-account-id="' + escapeHtml(row.id) + '">编辑</button> <button class="button danger" type="button" data-action="delete-account" data-account-id="' + escapeHtml(row.id) + '" data-account-name="' + escapeHtml(String(row.display_name || '该账号资产')) + '">删除</button></td>';
~~~

在 canManageAccounts 包裹的点击事件分支中，紧跟 cancel-edit-account 处理器加入：

~~~ts
if (action === 'delete-account') {
  const accountId = button.dataset.accountId;
  const accountName = button.dataset.accountName || '该账号资产';
  if (!accountId) return;
  if (!window.confirm('确定永久删除「' + accountName + '」吗？此操作不可恢复。')) return;
  button.disabled = true;
  try {
    await jsonRequest(
      api.accountOperational.replace(':id', encodeURIComponent(accountId)),
      { method: 'DELETE' },
    );
    const panel = document.getElementById('account-edit-panel');
    const form = panel && panel.querySelector('form');
    if (panel && form && form.elements.account_id.value === accountId) {
      panel.hidden = true;
      form.reset();
    }
    toast('账号资产已永久删除。');
    refreshAll();
  } catch (error) {
    toast(error.message || '删除失败。');
    button.disabled = false;
  }
  return;
}
~~~

保持该字符串插值完全位于 canManageAccounts 模板分支中。复用 api.accountOperational，不新增 accountDelete API 契约字段；这样只读契约现有的解构排除继续有效。

- [ ] **Step 4: 运行 GREEN**

Run:

~~~bash
cd app
npm test -- test/ui.test.ts
npm run typecheck
~~~

Expected: 管理员页面包含完整删除契约，五种只读角色的输出均不包含；TypeScript 通过。

- [ ] **Step 5: 检查范围并提交 UI 任务**

Run:

~~~bash
git diff --check
git diff -- app/src/ui.ts app/test/ui.test.ts
git add app/src/ui.ts app/test/ui.test.ts
git commit -m "feat: add account asset deletion UI"
~~~

Expected: diff 检查无输出，提交仅含删除按钮、交互、样式和 UI 契约测试。

### Task 3: 更新使用说明并执行完整本地验证

**Files:**

- Modify: README.md
- Modify: app/README.md

**Interfaces:**

- Consumes: 已实现的 DELETE /api/account-assets/:id、delete_account_asset 审计边界和无 migration 决策。
- Produces: 面向使用者和维护者的删除权限、不可恢复性、遗留字段清理和 API 说明。

- [ ] **Step 1: 更新根 README 的功能与安全边界**

将账号资产能力说明从“可创建或编辑”更新为“可创建、编辑或永久删除”。在安全模型或账号资产说明中补充：永久删除由 system_admin/asset_admin 发起，连同该资产的弃用 account_field_values 一并移除，审计只保留安全元数据；不宣称可恢复，也不记录凭据。

- [ ] **Step 2: 更新 app README 的接口与历史字段说明**

将 API 表的账号资产行更新为：

~~~text
GET/POST /api/account-assets、PUT/DELETE /api/account-assets/:id
~~~

在固定 asset_identifier 和弃用动态字段段落补充：常规情况下历史表只读保留；管理员永久删除某资产时，系统先删除该资产的 account_field_values，再删除资产，并写入不含账号标识、归属或 vault_ref 的审计事件。明确此功能不需要新的 D1 migration。

- [ ] **Step 3: 运行完整验证**

Run:

~~~bash
cd app
npm test
npm run typecheck
npm run build
cd ..
git diff --check
git status --short
~~~

Expected: 完整 Vitest 套件、类型检查、Worker dry-run build 和 diff 检查均通过；status 只列出本任务的文档改动，或在提交后为空。

- [ ] **Step 4: 提交文档**

Run:

~~~bash
git add README.md app/README.md
git commit -m "docs: document account asset deletion"
git status --short --branch
~~~

Expected: 文档提交完成，工作树干净；不执行 git push、远程 D1 migration 或 wrangler deploy。

### Task 4: 交付前独立复核与授权边界

**Files:**

- Review: app/src/index.ts
- Review: app/src/ui.ts
- Review: app/test/index-users-whitelist.test.ts
- Review: app/test/ui.test.ts
- Review: README.md
- Review: app/README.md

**Interfaces:**

- Consumes: 三个完成的本地提交与完整验证输出。
- Produces: 对权限隔离、不可恢复性、级联删除、审计脱敏和文档准确性的复核结论。

- [ ] **Step 1: 复核删除的安全不变量**

逐项检查：路由使用 DATA_ADMIN_ROLES；无 Origin 的 DELETE 被拒绝；account_field_values 在 account_assets 前删除；audit detail 没有账号标识、owner 或 vault_ref；不存在和重复删除不写审计；UI 删除分支只在 canManageAccounts 输出。

- [ ] **Step 2: 复核验证证据**

Run:

~~~bash
cd app
npm test -- test/index-users-whitelist.test.ts test/ui.test.ts
npm test
npm run typecheck
npm run build
cd ..
git diff --check
git status --short --branch
~~~

Expected: 所有命令通过；分支仅领先本地提交，不触发任何远端写入。

- [ ] **Step 3: 请求下一步授权**

向用户报告本地代码、测试、文档与提交结果。若用户希望推送 Git 或部署 Worker，分别明确请求授权；生产部署不需要 D1 migration，但仍须在用户确认后执行。
