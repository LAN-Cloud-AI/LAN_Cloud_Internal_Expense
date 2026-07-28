# 账号资产结构化与追加字段弃用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将账号资产中的服务/平台名固化为可筛选的“资产标识”，弃用追加字段功能，并在本地验收后按用户确认更新远端 D1 与 Worker。

**Architecture:** D1 通过一条追加式 migration 为 account_assets 添加 asset_identifier，仅使用不含个人信息的显示名称后缀规则回填现有条目。Worker API 将该字段作为新增时的必填字段、编辑时的可更新字段；旧动态字段路由只返回 410 Gone。服务端 HTML UI 复用现有隐藏面板模式，并从已加载的资产记录生成资产标识筛选项。

**Tech Stack:** Cloudflare Workers、Hono、D1/SQLite、TypeScript、Vitest、better-sqlite3、Wrangler。

## Global Constraints

- asset_identifier 的应用层最大长度为 120；新增时必须非空白，编辑时未提供则保留已有值。
- migration、测试、文档和提交信息不得包含真实姓名、邮箱、账号标识、数据库 ID、Token 或其他生产数据。
- migration 只追加列；不得删除 account_field_definitions、account_field_values 或其历史行；未匹配旧记录必须显式显示为“未分类”。
- GET/POST /api/account-field-definitions 与 PUT /api/account-assets/:accountId/field-values 固定返回 410，错误码为 account_fields_deprecated，且不访问动态字段表。
- 只有 system_admin 和 asset_admin 可创建或编辑账号资产；员工只保留本人资产的只读清单。
- 在 app/ 目录运行 Node 命令。先 npm ci，再运行测试、类型检查和构建。
- 远端 D1 migration 与 wrangler deploy 都是生产写操作，必须在完整本地验证完成并获得用户单独确认后执行。

---

### Task 1: 以 migration 测试建立固定资产标识与回填规则

**Files:**

- Create: app/migrations/0015_account_asset_identifier.sql
- Modify: app/test/schema-integrity.test.ts

**Interfaces:**

- Consumes: account_assets(display_name, account_identifier_masked)。
- Produces: account_assets.asset_identifier TEXT NOT NULL DEFAULT '未分类'，以及只依赖显示名称模式的回填结果。

- [ ] **Step 1: 安装依赖并确认 schema 测试基线**

Run:

~~~bash
cd app
npm ci
npm test -- test/schema-integrity.test.ts
~~~

Expected: 当前 schema 测试通过，0015 migration 尚不存在。

- [ ] **Step 2: 写入会因缺少 migration 而失败的测试**

在 app/test/schema-integrity.test.ts 中增加 createDatabaseBeforeAccountIdentifierMigration()。该 helper 新建内存数据库、开启 foreign_keys、执行排序后文件名小于 0015_account_asset_identifier.sql 的 migration，并在执行 0006_access_identities.sql 前调用现有 seedLedger(database)。

新增测试代码：

~~~ts
const database = createDatabaseBeforeAccountIdentifierMigration();
database.exec(
  "INSERT INTO account_assets (id, display_name, account_identifier_masked) VALUES " +
  "('asset-obs', '示例成员的OBS', 'example-obs')," +
  "('asset-github-id', '示例成员 · GitHub ID', 'example-github-id')," +
  "('asset-github-email', '示例成员 · GitHub 邮箱', 'example-github-email')," +
  "('asset-leadshunter', '示例成员 · LeadsHunter 用户名', 'example-leadshunter')," +
  "('asset-obsidian', '示例成员 · Obsidian', 'example-obsidian')," +
  "('asset-domain-mail', '示例成员 · 兰芯域名邮箱', 'example-domain-mail')," +
  "('asset-unmatched', '未匹配的旧资产', 'example-unmatched')",
);
database.exec(readFileSync(join(migrationsDir, '0015_account_asset_identifier.sql'), 'utf8'));

expect(
  database.prepare(
    'SELECT id, asset_identifier FROM account_assets ORDER BY id',
  ).all(),
).toEqual([
  { id: 'asset-domain-mail', asset_identifier: '兰芯域名邮箱' },
  { id: 'asset-github-email', asset_identifier: 'GitHub' },
  { id: 'asset-github-id', asset_identifier: 'GitHub' },
  { id: 'asset-leadshunter', asset_identifier: 'LeadsHunter' },
  { id: 'asset-obs', asset_identifier: 'OBS' },
  { id: 'asset-obsidian', asset_identifier: 'Obsidian' },
  { id: 'asset-unmatched', asset_identifier: '未分类' },
]);
~~~

- [ ] **Step 3: 运行测试并确认 RED**

Run:

~~~bash
cd app
npm test -- test/schema-integrity.test.ts
~~~

Expected: FAIL，原因为 0015_account_asset_identifier.sql 不存在（ENOENT），不是已有 migration 或测试配置失败。

- [ ] **Step 4: 写入最小追加式 migration**

创建 app/migrations/0015_account_asset_identifier.sql：

~~~sql
-- 账号资产的服务/平台标识；未识别的历史记录显式保留为“未分类”。
ALTER TABLE account_assets
  ADD COLUMN asset_identifier TEXT NOT NULL DEFAULT '未分类'
  CHECK (length(trim(asset_identifier)) > 0);

UPDATE account_assets
SET asset_identifier = CASE
  WHEN display_name LIKE '%的OBS' THEN 'OBS'
  WHEN display_name LIKE '% · GitHub ID' THEN 'GitHub'
  WHEN display_name LIKE '% · GitHub 邮箱' THEN 'GitHub'
  WHEN display_name LIKE '% · LeadsHunter 用户名' THEN 'LeadsHunter'
  WHEN display_name LIKE '% · Obsidian' THEN 'Obsidian'
  WHEN display_name LIKE '% · 兰芯域名邮箱' THEN '兰芯域名邮箱'
  ELSE asset_identifier
END;
~~~

- [ ] **Step 5: 运行 GREEN 与迁移隐私检查**

Run:

~~~bash
cd app
npm test -- test/schema-integrity.test.ts
rg -n "@|example-|示例成员|jeff|kaison|lance" migrations/0015_account_asset_identifier.sql
~~~

Expected: 测试 PASS，第二条命令无输出。

- [ ] **Step 6: 提交 migration 与测试**

~~~bash
git add app/migrations/0015_account_asset_identifier.sql app/test/schema-integrity.test.ts
git commit -m "feat: add account asset identifiers"
~~~

### Task 2: 以 API 测试实现固定字段与追加字段弃用

**Files:**

- Modify: app/src/index.ts
- Modify: app/test/index-users-whitelist.test.ts

**Interfaces:**

- Consumes: account_assets.asset_identifier 和 requiredString(body, 'asset_identifier', 120)。
- Produces: GET /api/account-assets 中的资产标识，POST 的必填资产标识，PUT 的可更新资产标识，以及动态字段端点的 410。

- [ ] **Step 1: 写入失败的 API 测试**

在现有 account asset editing 测试中将更新 payload 扩展为：

~~~ts
asset_identifier: '更新后服务',
~~~

并在 SQL 查询与 expect 中增加 asset_identifier。

新增测试使用既有 setup()、adminSession()、mutate() 和 request()：

~~~ts
const created = await mutate(app, env, 'POST', '/api/account-assets', {
  display_name: '演示 OBS 账号',
  asset_identifier: 'OBS',
  account_identifier_masked: 'demo-account',
});
expect(created.status).toBe(201);

const stored = database.prepare(
  "SELECT display_name, asset_identifier, account_identifier_masked " +
  "FROM account_assets WHERE account_identifier_masked = 'demo-account'",
).get();
expect(stored).toMatchObject({
  display_name: '演示 OBS 账号',
  asset_identifier: 'OBS',
  account_identifier_masked: 'demo-account',
});

const blank = await mutate(app, env, 'POST', '/api/account-assets', {
  display_name: '缺少资产标识',
  asset_identifier: '   ',
  account_identifier_masked: 'demo-blank',
});
expect(blank.status).toBe(400);

const fields = await request(app, env, '/api/account-field-definitions', 'admin');
expect(fields.status).toBe(410);
const fieldsBody = await fields.json() as { error: { code: string } };
expect(fieldsBody.error.code).toBe('account_fields_deprecated');

const values = await mutate(app, env, 'PUT', '/api/account-assets/missing/field-values', { values: [] });
expect(values.status).toBe(410);
~~~

同一测试还要 GET /api/account-assets，并断言 data 中有 asset_identifier: 'OBS' 的创建记录。

- [ ] **Step 2: 运行测试并确认 RED**

~~~bash
cd app
npm test -- test/index-users-whitelist.test.ts
~~~

Expected: FAIL；新创建记录仍是默认“未分类”，并且旧动态字段 GET 仍返回 200。

- [ ] **Step 3: 最小实现 API 与弃用端点**

在 POST /api/account-assets 中加入：

~~~ts
const assetIdentifier = requiredString(body, 'asset_identifier', 120);
~~~

INSERT 列表与绑定值加入 asset_identifier；创建审计详情改为：

~~~ts
{ display_name: displayName, asset_identifier: assetIdentifier }
~~~

在 PUT 路由的查询、类型、UPDATE 与审计详情中加入 asset_identifier，使用：

~~~ts
const assetIdentifier = body.asset_identifier === undefined
  ? existing.asset_identifier
  : requiredString(body, 'asset_identifier', 120);
~~~

将旧动态字段处理器替换为不访问数据库的 handler：

~~~ts
const accountFieldsDeprecated = (c: AppContext) => problem(
  c,
  410,
  'account_fields_deprecated',
  '账号资产的追加字段功能已弃用。',
);

app.get('/api/account-field-definitions', accountFieldsDeprecated);
app.post('/api/account-field-definitions', accountFieldsDeprecated);
app.put('/api/account-assets/:accountId/field-values', accountFieldsDeprecated);
~~~

删除旧字段定义查询、写入和字段值批处理代码，但保留其他 D1PreparedStatement 用途。

- [ ] **Step 4: 验证 GREEN 与权限回归**

~~~bash
cd app
npm test -- test/index-users-whitelist.test.ts
npm test -- test/index-access.test.ts test/index-employee-payer.test.ts test/index-users-whitelist.test.ts
~~~

Expected: 全部 PASS；资产标识可创建、读取、更新，空白值被拒绝，三个旧端点返回 410，员工范围未改变。

- [ ] **Step 5: 提交 API 与测试**

~~~bash
git add app/src/index.ts app/test/index-users-whitelist.test.ts
git commit -m "feat: structure account asset APIs"
~~~

### Task 3: 以 UI 契约测试实现隐藏新增、清单列与资产标识筛选

**Files:**

- Modify: app/src/ui.ts
- Modify: app/test/ui.test.ts

**Interfaces:**

- Consumes: /api/account-assets 返回的 asset_identifier。
- Produces: 管理员的 toggle-create-account、account-create-panel、asset 筛选状态和资产标识列；员工仍为只读。

- [ ] **Step 1: 写入失败的 UI 契约测试**

在 app/test/ui.test.ts 新增管理员页面断言：

~~~ts
expect(ui.UI_API_CONTRACT).not.toHaveProperty('accountFieldDefinitions');
expect(accounts).toContain('data-action="toggle-create-account"');
expect(accounts).toContain('id="account-create-panel" hidden');
expect(accounts).toContain('name="asset_identifier"');
expect(accounts).toContain('data-accounts-filter="asset"');
expect(accounts).toContain("asset_identifier: '资产标识'");
expect(accounts).toContain("accounts: ['display_name', 'asset_identifier', 'account_identifier_masked'");
expect(accounts).toContain('row.asset_identifier');
expect(accounts).not.toContain('data-api="account-field-definitions"');
expect(accounts).not.toContain('字段名称<input name="label"');
~~~

为 employee principal 断言不含 toggle-create-account、account-create-panel、account-edit-panel 和 data-accounts-filter="asset"。

- [ ] **Step 2: 运行测试并确认 RED**

~~~bash
cd app
npm test -- test/ui.test.ts
~~~

Expected: FAIL；当前页面仍显示追加字段卡片，新增面板没有隐藏，且没有资产标识筛选。

- [ ] **Step 3: 重构管理员账号资产页面**

在 accountsPage(false) 中，使用订阅页相同的模式替换始终可见的新增卡片：

~~~html
<section>
  <div class="form-actions">
    <button class="button primary" type="button" data-action="toggle-create-account" aria-expanded="false">＋ 新增账号资产</button>
  </div>
</section>
<section class="split-grid account-grid" id="account-create-panel" hidden>
  <article class="surface form-surface">
    <form data-api="account-assets" data-success="账号资产已创建。">
      <label>显示名称<input name="display_name" required maxlength="120" /></label>
      <label>资产标识<input name="asset_identifier" required maxlength="120" /></label>
      <label>账号标识<input name="account_identifier_masked" required maxlength="160" /></label>
      <label>归属人员（可选）<select name="owner_user_id" data-options-from="users"></select></label>
      <label>到期日（可选）<input name="expires_on" type="date" /></label>
      <div class="form-actions"><button class="button primary" type="submit">创建账号资产</button></div>
    </form>
  </article>
</section>
~~~

创建表单顺序必须为 display_name、必填 asset_identifier、account_identifier_masked、owner_user_id、expires_on。删除整个“追加字段”卡片与表单。编辑表单加入必填 asset_identifier，并在 edit-account 分支使用 row.asset_identifier || '' 回填。

- [ ] **Step 4: 连接表单、列表和筛选**

在 UI 内嵌脚本中使用：

~~~js
const accountsFilterState = { owner: '', asset: '', status: '', q: '' };

if (accountsFilterState.asset && row && row.asset_identifier !== accountsFilterState.asset) return false;

const hay = (
  String((row && row.display_name) || '') + ' ' +
  String((row && row.asset_identifier) || '') + ' ' +
  String((row && row.account_identifier_masked) || '')
).toLowerCase();
~~~

在 renderCollection() 的 accounts 分支中，从非空 row.asset_identifier 去重、按 localeCompare 的 zh-CN 规则排序，并重建 select[data-accounts-filter="asset"] 的选项；如果当前选择仍在集合内则保留它，否则清空 accountsFilterState.asset。

将 COLLECTION_COLUMN_ORDER.accounts 改为：

~~~js
['display_name', 'asset_identifier', 'account_identifier_masked', 'owner_name', 'status', 'expires_on', 'created_at']
~~~

在 FIELD_LABELS 加入 asset_identifier: '资产标识'；删除 UI_API_CONTRACT.accountFieldDefinitions 与 account-field-definitions 提交分支；account-operational payload 加入 asset_identifier。增加点击处理：

~~~js
if (action === 'toggle-create-account') {
  const panel = document.getElementById('account-create-panel');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  button.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
  return;
}
~~~

更新导航和页面说明，删除“可追加字段”文案。

- [ ] **Step 5: 运行 GREEN**

~~~bash
cd app
npm test -- test/ui.test.ts
~~~

Expected: PASS；管理员能看到默认隐藏的新增流程、资产标识字段/列/筛选，员工仍没有管理入口。

- [ ] **Step 6: 提交 UI 与测试**

~~~bash
git add app/src/ui.ts app/test/ui.test.ts
git commit -m "feat: improve account asset management UI"
~~~

### Task 4: 更新文档并完成本地验证

**Files:**

- Modify: README.md
- Modify: app/README.md

**Interfaces:**

- Consumes: 已实现的固定资产标识、410 动态字段端点和本地 D1 migration。
- Produces: 与产品一致的开发/部署说明和本地验收证据。

- [ ] **Step 1: 确认当前文档仍需更新**

~~~bash
rg -n "账号与可追加字段|可追加非财务关键字段|账号资产与追加字段" README.md app/README.md
~~~

Expected: 找到当前仍将追加字段描述为可用功能的文本。

- [ ] **Step 2: 更新两份 README**

在 README.md 将账号资产描述改为显示名称、资产标识、账号标识和归属人员。app/README.md 必须说明：

~~~md
- account_assets：显示名称、资产标识、账号标识与归属人员。
- account_field_definitions、account_field_values：保留的历史弃用表，不再提供创建或编辑功能。
- 账号资产 API：GET/POST /api/account-assets、PUT /api/account-assets/:id。
~~~

说明旧追加字段端点返回 410 Gone，且生产 migration 必须先于 Worker 部署。

- [ ] **Step 3: 验证文档、完整回归和构建**

~~~bash
cd app
npm test
npm run typecheck
npm run build
npm run db:migrations:local
~~~

Expected: 测试、类型检查、dry-run build 和本地 D1 migration 均以 exit 0 完成；0015 已应用到本地数据库。

- [ ] **Step 4: 启动本地 Worker 并完成页面验收**

~~~bash
cd app
npm run dev
~~~

Expected: 以非生产测试数据打开本地 /accounts，核验新增面板默认折叠、资产标识筛选、编辑回填及追加字段入口消失。不得在生产创建测试账号。

- [ ] **Step 5: 请求用户确认本地验收**

展示自动化验证与本地页面结果后，明确请求用户确认是否执行远端 D1 migration 和 Worker 部署。未确认前不得运行带 --remote 的命令或 wrangler deploy。

- [ ] **Step 6: 提交文档**

~~~bash
git add README.md app/README.md
git commit -m "docs: retire dynamic account fields"
~~~

### Task 5: 经确认后执行受控远端更新

**Files:**

- Modify: none；若远端 migration 状态异常，停止并报告阻塞原因。

**Interfaces:**

- Consumes: 用户对本地验收的明确确认、已认证 Wrangler、通过的 Task 4 验证和远端 migration 列表。
- Produces: 远端 D1 的 asset_identifier 列，以及部署后的 Worker UI/API。

- [ ] **Step 1: 再次确认生产写入授权**

确认精确动作：对 lan-cloud-expense 执行远端 migration，再部署 lan-cloud-internal-expense Worker 到 ie-oa.lancloudtech.com。说明这会写入生产 D1 并替换生产 Worker。

- [ ] **Step 2: 只读检查远端 migration 状态**

~~~bash
cd app
npx wrangler d1 migrations list DB --remote
~~~

Expected: 远端已应用到 0014_sync_runs_candidate_generation.sql。若缺少更早 migration、出现未知 migration 或无凭据，停止，不执行下一步。

- [ ] **Step 3: 应用远端 migration**

~~~bash
cd app
npx wrangler d1 migrations apply DB --remote
~~~

Expected: 仅 0015_account_asset_identifier.sql 被应用；不要把 Token 或个人账号数据写入日志或提交。

- [ ] **Step 4: 验证远端 migration 已记录**

~~~bash
cd app
npx wrangler d1 migrations list DB --remote
~~~

Expected: 0015_account_asset_identifier.sql 显示为已应用。

- [ ] **Step 5: 部署 Worker**

~~~bash
cd app
npx wrangler deploy
~~~

Expected: Wrangler 报告更新的 Worker 版本和 ie-oa.lancloudtech.com 路由。

- [ ] **Step 6: 生产只读冒烟验证**

在已登录管理员会话的 https://ie-oa.lancloudtech.com/accounts 验证资产标识列和值、资产标识筛选、默认收起的新增面板、编辑表单资产标识，以及追加字段入口已消失。不得在生产创建测试账号。

- [ ] **Step 7: 报告远端结果**

报告已应用 migration、部署版本、生产冒烟验证与任何未执行动作；若验证失败，停止继续写入并保留 Wrangler 输出摘要以便回滚决策。
