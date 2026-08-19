import { describe, expect, it } from 'vitest';
import * as ui from '../src/ui';

describe('identity settings and external binding UI', () => {
  it('declares no external identity contract: the system is OTP-only', () => {
    expect(ui.UI_PAGES).toContain('profile');
    expect(ui.UI_API_CONTRACT).not.toHaveProperty('identities');
    expect(ui.UI_API_CONTRACT).not.toHaveProperty('beginIdentityLink');
    expect(ui.UI_API_CONTRACT).not.toHaveProperty('presentExternalIdentity');
    expect(ui).not.toHaveProperty('renderExternalIdentityUi');
    expect(ui).not.toHaveProperty('renderExternalAccessRequiredUi');
  });

  it('renders an OTP-only profile without any external binding controls', () => {
    const html = ui.renderAdminUi({
      page: 'profile',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });

    expect(html).toContain('登录身份');
    expect(html).toContain('企业主身份');
    expect(html).toContain('OTP');
    expect(html).toContain('登出所有设备');
    expect(html).toContain('href="/logout"');
    expect(html).not.toContain('绑定 Cloudflare');
    expect(html).not.toContain('绑定 GitHub');
    expect(html).not.toContain('data-action="begin-identity-link"');
    expect(html).not.toContain('待恢复的外部绑定');
    expect(html).not.toContain('identity-link-recovery');
  });

  it('keeps employee navigation and dashboard actions within personal scope', () => {
    const html = ui.renderAdminUi({
      page: 'dashboard',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });
    const navigation = html.match(/<nav>([\s\S]*?)<\/nav>/)?.[1] ?? '';

    expect(navigation).toContain('总览');
    expect(navigation).toContain('订阅资产');
    expect(navigation).toContain('账号资产');
    expect(navigation).toContain('报销中心');
    expect(navigation).toContain('个人设置');
    expect(navigation).not.toContain('汇率');
    expect(navigation).not.toContain('人员与权限');
    expect(html).not.toContain('维护订阅条款');
    expect(html).not.toContain('生成报销草稿');
    const employeeSubscriptions = ui.renderAdminUi({
      page: 'subscriptions',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });
    expect(employeeSubscriptions).toContain('id="subscriptions-filter"');
    expect(employeeSubscriptions).toContain('data-subscriptions-filter="status"');
    expect(employeeSubscriptions).toContain('data-subscriptions-filter="owner"');
    expect(employeeSubscriptions).toContain('data-subscriptions-filter="payer"');
    expect(employeeSubscriptions).toContain('data-subscriptions-filter="q"');
    expect(employeeSubscriptions).not.toContain('id="subscription-create-panel"');
    expect(html).not.toContain('/api/exchange-rates');
    expect(html).toContain('我的待报销');
    expect(html).toContain('进行中报销');
    expect(html).toContain('已报销（累计）');
  });

  it('does not render restricted forms when an employee follows a restricted UI URL directly', () => {
    for (const page of ['rates', 'people', 'finance'] as const) {
      const html = ui.renderAdminUi({
        page,
        principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
      });

      expect(html).toContain('<h1>管理总览</h1>');
      expect(html).not.toContain('<button class="button primary" type="button" data-action="create-reimbursement"');
      expect(html).not.toContain('<form data-api="fx-quotes"');
    }

    const reimbursements = ui.renderAdminUi({
      page: 'reimbursements',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });
    expect(reimbursements).toContain('<h1>报销中心</h1>');
    expect(reimbursements).toContain('data-action="create-reimbursement"');
  });

  it('offers a Cloudflare Access logout link in the main shell and external binding page', () => {
    const shell = ui.renderAdminUi({
      page: 'dashboard',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });
    const employeeShell = ui.renderAdminUi({
      page: 'dashboard',
      principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
    });
    for (const html of [shell, employeeShell]) {
      expect(html).toContain('href="/logout"');
      expect(html).not.toContain('href="/cdn-cgi/access/logout"');
    }
    expect(shell).toContain('>登出</a>');
  });

  it('renders the finance overview only to finance roles', () => {
    const finance = ui.renderAdminUi({
      page: 'finance',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });
    expect(finance).toContain('本财年已付款');
    expect(finance).toContain('本季度已付款');
    expect(finance).toContain('本月已付款');
    expect(finance).toContain('finance-monthly-chart');
    expect(finance).toContain('finance-pipeline-chart');
    expect(finance).toContain('财务总览');
    expect(finance).toContain('loadFinanceOverview');

    const payer = ui.renderAdminUi({
      page: 'finance',
      principal: { displayName: 'payer@lancloudtech.com', roles: ['payer'] },
    });
    const payerNav = payer.match(/<nav>([\s\S]*?)<\/nav>/)?.[1] ?? '';
    expect(payer).toContain('<h1>管理总览</h1>');
    expect(payer).not.toContain('id="finance-monthly-chart"');
    expect(payerNav).not.toContain('财务总览');
  });

  it('renders finance batch actions and Chinese status labels for finance roles', () => {
    const html = ui.renderAdminUi({
      page: 'reimbursements',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });

    expect(ui.UI_API_CONTRACT.reimbursementApprove).toBe('/api/reimbursements/:id/approve');
    expect(ui.UI_API_CONTRACT.reimbursementMarkPaid).toBe('/api/reimbursements/:id/mark-paid');
    expect(html).toContain('data-action="approve-batch"');
    expect(html).toContain('data-action="mark-paid-batch"');
    expect(html).toContain('canReviewFinance');
    expect(html).toContain("submitted: '待审核'");
    expect(html).toContain("approved: '待付款'");
    expect(html).toContain('window.prompt');
    expect(html).toContain('待报销金额');
    expect(html).toContain('已付款金额（累计）');
    expect(html).toContain('NEXT_STEP_LABELS');
    expect(html).toContain("approved: '等待财务确认付款'");
    expect(html).toContain('api.dashboard');
    expect(html).toContain('id="reviewer-modal"');
    expect(html).toContain('请选择本次报销提交的审批者');
    expect(html).toContain('id="reviewer-modal-select"');
    expect(html).toContain('data-action="confirm-reviewer"');
    expect(html).toContain('data-action="cancel-reviewer"');
    expect(html).toContain('.modal-overlay');
    expect(html).toContain("config.page === 'reimbursements' && api.reimbursementGenerate");
    expect(html).not.toContain('id="candidate-payer-filter"');
    expect(html).not.toContain('id="reimbursement-reviewer"');
    expect(html).toContain("actor_name: '提交人'");
    expect(html).toContain("reviewer_name: '审核人'");
  });

  it('keeps tables and sidebar usable on dense data and small screens', () => {
    const html = ui.renderAdminUi({
      page: 'subscriptions',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });

    // 侧边栏：sticky 全高、内部纵向滚动
    expect(html).toContain('position:sticky; top:0; height:100vh; overflow-y:auto');
    // 表格：默认不换行，长文本列单独放行；首末列双向冻结
    expect(html).toContain('white-space:nowrap; }');
    expect(html).toContain('td.cell-wrap');
    expect(html).toContain("WRAPPABLE_COLUMNS");
    expect(html).toContain('table.sticky-actions th:first-child');
    expect(html).toContain('table.sticky-actions td:first-child');
    expect(html).toContain('position:sticky; left:0');
    expect(html).toContain('position:sticky; right:0');
    // 指标卡自适应列数，长金额可换行
    expect(html).toContain('repeat(auto-fit,minmax(200px,1fr))');
    // 布局不溢出：grid 子项可收缩、面板限宽 100%
    expect(html).toContain('min-width:0; } .surface');
    expect(html).toContain('max-width:100%');
    expect(html).toContain('.split-grid > *, .account-grid > *, .metric-grid > * { min-width:0; }');
    expect(html).toContain('.split-grid, .account-grid { grid-template-columns:1fr; }');
    // 移动端侧边栏恢复横向布局且不限高
    expect(html).toContain('flex-direction:row; align-items:center; overflow:auto; height:auto;');
  });

  it('renders subscription editing controls and Chinese table labels', () => {
    const html = ui.renderAdminUi({
      page: 'subscriptions',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });

    expect(ui.UI_API_CONTRACT.subscriptionOperational).toBe('/api/subscriptions/:id/operational');
    expect(html).toContain('id="subscription-edit-panel"');
    expect(html).toContain('data-api="subscription-operational"');
    expect(html).toContain('data-action="edit-subscription"');
    expect(html).toContain('data-action="cancel-edit-subscription"');
    expect(html).toContain('name="amount"');
    expect(html).toContain('name="billing_cycle"');
    expect(html).toContain('value="semi_annual">半年付');
    expect(html).toContain('name="effective_start"');
    expect(html).toContain('name="term_effective_end"');
    expect(html).toContain('name="payer_user_id"');
    expect(html).toContain('data-options-from="active-users"');
    expect(html).toContain('<option>VISA Card</option>');
    expect(html).toContain('订阅截止日期');
    expect(html).toContain('sticky-actions');
    expect(html).toContain('[hidden] { display:none !important; }');
    expect(html).toContain("owner_name: '归属人员'");
    expect(html).toContain('HIDDEN_COLUMNS');
    expect(html).toContain('form.elements.owner_user_id.value');
    expect(html).toContain('id="subscriptions-filter"');
    expect(html).toContain('data-subscriptions-filter="status"');
    expect(html).toContain('value="active" selected');
    expect(html).toContain("status: 'active'");
    expect(html).toContain('data-subscriptions-filter="owner"');
    expect(html).toContain('data-subscriptions-filter="payer"');
    expect(html).toContain('data-subscriptions-filter="q"');
    expect(html).toContain('applySubscriptionsFilter');
    expect(html).toContain("uniqueNamedOptions(rows, 'owner_user_id', 'owner_name')");
    expect(html).toContain("uniqueNamedOptions(rows, 'payer_id', 'payer_name')");
  });

  it('renders the read-only auto-FX page without manual rate entry', () => {
    const html = ui.renderAdminUi({
      page: 'rates',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });

    expect(html).toContain('汇率全自动');
    expect(html).toContain('data-action="sync-fx"');
    expect(html).not.toContain('name="rate_cny_per_unit"');
    expect(html).not.toContain('data-api="fx-quotes"');
    expect(html).toContain("rate_display: '汇率'");
    expect(html).toContain("'人民币-'");
    expect(html).toContain("'rate_numerator', 'rate_denominator', 'base_currency'");
  });

  it('renders relational pickers instead of free-text IDs', () => {
    const people = ui.renderAdminUi({
      page: 'people',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });
    expect(people).toContain('data-options-from="users"');
    expect(people).toContain('data-options-from="roles"');
    expect(people).toContain('data-api="login-whitelist"');
    expect(people).toContain('id="user-edit-panel"');
    expect(people).toContain('data-action="edit-user"');
    expect(people).toContain('data-action="delete-whitelist-rule"');
    expect(people).not.toContain('新增系统用户');
    expect(people).not.toContain('新增付款者');
    expect(people).not.toContain('报销系统账号');
    expect(people).not.toContain('name="vendor_id"');

    const subscriptions = ui.renderAdminUi({
      page: 'subscriptions',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });
    expect(subscriptions).toContain('data-options-from="users"');
    expect(subscriptions).toContain('data-options-from="active-users"');
    expect(subscriptions).not.toContain('data-options-from="payers"');
    expect(subscriptions).toContain('data-action="toggle-create-subscription"');
    expect(subscriptions).toContain('id="subscription-create-panel" hidden');
    expect(subscriptions).toContain('id="subscriptions-filter"');
    expect(subscriptions).not.toContain('name="vendor_id"');

    const accounts = ui.renderAdminUi({
      page: 'accounts',
      principal: { displayName: 'admin@lancloudtech.com', roles: ['system_admin'] },
    });
    expect(ui.UI_API_CONTRACT).not.toHaveProperty('accountFieldDefinitions');
    expect(accounts).toContain('data-options-from="account-owners"');
    expect(accounts).toContain('data-action="toggle-create-account"');
    expect(accounts).toContain('id="account-create-panel" hidden');
    expect(accounts).toContain('name="asset_identifier"');
    expect(accounts).toContain('id="account-edit-panel"');
    expect(accounts).toContain('data-action="edit-account"');
    expect(accounts).toContain('id="accounts-filter"');
    expect(accounts).toContain('data-accounts-filter="owner"');
    expect(accounts).toContain('data-accounts-filter="asset"');
    expect(accounts).toContain('data-accounts-filter="status"');
    expect(accounts).toContain('data-accounts-filter="q"');
    expect(accounts).toContain("asset_identifier: '资产标识'");
    expect(accounts).toContain("accounts: ['display_name', 'asset_identifier', 'account_identifier_masked'");
    expect(accounts).toContain('row.asset_identifier');
    expect(accounts).not.toContain('data-api="account-field-definitions"');
    expect(accounts).not.toContain('字段名称<input name="label"');
    expect(accounts).not.toContain('name="vendor_id"');
  });

  it('uses display-name-only owner options and keeps unresolved account ownership out of updates', () => {
    expect(ui.UI_API_CONTRACT.accountOwners).toBe('/api/account-owners');
    const accounts = ui.renderAdminUi({
      page: 'accounts',
      principal: { displayName: 'asset-admin@example.test', roles: ['asset_admin'] },
    });

    expect(accounts).toContain('data-options-from="account-owners"');
    expect(accounts).not.toContain('data-options-from="users"');
    expect(accounts).toContain("'account-owners': { url: () => api.accountOwners, value: 'id', label: (row) => String(row.display_name || '') }");
    expect(accounts).toContain("ownerSelect.dataset.ownerSelectionReady === 'true'");
    expect(accounts).toContain('...(includeOwner ? { owner_user_id: values.owner_user_id || null } : {})');
  });

  it('omits account-owner management script identifiers from every read-only account page', () => {
    for (const principal of [
      { displayName: 'auditor@example.test', roles: ['auditor'] },
      { displayName: 'employee@example.test', roles: ['employee'] },
      { displayName: 'reviewer@example.test', roles: ['finance_reviewer'] },
      { displayName: 'payer@example.test', roles: ['payer'] },
      { displayName: 'unassigned@example.test', roles: [] },
    ]) {
      const readOnly = ui.renderAdminUi({ page: 'accounts', principal });
      for (const managementIdentifier of [
        '/api/account-owners',
        'account-owners',
        'api.accountOwners',
        'applyPendingSelectValue',
        'optionsLoaded',
        'pendingValue',
        'ownerSelectionReady',
      ]) expect(readOnly).not.toContain(managementIdentifier);
    }
  });

  it('renders account tables from the exact approved column whitelist', () => {
    const accounts = ui.renderAdminUi({
      page: 'accounts',
      principal: { displayName: 'asset-admin@example.test', roles: ['asset_admin'] },
    });

    expect(accounts).toContain("accounts: ['display_name', 'asset_identifier', 'account_identifier_masked', 'owner_name', 'status', 'expires_on', 'created_at']");
    expect(accounts).toContain("if (collection === 'accounts') return order.filter((key) => keys.includes(key));");
  });

  it('emits account management controls and script branches only to asset administrators', () => {
    const assetAdmin = ui.renderAdminUi({
      page: 'accounts',
      principal: { displayName: 'asset-admin@lancloudtech.com', roles: ['asset_admin'] },
    });
    expect(assetAdmin).toContain('data-action="toggle-create-account"');
    expect(assetAdmin).toContain('data-action="edit-account"');
    expect(assetAdmin).toContain('data-action="cancel-edit-account"');
    expect(assetAdmin).toContain('data-action="delete-account"');
    expect(assetAdmin).toContain('data-account-name');
    expect(assetAdmin).toContain('class="button danger"');
    expect(assetAdmin).toContain('确定永久删除「');
    expect(assetAdmin).toContain("method: 'DELETE'");
    expect(assetAdmin).toContain("toast('账号资产已永久删除。')");
    expect(assetAdmin).toContain('form.elements.account_id.value === accountId');
    expect(assetAdmin).toContain('data-api="account-operational"');
    expect(assetAdmin).toContain('api.accountOperational');
    expect(assetAdmin).toContain('/api/account-assets/:id');

    const readOnlyPrincipals: Array<{ displayName: string; roles: string[] }> = [
      { displayName: 'employee@lancloudtech.com', roles: ['employee'] },
      { displayName: 'auditor@lancloudtech.com', roles: ['auditor'] },
      { displayName: 'reviewer@lancloudtech.com', roles: ['finance_reviewer'] },
      { displayName: 'payer@lancloudtech.com', roles: ['payer'] },
      { displayName: 'unassigned@lancloudtech.com', roles: [] },
    ];
    for (const principal of readOnlyPrincipals) {
      const accounts = ui.renderAdminUi({ page: 'accounts', principal });
      for (const identifier of [
        'toggle-create-account',
        'account-create-panel',
        'account-edit-panel',
        'data-accounts-filter="asset"',
        'edit-account',
        'cancel-edit-account',
        'delete-account',
        'data-account-name',
        '确定永久删除「',
        '账号资产已永久删除。',
        'account-operational',
        'api.accountOperational',
        '/api/account-assets/:id',
      ]) expect(accounts).not.toContain(identifier);
      expect(accounts).toContain('data-collection="accounts"');
    }
  });
});
