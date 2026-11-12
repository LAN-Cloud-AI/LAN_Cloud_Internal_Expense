/**
 * 兰芯云朵行政——订阅资产管理系统的轻量 Worker UI。
 *
 * 不引入浏览器端构建链或第三方 CDN：页面由 Worker 直接返回，交互通过
 * 同源 JSON API 完成。这样可与 Hono + Workers + D1 一起部署，不需要单独
 * 托管一台前端服务器。
 */

export const UI_PAGES = [
  'dashboard',
  'subscriptions',
  'accounts',
  'reimbursements',
  'finance',
  'rates',
  'people',
  'profile',
] as const;

export type UiPage = (typeof UI_PAGES)[number];

export interface UiPrincipal {
  displayName?: string;
  roles?: string[];
}

export interface UiShellOptions {
  page?: UiPage;
  principal?: UiPrincipal | null;
  onePass?: boolean;
  managedMembers?: boolean;
  memberManagementUrl?: string | null;
  /**
   * 仅允许由本服务端生成的可信 HTML。业务数据请通过 JSON API 返回，避免把
   * 来自用户的数据直接拼入 HTML。
   */
  trustedBody?: string;
}

export const UI_API_CONTRACT = {
  dashboard: '/api/dashboard',
  subscriptions: '/api/subscriptions',
  subscriptionOperational: '/api/subscriptions/:id/operational',
  accountAssets: '/api/account-assets',
  accountOperational: '/api/account-assets/:id',
  accountOwners: '/api/account-owners',
  reimbursementCandidates: '/api/reimbursements/candidates',
  reimbursementGenerate: '/api/reimbursements/generate-candidates',
  reimbursementPreview: '/api/reimbursements/preview',
  reimbursementCreate: '/api/reimbursements/create-batches',
  reimbursementReviewers: '/api/reimbursements/reviewers',
  reimbursementBatches: '/api/reimbursements/batches',
  reimbursementApprove: '/api/reimbursements/:id/approve',
  reimbursementMarkPaid: '/api/reimbursements/:id/mark-paid',
  fxQuotes: '/api/fx-quotes',
  fxSync: '/api/exchange-rates/sync',
  users: '/api/users',
  userOperational: '/api/users/:id',
  roles: '/api/roles',
  payers: '/api/payers',
  loginWhitelist: '/api/login-whitelist',
  loginWhitelistDelete: '/api/login-whitelist/:id',
  financeOverview: '/api/finance/overview',
  auditEvents: '/api/audit-events',
} as const;

const {
  accountOperational: _accountOperational,
  accountOwners: _accountOwners,
  ...READ_ONLY_ACCOUNT_UI_API_CONTRACT
} = UI_API_CONTRACT;

const {
  users: _users,
  userOperational: _userOperational,
  roles: _roles,
  loginWhitelist: _loginWhitelist,
  loginWhitelistDelete: _loginWhitelistDelete,
  ...MANAGED_MEMBER_UI_API_CONTRACT
} = UI_API_CONTRACT;

const EMPLOYEE_UI_API_CONTRACT = {
  dashboard: UI_API_CONTRACT.dashboard,
  subscriptions: UI_API_CONTRACT.subscriptions,
  accountAssets: UI_API_CONTRACT.accountAssets,
  reimbursementCandidates: UI_API_CONTRACT.reimbursementCandidates,
  reimbursementBatches: UI_API_CONTRACT.reimbursementBatches,
  reimbursementGenerate: UI_API_CONTRACT.reimbursementGenerate,
  reimbursementPreview: UI_API_CONTRACT.reimbursementPreview,
  reimbursementCreate: UI_API_CONTRACT.reimbursementCreate,
} as const;

interface NavItem {
  page: UiPage;
  href: string;
  icon: string;
  label: string;
  description: string;
}

const NAV_ITEMS: NavItem[] = [
  { page: 'dashboard', href: '/', icon: '▦', label: '总览', description: '待办与风险' },
  { page: 'subscriptions', href: '/subscriptions', icon: '◫', label: '订阅资产', description: '订阅、条款与付款者' },
  { page: 'accounts', href: '/accounts', icon: '◇', label: '账号资产', description: '账号、资产标识与归属' },
  { page: 'reimbursements', href: '/reimbursements', icon: '￥', label: '报销中心', description: '候选、合单与付款' },
  { page: 'finance', href: '/finance', icon: '∑', label: '财务总览', description: '财年支出与图表' },
  { page: 'rates', href: '/rates', icon: '↗', label: '汇率', description: '快照与同步状态' },
  { page: 'people', href: '/people', icon: '◎', label: '人员与权限', description: '用户、角色与付款者' },
  { page: 'profile', href: '/profile', icon: '◌', label: '个人设置', description: '登录身份与会话' },
];

const PAGE_META: Record<UiPage, { title: string; eyebrow: string; description: string }> = {
  dashboard: {
    title: '管理总览',
    eyebrow: '兰芯云朵行政',
    description: '集中查看订阅资产、待报销费用、汇率与支出动态。',
  },
  subscriptions: {
    title: '订阅资产',
    eyebrow: 'SUBSCRIPTIONS',
    description: '维护订阅主体、版本化条款、付款者有效期与自动续费信息。',
  },
  accounts: {
    title: '账号资产',
    eyebrow: 'ACCOUNT ASSETS',
    description: '记录内部账号资产及其资产标识，不保存密码或验证码。',
  },
  reimbursements: {
    title: '报销中心',
    eyebrow: 'REIMBURSEMENT',
    description: '批量选择候选费用后，系统按付款者自动拆分为报销批次。',
  },
  finance: {
    title: '财务总览',
    eyebrow: 'FINANCE OVERVIEW',
    description: '本财年、季度、月度支出与报销管线一览。',
  },
  rates: {
    title: '汇率快照',
    eyebrow: 'FX SNAPSHOTS',
    description: '报销候选锁定当时汇率；后续汇率变化不会改写历史金额。',
  },
  people: {
    title: '人员与权限',
    eyebrow: 'ACCESS CONTROL',
    description: '以登录主体绑定系统角色；付款者、审核人与管理员权限彼此分离。',
  },
  profile: {
    title: '个人设置',
    eyebrow: 'IDENTITY SETTINGS',
    description: '查看登录身份与会话。',
  },
};

const EMPLOYEE_PAGES: UiPage[] = ['dashboard', 'subscriptions', 'accounts', 'reimbursements', 'profile'];

const FINANCE_VIEW_ROLES = ['system_admin', 'finance_reviewer', 'auditor'];
const ACCOUNT_MANAGER_ROLES = ['system_admin', 'asset_admin'];

function canViewFinance(principal: UiPrincipal | null | undefined): boolean {
  const roles = principal?.roles ?? [];
  return roles.some((role) => FINANCE_VIEW_ROLES.includes(role));
}

function isEmployeeOnly(principal: UiPrincipal | null | undefined): boolean {
  const roles = principal?.roles ?? [];
  return roles.includes('employee') && roles.every((role) => role === 'employee');
}

function canManageAccountAssets(principal: UiPrincipal | null | undefined): boolean {
  const roles = principal?.roles ?? [];
  return roles.some((role) => ACCOUNT_MANAGER_ROLES.includes(role));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case "'":
        return '&#39;';
      case '"':
        return '&quot;';
      default:
        return character;
    }
  });
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function card(label: string, value: string, note: string, tone = ''): string {
  return `<article class="metric ${tone}">
    <p>${label}</p>
    <strong data-metric="${escapeHtml(label)}">${value}</strong>
    <small>${note}</small>
  </article>`;
}

function sectionHeading(title: string, description: string, action?: string): string {
  return `<div class="section-heading">
    <div><h2>${title}</h2><p>${description}</p></div>
    ${action ?? ''}
  </div>`;
}

function emptyCollection(id: string, label: string): string {
  return `<div class="data-panel" data-collection="${id}" data-label="${escapeHtml(label)}" aria-live="polite">
    <div class="empty-state"><strong>正在载入${label}</strong><span>若尚未配置数据或权限，系统会在此说明原因。</span></div>
  </div>`;
}

function subscriptionsFilterBar(): string {
  return `<div class="filter-bar" id="subscriptions-filter">
      <select data-subscriptions-filter="status"><option value="">全部状态</option><option value="active" selected>有效</option><option value="paused">暂停</option><option value="ended">已结束</option></select>
      <select data-subscriptions-filter="owner"><option value="">全部使用者</option></select>
      <select data-subscriptions-filter="payer"><option value="">全部付款者</option></select>
      <input data-subscriptions-filter="q" placeholder="搜索名称、备注或付款方式" maxlength="80" />
    </div>`;
}

function employeeDashboardPage(): string {
  return `<section class="metric-grid employee-metric-grid">
    ${card('我的订阅', '—', '仅统计归属自己的订阅资产')}
    ${card('我的账号资产', '—', '仅统计归属自己的账号资产', 'accent')}
    ${card('我的待报销', '—', '待合单的候选金额', 'accent')}
    ${card('进行中报销', '—', '已提交待审核/待付款', 'neutral')}
    ${card('已报销（累计）', '—', '已付款批次合计', 'neutral')}
  </section>
  <section class="surface">
    ${sectionHeading('我的资产概览', '此页面只显示你被分配的订阅与账号资产。')}
    ${emptyCollection('dashboard', '个人概览')}
  </section>`;
}

function dashboardPage(employeeOnly = false): string {
  if (employeeOnly) return employeeDashboardPage();
  return `<section class="metric-grid">
    ${card('待报销金额', '—', '待合单的候选合计', 'accent')}
    ${card('待审核批次', '—', '已提交未完成的批次', 'warning')}
    ${card('汇率异常', '—', '缺失、过期或同步失败的快照', 'warning')}
    ${card('已付款（累计）', '—', '全部已付款批次合计', 'neutral')}
  </section>
  <section class="split-grid">
    <article class="surface">
      ${sectionHeading('近 12 个月已付款', '按付款日期聚合；无付款的月份显示为 0。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
      <div class="chart-panel" id="dashboard-monthly-chart" aria-live="polite"><div class="empty-state"><strong>正在载入图表</strong></div></div>
    </article>
    <article class="surface">
      ${sectionHeading('报销管线', '在途与已结算资金的金额分布。')}
      <div class="chart-panel" id="dashboard-pipeline-chart" aria-live="polite"><div class="empty-state"><strong>正在载入图表</strong></div></div>
      ${sectionHeading('今日操作', '从候选生成、账期计算到报销付款，关键状态均会留存审计记录。')}
      <div class="action-grid">
        <a class="action-card" href="/subscriptions"><span>01</span><strong>维护订阅条款</strong><p>修改价格或付款者时以新版本生效，不改历史账。</p></a>
        <a class="action-card" href="/reimbursements"><span>02</span><strong>发起报销</strong><p>生成候选费用，勾选后按付款者一键合单。</p></a>
      </div>
    </article>
  </section>
  <section class="surface">
    ${sectionHeading('系统动态', '同步、金额锁定、付款确认和权限变更会写入审计日志。')}
    ${emptyCollection('dashboard', '概览数据')}
  </section>`;
}

function subscriptionsPage(employeeOnly = false): string {
  if (employeeOnly) {
    return `<section class="surface">
      ${sectionHeading('订阅清单', '可按状态、使用者和付款者筛选；仅显示归属自己的订阅资产。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
      ${subscriptionsFilterBar()}
      ${emptyCollection('subscriptions', '订阅')}
    </section>`;
  }
  return `<section>
    <div class="form-actions"><button class="button primary" type="button" data-action="toggle-create-subscription" aria-expanded="false">＋ 新增订阅</button></div>
  </section>
  <section class="split-grid" id="subscription-create-panel" hidden>
    <article class="surface form-surface">
      ${sectionHeading('新增订阅', '新增后请创建一条版本化条款；价格、币种、周期不直接覆盖历史。')}
      <form data-api="subscriptions" data-success="订阅已创建。">
        <label>订阅名称<input name="name" required maxlength="120" placeholder="例如：团队协作工具" /></label>
        <div class="two-columns">
          <label>订阅总价（原币）<input name="amount" inputmode="decimal" maxlength="20" placeholder="例如：699.00" /></label>
          <label>币种<select name="original_currency"><option>CNY</option><option>USD</option><option>EUR</option><option>HKD</option><option>JPY</option><option>GBP</option><option>SGD</option><option>AUD</option><option>CAD</option><option>CHF</option><option>KRW</option></select></label>
        </div>
        <div class="two-columns">
          <label>订阅周期<select name="billing_cycle"><option value="">不设置</option><option value="monthly">月付</option><option value="quarterly">季付</option><option value="semi_annual">半年付</option><option value="yearly">年付</option><option value="one_time">一次性</option></select></label>
          <label>付款者（在职员工，可选）<select name="payer_user_id" data-options-from="active-users"><option value="">正在载入员工…</option></select></label>
        </div>
        <div class="two-columns">
          <label>订阅开始日期<input name="effective_start" type="date" /></label>
          <label>订阅截止日期（空=持续续费）<input name="term_effective_end" type="date" /></label>
        </div>
        <label>使用者（可选）<select name="owner_user_id" data-options-from="users"><option value="">正在载入人员…</option></select></label>
        <label>付款方式（可选）<select name="payment_method_masked"><option value="">未设置</option><option>VISA Card</option><option>Master Card</option><option>Paypal</option><option>Apple AppStore</option><option>支付宝</option><option>微信支付</option></select></label>
        <label>备注（可选）<textarea name="notes" rows="2" maxlength="2000" placeholder="不填写密码、卡号或验证码"></textarea></label>
        <label><span>自动续费</span><select name="auto_renew"><option value="false">否</option><option value="true">是</option></select></label>
        <div class="form-actions"><button class="button primary" type="submit">创建订阅</button></div>
        <div class="action-result" data-form-result aria-live="polite"></div>
      </form>
    </article>
    <article class="surface explain-card">
      <span class="eyebrow">规则</span>
      <h2>条款与付款者均有有效期</h2>
      <p>每一笔候选费用都会复制当时的价格、原币金额、汇率和付款者。历史报销不会因今天改价、换卡或换人而变动。</p>
      <ul>
        <li>周期：月付、季付、半年付、年付、一次性；从生效日起整期一次性入账</li>
        <li>结算：账期开始当天计入一整期，不按天摊销</li>
        <li>续费：作为订阅属性记录并在到期前提醒</li>
      </ul>
    </article>
  </section>
  <section class="surface form-surface" id="subscription-edit-panel" hidden>
    ${sectionHeading('编辑订阅', '修改归属人员、续费与脱敏信息；价格、币种、周期需以新条款版本变更，不在此编辑。')}
    <form data-api="subscription-operational" data-success="订阅已更新。">
      <input type="hidden" name="subscription_id" />
      <div class="two-columns">
        <label>订阅名称<input name="name" disabled /></label>
        <label>使用者（可选）<select name="owner_user_id" data-options-from="users"><option value="">正在载入人员…</option></select></label>
      </div>
      <div class="two-columns">
        <label>付款者（在职员工，可选）<select name="payer_user_id" data-options-from="active-users"><option value="">正在载入员工…</option></select></label>
        <label>付款方式（可选）<select name="payment_method_masked"><option value="">未设置</option><option>VISA Card</option><option>Master Card</option><option>Paypal</option><option>Apple AppStore</option><option>支付宝</option><option>微信支付</option></select></label>
      </div>
      <div class="two-columns">
        <label>订阅总价（原币）<input name="amount" inputmode="decimal" maxlength="20" placeholder="例如：3500.00" /></label>
        <label>币种<select name="original_currency"><option>CNY</option><option>USD</option><option>EUR</option><option>HKD</option><option>JPY</option><option>GBP</option><option>SGD</option><option>AUD</option><option>CAD</option><option>CHF</option><option>KRW</option></select></label>
      </div>
      <div class="two-columns">
        <label>订阅周期<select name="billing_cycle"><option value="monthly">月付</option><option value="quarterly">季付</option><option value="semi_annual">半年付</option><option value="yearly">年付</option><option value="one_time">一次性</option></select></label>
        <label>生效开始日期<input name="effective_start" type="date" /></label>
      </div>
      <div class="two-columns">
        <label>订阅截止日期（空=持续续费）<input name="term_effective_end" type="date" /></label>
        <span></span>
      </div>
      <p class="muted">修改价格、币种或周期会以新条款版本生效并关闭旧条款，不覆盖历史报销；四项需一起填写。</p>
      <div class="two-columns">
        <label><span>自动续费</span><select name="auto_renew"><option value="false">否</option><option value="true">是</option></select></label>
        <span></span>
      </div>
      <label>备注（可选）<textarea name="notes" rows="2" maxlength="2000"></textarea></label>
      <div class="form-actions">
        <button class="button primary" type="submit">保存修改</button>
        <button class="button secondary" type="button" data-action="cancel-edit-subscription">取消</button>
      </div>
    </form>
    <div class="action-result" id="subscription-edit-result" aria-live="polite"></div>
  </section>
  <section class="surface">
    ${sectionHeading('订阅清单', '可按状态、使用者和付款者筛选；原始导入数据保持可追溯。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${subscriptionsFilterBar()}
    ${emptyCollection('subscriptions', '订阅')}
  </section>`;
}

function accountsPage(canManageAccounts = false, employeeOnly = false): string {
  if (!canManageAccounts) {
    return `<section class="surface">
      ${sectionHeading('账号资产清单', employeeOnly ? '仅显示归属自己的账号资产。' : '只读查看账号资产。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
      ${emptyCollection('accounts', '账号资产')}
    </section>`;
  }
  return `<section>
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
        <label>归属人员（可选）<select name="owner_user_id" data-options-from="account-owners"></select></label>
        <label>到期日（可选）<input name="expires_on" type="date" /></label>
        <div class="form-actions"><button class="button primary" type="submit">创建账号资产</button></div>
      </form>
    </article>
  </section>
  <section class="surface form-surface" id="account-edit-panel" hidden>
    ${sectionHeading('编辑账号资产', '修改名称、标识、归属、到期日与状态；密钥、密码不进入本系统。')}
    <form data-api="account-operational" data-success="账号资产已更新。">
      <input type="hidden" name="account_id" />
      <div class="two-columns">
        <label>展示名称<input name="display_name" required maxlength="120" /></label>
        <label>账号标识<input name="account_identifier" required maxlength="160" /></label>
      </div>
      <label>资产标识<input name="asset_identifier" required maxlength="120" /></label>
      <div class="two-columns">
        <label>归属人员（可选）<select name="owner_user_id" data-options-from="account-owners"><option value="">正在载入人员…</option></select></label>
        <label>状态<select name="status"><option value="active">有效</option><option value="inactive">已停用</option><option value="retired">已退役</option></select></label>
      </div>
      <div class="two-columns">
        <label>到期日（可选）<input name="expires_on" type="date" /></label>
        <label>凭据库引用（可选）<input name="vault_ref" maxlength="255" /></label>
      </div>
      <div class="form-actions">
        <button class="button primary" type="submit">保存修改</button>
        <button class="button secondary" type="button" data-action="cancel-edit-account">取消</button>
      </div>
    </form>
    <div class="action-result" id="account-edit-result" aria-live="polite"></div>
  </section>
  <section class="surface">
    ${sectionHeading('账号资产清单', '可按归属人员、资产标识、状态和关键字筛选。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    <div class="filter-bar" id="accounts-filter">
      <select data-accounts-filter="owner" data-options-from="account-owners" data-default-label="全部人员"></select>
      <select data-accounts-filter="asset"><option value="">全部资产标识</option></select>
      <select data-accounts-filter="status"><option value="">全部状态</option><option value="active">有效</option><option value="inactive">已停用</option><option value="retired">已退役</option></select>
      <input data-accounts-filter="q" placeholder="搜索名称、资产标识或账号标识" maxlength="80" />
    </div>
    ${emptyCollection('accounts', '账号资产')}
  </section>`;
}

function reimbursementsPage(): string {
  return `<section class="metric-grid">
    ${card('待报销金额', '—', '待合单的候选金额')}
    ${card('待审核批次', '—', '已提交未完成的批次', 'accent')}
    ${card('进行中金额', '—', '审核中与待付款合计', 'neutral')}
    ${card('已付款金额（累计）', '—', '全部已付款批次', 'neutral')}
  </section>
  <section class="notice info"><strong>合单规则：</strong>勾选候选费用后一次提交，系统按付款者拆分为报销批次；不同币种先锁定汇率换算为 CNY 分后合计。候选金额、原币和汇率在生成时即锁定。</section>
  <section class="surface">
    ${sectionHeading('候选费用', '系统每日按当天自动入池新账期；勾选要报销的候选，一次提交。')}
    <div class="form-actions" style="margin-bottom:12px">
      <button class="button primary" type="button" data-action="create-reimbursement">提交报销</button>
      <button class="button secondary" type="button" data-action="refresh">刷新</button>
    </div>
    <div class="action-result" id="reimbursement-result" aria-live="polite"></div>
    ${emptyCollection('reimbursement-candidates', '报销候选')}
  </section>
  <div class="modal-overlay" id="reviewer-modal" hidden>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="reviewer-modal-title">
      <h3 id="reviewer-modal-title">请选择本次报销提交的审批者</h3>
      <p class="muted">提交后报销流程将流转给该审批者，由其完成审核与确认放款。</p>
      <label>审批者<select id="reviewer-modal-select" data-options-from="reviewers" required><option value="">正在载入审批者…</option></select></label>
      <div class="form-actions">
        <button class="button primary" type="button" data-action="confirm-reviewer">确认提交</button>
        <button class="button secondary" type="button" data-action="cancel-reviewer">取消</button>
      </div>
      <div class="action-result" id="reviewer-modal-result" aria-live="polite"></div>
    </div>
  </div>
  <section class="surface">
    ${sectionHeading('报销批次', '付款确认仅开放给具备财务权限的用户。')}
    ${emptyCollection('reimbursement-batches', '报销批次')}
  </section>`;
}

function financePage(): string {
  return `<section class="metric-grid">
    ${card('本财年已付款', '—', '已付款批次合计', 'accent')}
    ${card('本季度已付款', '—', '已付款批次合计')}
    ${card('本月已付款', '—', '已付款批次合计')}
    ${card('待报销金额', '—', '待合单候选合计', 'warning')}
  </section>
  <section class="surface">
    ${sectionHeading('近 12 个月已付款金额', '按付款日期聚合；无付款的月份显示为 0。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    <div class="chart-panel" id="finance-monthly-chart" aria-live="polite"><div class="empty-state"><strong>正在载入图表</strong></div></div>
  </section>
  <section class="surface">
    ${sectionHeading('报销管线', '待报销 → 待审核 → 待付款 → 已付款的金额分布。')}
    <div class="chart-panel" id="finance-pipeline-chart" aria-live="polite"><div class="empty-state"><strong>正在载入图表</strong></div></div>
  </section>
  <section class="surface">
    ${sectionHeading('审计事件', '权限、金额锁定、付款确认和冲销均会写入审计日志。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('audit-events', '审计事件')}
  </section>`;
}

function ratesPage(): string {
  return `<section class="notice info"><strong>汇率全自动：</strong>生成报销候选时按订阅开始日当天自动抓取并锁定汇率（来源：frankfurter / ECB），每日 Cron 也会同步一次；抓取失败只记录失败状态，不填猜测汇率，无需人工补录。</section>
  <section class="surface">
    ${sectionHeading('汇率快照历史', '含来源、生效时间、状态和锁定时间。', '<button class="button secondary" type="button" data-action="sync-fx">立即同步</button>')}
    ${emptyCollection('rates', '汇率快照')}
  </section>`;
}

function peoplePage(onePass: boolean): string {
  return `<section class="surface">
    ${sectionHeading('权限边界', onePass ? '身份验证与应用访问由 OnePass 管理，业务角色由本系统维护。' : '角色决定可见范围和可执行动作；身份验证由 Cloudflare Access 完成，业务角色由 D1 维护。')}
    <div class="role-grid">
      <article><strong>系统管理员</strong><span>系统配置、用户与权限</span></article>
      <article><strong>资产管理员</strong><span>账号资产、订阅与来源映射</span></article>
      <article><strong>财务审核人</strong><span>报销审核、付款确认</span></article>
      <article><strong>付款者</strong><span>查看归属自己的报销批次</span></article>
      <article><strong>员工</strong><span>查看本人可见的账号和订阅</span></article>
      <article><strong>审计员</strong><span>只读审计、导入与汇率记录</span></article>
    </div>
  </section>
  <section class="${onePass ? '' : 'split-grid account-grid'}">
    ${onePass ? '' : `<article class="surface form-surface">
      ${sectionHeading('登录白名单', '通过 Cloudflare Access 登录且命中白名单的用户自动开通 employee 账号，无需审核。新邮箱/域名还需在 Access 企业应用 policy 中放行才能到达系统。')}
      <form data-api="login-whitelist" data-success="白名单规则已添加。">
        <div class="two-columns">
          <label>类型<select name="kind"><option value="domain">整个域名</option><option value="email">指定邮箱</option></select></label>
          <label>邮箱或域名<input name="value" required maxlength="255" placeholder="example.com 或 person@example.com" /></label>
        </div>
        <div class="form-actions"><button class="button primary" type="submit">添加规则</button></div>
      </form>
      ${emptyCollection('login-whitelist', '白名单规则')}
    </article>`}
    <article class="surface form-surface">
      ${sectionHeading('分配角色', '角色替换是明确操作；提交后以 D1 审计记录为准。')}
      <form data-api="user-roles" data-success="用户角色已更新。">
        <label>用户<select name="user_id" required data-options-from="users"><option value="">正在载入用户…</option></select></label>
        <label>角色（可多选）<select name="role_codes" multiple size="6" data-options-from="roles"></select></label>
        <div class="form-actions"><button class="button primary" type="submit">更新角色</button></div>
      </form>
    </article>
  </section>
  <section class="surface form-surface" id="user-edit-panel" hidden>
    ${sectionHeading('编辑用户', '修改姓名与在职状态；停用的用户保留历史归属，但不应再被分配新资产。')}
    <form data-api="user-edit" data-success="用户已更新。">
      <input type="hidden" name="user_id" />
      <div class="two-columns">
        <label>姓名<input name="display_name" required maxlength="80" /></label>
        <label>状态<select name="employment_status"><option value="active">在职</option><option value="inactive">停用</option></select></label>
      </div>
      <div class="form-actions">
        <button class="button primary" type="submit">保存修改</button>
        <button class="button secondary" type="button" data-action="cancel-edit-user">取消</button>
      </div>
    </form>
    <div class="action-result" id="user-edit-result" aria-live="polite"></div>
  </section>
  <section class="surface">
    ${sectionHeading('系统用户', onePass ? 'OnePass 成员与系统账号按稳定身份绑定，邮箱不能作为唯一安全凭据。' : '外部身份使用稳定 subject 绑定，邮箱不能作为唯一安全凭据。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('people', '系统用户')}
  </section>`;
}

const onePassLogout = (className: string) =>
  `<form method="post" action="/auth/onepass/logout"><button type="submit" class="${className}">登出</button></form>`;

function profilePage(options: UiShellOptions): string {
  const { onePass, managedMembers, memberManagementUrl } = options;
  if (onePass) {
    return `<section class="surface">
      ${sectionHeading('登录身份', managedMembers ? '登录、成员和角色由 OnePass 管理。' : '使用 OnePass 登录。报销权限由本系统的账号角色决定。')}
      <div class="form-actions">${managedMembers && memberManagementUrl
        ? `<a class="button primary" href="${escapeHtml(memberManagementUrl)}">前往 OnePass 管理成员</a>` : ''}${onePassLogout('button secondary')}</div>
    </section>`;
  }
  return `<section class="surface">
    ${sectionHeading('登录身份', '系统仅支持企业邮箱 OTP 登录（Cloudflare Access 一次性验证码）。每台设备完成验证后 30 天内无需重新登录。')}
    <div class="identity-list">
      <article class="identity-row corporate-identity">
        <div><strong>企业主身份</strong><span>通过企业入口 OTP 验证；如身份变更，请联系系统管理员进行离线恢复。</span></div>
        <span class="pill">企业身份</span>
      </article>
    </div>
  </section>
  <section class="surface">
    ${sectionHeading('会话与登出', '登出会撤销 Cloudflare Access 全局会话：所有设备都会要求重新验证。')}
    <div class="form-actions"><a class="button secondary" href="/logout">登出所有设备</a></div>
  </section>`;
}

function pageContent(page: UiPage, employeeOnly: boolean, canManageAccounts: boolean, options: UiShellOptions): string {
  switch (page) {
    case 'subscriptions':
      return subscriptionsPage(employeeOnly);
    case 'accounts':
      return accountsPage(canManageAccounts, employeeOnly);
    case 'reimbursements':
      return reimbursementsPage();
    case 'finance':
      return financePage();
    case 'rates':
      return ratesPage();
    case 'people':
      return peoplePage(options.onePass === true);
    case 'profile':
      return profilePage(options);
    default:
      return dashboardPage(employeeOnly);
  }
}

export function uiPageFromPath(pathname: string): UiPage {
  const match = NAV_ITEMS.find((item) => item.href === pathname);
  return match?.page ?? 'dashboard';
}

/**
 * 返回完整 HTML 文档。调用方可直接 `return c.html(renderAdminUi(...))`。
 */
export function renderAdminUi(options: UiShellOptions = {}): string {
  const employeeOnly = isEmployeeOnly(options.principal);
  const canManageAccounts = canManageAccountAssets(options.principal);
  const managedMembers = options.managedMembers === true;
  const requestedPage = managedMembers && options.page === 'people' ? 'profile' : options.page ?? 'dashboard';
  const financeDenied = requestedPage === 'finance' && !canViewFinance(options.principal);
  const page = (employeeOnly && !EMPLOYEE_PAGES.includes(requestedPage)) || financeDenied ? 'dashboard' : requestedPage;
  const meta = employeeOnly && page === 'dashboard'
    ? { ...PAGE_META.dashboard, description: '查看归属自己的订阅与账号资产。' }
    : PAGE_META[page];
  const userLabel = options.principal?.displayName?.trim() || '未识别用户';
  const roles = options.principal?.roles?.length ? options.principal.roles.join(' · ') : '未分配角色';
  const navigation = NAV_ITEMS.filter((item) => {
    if (managedMembers && item.page === 'people') return false;
    if (employeeOnly) return EMPLOYEE_PAGES.includes(item.page);
    if (item.page === 'finance') return canViewFinance(options.principal);
    return true;
  }).map((item) => {
    const selected = item.page === page;
    return `<a href="${item.href}" class="nav-item ${selected ? 'selected' : ''}" ${selected ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true">${item.icon}</span><span><strong>${item.label}</strong><small>${item.description}</small></span>
    </a>`;
  }).join('');
  const body = options.trustedBody ?? pageContent(page, employeeOnly, canManageAccounts, options);
  const {
    accountOperational: _managedAccountOperational,
    accountOwners: _managedAccountOwners,
    ...readOnlyManagedMemberApi
  } = MANAGED_MEMBER_UI_API_CONTRACT;
  const api = employeeOnly
    ? EMPLOYEE_UI_API_CONTRACT
    : managedMembers
      ? canManageAccounts ? MANAGED_MEMBER_UI_API_CONTRACT : readOnlyManagedMemberApi
      : canManageAccounts ? UI_API_CONTRACT : READ_ONLY_ACCOUNT_UI_API_CONTRACT;
  const boot = jsonForInlineScript({ page, roles: options.principal?.roles ?? [], api });

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(meta.title)} · 兰芯云朵行政</title>
  <style>${styles()}</style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar" aria-label="主导航">
      <a class="brand" href="/"><span class="brand-mark">L</span><span><strong>兰芯云朵</strong><small>行政 · 订阅资产</small></span></a>
      <nav>${navigation}</nav>
      <div class="source-badge"><span class="status-dot"></span><span>D1 独立账本<br /><small>数据不出域</small></span></div>
    </aside>
    <main class="main-content">
      <header class="topbar">
        <div><p class="eyebrow">${meta.eyebrow}</p><h1>${meta.title}</h1><p class="page-description">${meta.description}</p></div>
        <div class="topbar-side">
          <div class="identity" title="${managedMembers ? '角色由 OnePass 管理' : '角色由 D1 中的授权关系决定'}"><span class="avatar">${escapeHtml(userLabel.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(userLabel)}</strong><small>${escapeHtml(roles)}</small></span></div>
          ${options.onePass ? onePassLogout('logout-link') : '<a class="logout-link" href="/logout" title="经 Cloudflare Access 登出所有入口的会话">登出</a>'}
        </div>
      </header>
      <div class="page-content">${body}</div>
    </main>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script>window.__LAN_CLOUD_UI__ = ${boot};</script>
  <script>${clientScript(canManageAccounts, managedMembers)}</script>
</body>
</html>`;
}

/** A controlled corporate-entry response when Access did not yield a business principal. */
export function renderCorporateAccessRequiredUi(onePass = false, unmapped = false): string {
  if (onePass) {
    const content = unmapped
      ? `<p>当前 OnePass 组织身份没有可用的报销账号。请联系系统管理员，或登出后选择其他身份。</p>${onePassLogout('button secondary')}`
      : '<p>请选择已关联报销账号的组织身份。</p><a href="/auth/onepass">使用 OnePass 登录</a>';
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>登录 · 兰芯云朵行政</title></head>
<body><main><h1>登录兰芯云朵行政</h1>${content}</main></body></html>`;
  }
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>需要企业登录 · 兰芯云朵行政</title></head>
<body><main><h1>需要企业邮箱登录</h1><p>请使用 @lancloudtech.com 企业邮箱通过 Cloudflare Access OTP 验证后再访问系统。</p></main></body>
</html>`;
}

function styles(): string {
  return `
    :root { --ink:#172032; --muted:#697386; --line:#e7ebf1; --surface:#fff; --canvas:#f5f7fb; --brand:#3559e0; --brand-dark:#263fa5; --accent:#e8efff; --warn:#a86200; --warn-bg:#fff4df; --danger:#bf3a3a; --good:#1d7a55; --shadow:0 12px 30px rgba(30,47,80,.08); font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",-apple-system,BlinkMacSystemFont,sans-serif; }
    * { box-sizing:border-box; } body { margin:0; color:var(--ink); background:var(--canvas); font-size:14px; line-height:1.5; }
    [hidden] { display:none !important; }
    .app-shell { min-height:100vh; display:grid; grid-template-columns:250px minmax(0,1fr); align-items:start; }
    .sidebar { padding:22px 14px; background:#10182d; color:#e8eeff; display:flex; flex-direction:column; gap:25px; position:sticky; top:0; height:100vh; overflow-y:auto; scrollbar-width:thin; }
    .brand { color:#fff; text-decoration:none; display:flex; align-items:center; gap:10px; padding:0 8px; } .brand-mark { display:grid; place-items:center; height:33px; width:33px; border-radius:10px; background:linear-gradient(140deg,#7997ff,#4464ed); font-weight:800; } .brand strong,.brand small { display:block; } .brand small { color:#aab8df; font-size:11px; margin-top:1px; }
    nav { display:grid; gap:4px; } .nav-item { color:#aeb9d6; display:flex; align-items:center; gap:11px; padding:10px 10px; border-radius:10px; text-decoration:none; transition:.15s background,.15s color; } .nav-item:hover { background:#1c2949; color:#fff; } .nav-item.selected { background:#314aaf; color:#fff; } .nav-icon { width:20px; text-align:center; font-size:17px; } .nav-item strong,.nav-item small { display:block; } .nav-item strong { font-size:13px; } .nav-item small { font-size:10px; color:inherit; opacity:.68; }
    .source-badge { margin-top:auto; display:flex; gap:8px; padding:12px; border:1px solid #263658; border-radius:11px; background:#14203a; font-size:12px; color:#cfdbff; } .source-badge small { color:#91a3d3; } .status-dot { width:8px; height:8px; border-radius:50%; background:#63d49b; margin-top:5px; flex:none; }
    .main-content { min-width:0; padding:0 36px 40px; } .topbar { padding:32px 0 25px; display:flex; align-items:flex-start; justify-content:space-between; gap:20px; } .eyebrow { margin:0 0 4px; color:#4968ca; font-size:11px; font-weight:800; letter-spacing:.12em; } h1,h2,p { margin-top:0; } h1 { font-size:28px; line-height:1.2; letter-spacing:-.04em; margin-bottom:7px; } h2 { font-size:16px; margin-bottom:4px; letter-spacing:-.015em; } .page-description,.section-heading p { color:var(--muted); margin-bottom:0; }
    .identity { min-width:170px; display:flex; align-items:center; justify-content:flex-end; gap:9px; padding:8px 0; } .avatar { display:grid; place-items:center; width:32px; height:32px; border-radius:50%; background:#dce5ff; color:#2f4db6; font-weight:800; } .identity strong,.identity small { display:block; } .identity small { color:var(--muted); max-width:180px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:11px; }
    .topbar-side { display:flex; align-items:center; gap:14px; } .logout-link { flex:none; color:var(--muted); font-size:12px; text-decoration:none; border:1px solid var(--line); border-radius:8px; background:#fff; padding:7px 11px; } .logout-link:hover { color:var(--ink); border-color:#c3cbda; }
    .page-content { display:grid; gap:18px; max-width:1400px; min-width:0; } .surface { background:var(--surface); border:1px solid var(--line); border-radius:15px; box-shadow:var(--shadow); padding:20px; min-width:0; max-width:100%; } .split-grid > *, .account-grid > *, .metric-grid > * { min-width:0; } .metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; } .metric { min-height:118px; padding:16px; background:var(--surface); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); display:flex; flex-direction:column; } .metric p { color:var(--muted); margin:0 0 12px; font-size:12px; } .metric strong { font-size:26px; letter-spacing:-.03em; overflow-wrap:anywhere; } .metric small { margin-top:auto; color:var(--muted); font-size:11px; } .metric.accent { border-color:#c7d4ff; background:#fbfcff; } .metric.warning { border-color:#ffe2ac; background:#fffdfa; } .metric.neutral { background:#fafbfc; }
    .section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:16px; } .section-heading h2 { margin:0 0 4px; } .section-heading p { font-size:12px; } .action-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; } .action-card { min-height:135px; padding:16px; border:1px solid var(--line); border-radius:12px; color:inherit; text-decoration:none; background:#fbfcff; } .action-card:hover { border-color:#aebffc; transform:translateY(-1px); } .action-card span { color:#657dcf; font-size:11px; font-weight:800; } .action-card strong { display:block; margin:12px 0 4px; } .action-card p { color:var(--muted); font-size:12px; margin-bottom:0; }
    .split-grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr); gap:18px; } .account-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .form-surface form { display:grid; gap:12px; } label { display:grid; gap:5px; color:#404b61; font-size:12px; font-weight:700; } input,select,textarea { border:1px solid #ccd4e2; border-radius:8px; background:#fff; color:var(--ink); font:inherit; font-weight:400; padding:9px 10px; width:100%; outline:none; } input:focus,select:focus,textarea:focus { border-color:#6782e9; box-shadow:0 0 0 3px rgba(77,108,224,.13); } textarea { resize:vertical; } .two-columns { display:grid; grid-template-columns:1fr 1fr; gap:10px; } .form-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:3px; } .button:disabled { opacity:.65; cursor:not-allowed; transform:none; } .button.primary:disabled:hover { background:var(--brand); }
    .filter-bar { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin:0 0 12px; }
    .button { border:1px solid transparent; border-radius:8px; cursor:pointer; font:inherit; font-size:12px; font-weight:750; line-height:1; padding:10px 13px; transition:.15s transform,.15s background; } .button:hover { transform:translateY(-1px); } .button.primary { color:#fff; background:var(--brand); } .button.primary:hover { background:var(--brand-dark); } .button.secondary { color:#34446b; border-color:#cdd5e4; background:#fff; } .button.secondary:hover { background:#f3f5fa; } .button.danger { color:#fff; background:var(--danger); } .button.danger:hover { background:#9f2e2e; }
    .explain-card { background:linear-gradient(150deg,#fbfcff,#f2f5ff); } .explain-card p,.explain-card li { color:#57637a; } .explain-card ul,.explain-card ol { margin:14px 0 0; padding-left:18px; display:grid; gap:7px; font-size:12px; } .muted { color:var(--muted)!important; font-size:12px; } .notice { border-radius:11px; padding:13px 15px; font-size:13px; } .notice.info { color:#2d4eae; border:1px solid #cbd7ff; background:#edf2ff; } .notice.safety { color:#246343; border:1px solid #b9e5cc; background:#effaf4; }
    .data-panel { border:1px dashed #d3dae6; border-radius:10px; overflow:auto; min-height:102px; max-width:100%; } .empty-state { padding:26px 18px; display:grid; justify-items:start; gap:4px; color:#66738a; } .empty-state strong { color:#34415a; } .empty-state span { font-size:12px; } table { width:100%; border-collapse:collapse; min-width:580px; } th,td { padding:10px 12px; text-align:left; vertical-align:top; border-bottom:1px solid #edf0f5; font-size:12px; white-space:nowrap; } th { color:#697386; background:#f9fafc; font-weight:750; } td { color:#28354d; } td.cell-wrap { white-space:normal; min-width:200px; max-width:360px; word-break:break-word; } tr:last-child td { border-bottom:0; } .pill { display:inline-flex; border-radius:99px; padding:2px 7px; background:#edf1fb; color:#4960aa; font-size:11px; white-space:nowrap; }
    table.sticky-actions th:first-child, table.sticky-actions td:first-child { position:sticky; left:0; z-index:1; background:#fff; box-shadow:8px 0 10px -8px rgba(30,47,80,.22); } table.sticky-actions th:first-child { background:#f9fafc; }
    table.sticky-actions th:last-child, table.sticky-actions td:last-child { position:sticky; right:0; z-index:1; background:#fff; box-shadow:-8px 0 10px -8px rgba(30,47,80,.28); } table.sticky-actions th:last-child { background:#f9fafc; }
    .role-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; } .role-grid article { padding:13px; border:1px solid var(--line); border-radius:10px; background:#fcfcfe; } .role-grid strong,.role-grid span { display:block; } .role-grid span { color:var(--muted); font-size:11px; margin-top:4px; } .mapping-list { display:grid; gap:12px; margin:0; } .mapping-list div { padding-bottom:12px; border-bottom:1px solid var(--line); } .mapping-list div:last-child { padding-bottom:0; border:0; } .mapping-list dt { font-weight:750; } .mapping-list dd { margin:3px 0 0; color:var(--muted); font-size:12px; } .action-result { min-height:18px; color:#55627b; font-size:12px; } .action-result.error { color:var(--danger); } .action-result.success { color:var(--good); }
    .identity-list { display:grid; gap:9px; } .identity-row { align-items:center; background:#fbfcff; border:1px solid var(--line); border-radius:10px; display:flex; gap:14px; justify-content:space-between; padding:13px; } .identity-row > div { min-width:0; } .identity-row strong,.identity-row span { display:block; } .identity-row > div > span { color:var(--muted); font-size:12px; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .corporate-identity { border-color:#c7d4ff; background:#f7f9ff; }
    .toast { position:fixed; right:20px; bottom:20px; max-width:360px; transform:translateY(120px); opacity:0; transition:.2s; background:#19233b; color:#fff; padding:11px 13px; border-radius:9px; box-shadow:var(--shadow); font-size:12px; pointer-events:none; } .toast.show { transform:translateY(0); opacity:1; }
    .modal-overlay { position:fixed; inset:0; z-index:10; background:rgba(23,32,50,.45); display:flex; align-items:center; justify-content:center; padding:20px; } .modal-card { width:min(100%,420px); background:#fff; border-radius:14px; box-shadow:0 18px 50px rgba(23,32,50,.28); padding:22px; display:grid; gap:12px; } .modal-card h3 { margin:0; font-size:17px; letter-spacing:-.02em; }
    .chart-panel { min-height:120px; } .chart-axis { fill:#697386; font-size:10px; } .chart-value { fill:#28354d; font-size:10px; font-weight:700; } .pipeline-legend { display:flex; flex-wrap:wrap; gap:14px; margin-top:10px; font-size:12px; color:#55627b; } .pipeline-legend-item { display:inline-flex; align-items:center; gap:6px; } .pipeline-dot { display:inline-block; width:10px; height:10px; border-radius:3px; }
    @media (max-width:980px) { .app-shell { grid-template-columns:1fr; } .sidebar { position:sticky; top:0; z-index:3; padding:10px 16px; display:flex; flex-direction:row; align-items:center; overflow:auto; height:auto; } .brand { min-width:max-content; } .sidebar nav { display:flex; gap:3px; } .nav-item { min-width:max-content; padding:7px 9px; } .nav-item small { display:none; } .source-badge { display:none; } .main-content { padding:0 20px 28px; } .metric-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .split-grid, .account-grid { grid-template-columns:1fr; } }
    @media (max-width:640px) { .filter-bar { grid-template-columns:1fr; } }
    @media (max-width:640px) { .main-content { padding:0 14px 24px; } .topbar { padding:22px 0 18px; } .topbar .identity { display:none; } h1 { font-size:24px; } .metric-grid,.split-grid,.account-grid,.action-grid,.role-grid,.two-columns { grid-template-columns:1fr; } .surface { padding:16px; } .section-heading { display:grid; } .identity-row { align-items:flex-start; flex-direction:column; } }
  `;
}

function clientScript(canManageAccounts: boolean, managedMembers: boolean): string {
  return `
    (() => {
      const config = window.__LAN_CLOUD_UI__ || {};
      const api = config.api || {};
      const collectionEndpoints = {
        dashboard: api.dashboard,
        subscriptions: api.subscriptions,
        accounts: api.accountAssets,
        'reimbursement-candidates': api.reimbursementCandidates,
        'reimbursement-batches': api.reimbursementBatches,
        rates: api.fxQuotes,
        people: api.users,
        'login-whitelist': api.loginWhitelist,
        'audit-events': api.auditEvents
      };
      const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
      let toastTimer;
      const toast = (message) => {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
      };
      const apiError = async (response) => {
        let payload = null;
        try { payload = await response.json(); } catch (_) { /* non-JSON error is intentionally hidden */ }
        const message = payload && (
          (payload.error && typeof payload.error === 'object' && payload.error.message) ||
          payload.error || payload.message || payload.code
        );
        return message || ('请求失败（HTTP ' + response.status + '）');
      };
      const jsonRequest = async (url, options) => {
        const response = await fetch(url, Object.assign({ headers: { Accept: 'application/json' }, credentials: 'same-origin' }, options || {}));
        if (!response.ok) throw new Error(await apiError(response));
        const type = response.headers.get('content-type') || '';
        return type.includes('application/json') ? response.json() : {};
      };
      const recordsFrom = (payload) => {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== 'object') return [];
        for (const key of ['items', 'data', 'records', 'batches', 'candidates', 'results']) if (Array.isArray(payload[key])) return payload[key];
        return [];
      };
      const optionSources = {
        ${managedMembers ? (canManageAccounts ? `users: { url: () => api.accountOwners, value: 'id', label: (row) => String(row.display_name || '') },
        'active-users': { url: () => api.accountOwners + '?active=1', value: 'id', label: (row) => String(row.display_name || '') },` : '') : `
        users: { url: () => api.users, value: 'id', label: (row) => String(row.display_name || '') + (row.email ? ' · ' + row.email : '') },
        'active-users': { url: () => api.users, value: 'id', filter: (row) => row.employment_status === 'active', label: (row) => String(row.display_name || '') + (row.email ? ' · ' + row.email : '') },
        roles: { url: () => api.roles, value: 'code', label: (row) => String(row.display_name || '') + ' · ' + String(row.code || '') },`}
        ${canManageAccounts ? "'account-owners': { url: () => api.accountOwners, value: 'id', label: (row) => String(row.display_name || '') }," : ''}
        reviewers: { url: () => api.reimbursementReviewers, value: 'id', label: (row) => String(row.display_name || '') }
      };
      ${canManageAccounts ? `const applyPendingSelectValue = (select) => {
        if (select.dataset.pendingValue === undefined) return;
        const pendingValue = select.dataset.pendingValue;
        const isAvailable = Array.from(select.options).some((option) => option.value === pendingValue);
        select.dataset.ownerSelectionReady = isAvailable ? 'true' : 'false';
        if (isAvailable) select.value = pendingValue;
      };` : ''}
      const loadOptionSelects = async () => {
        const selects = Array.from(document.querySelectorAll('select[data-options-from]'));
        await Promise.all(selects.map(async (select) => {
          const source = optionSources[select.dataset.optionsFrom];
          if (!source || !source.url()) return;
          ${canManageAccounts ? "select.dataset.optionsLoaded = 'false';" : ''}
          try {
            const payload = await jsonRequest(source.url());
            const rows = recordsFrom(payload).filter(source.filter || (() => true));
            const options = [];
            if (!select.multiple) options.push('<option value="">' + (select.dataset.defaultLabel || (select.required ? '请选择…' : '不关联（可选）')) + '</option>');
            rows.forEach((row) => {
              const value = row && row[source.value];
              if (typeof value !== 'string' || !value) return;
              options.push('<option value="' + escapeHtml(value) + '">' + escapeHtml(source.label(row)) + '</option>');
            });
            select.innerHTML = options.join('') || '<option value="">暂无可选项</option>';
            ${canManageAccounts ? `select.dataset.optionsLoaded = 'true';
            applyPendingSelectValue(select);` : ''}
          } catch (_) {
            ${canManageAccounts ? `select.dataset.optionsLoaded = 'false';
            select.dataset.ownerSelectionReady = 'false';` : ''}
            select.innerHTML = '<option value="">列表载入失败</option>';
          }
        }));
      };
      const FIELD_LABELS = {
        name: '名称', display_name: '显示名称', status: '状态', owner_name: '归属人员', payer_name: '付款者',
        auto_renew: '是否自动续费', payment_method_masked: '付款方式', notes: '备注',
        term_effective_start: '订阅开始日期', term_effective_end: '订阅截止日期', billing_cycle: '订阅周期',
        settlement_mode: '结算方式', billing_anchor_date: '账单锚定日', original_currency: '订阅币种', amount_minor: '订阅总价',
        asset_identifier: '资产标识', account_identifier_masked: '账号标识', expires_on: '到期日', created_at: '创建时间',
        email: '邮箱', employment_status: '在职状态', roles: '角色',
        base_currency: '原币', quote_currency: '目标币', rate_numerator: '汇率分子', rate_denominator: '汇率分母',
        effective_at: '生效日期', fetched_at: '抓取时间', provider: '来源', provider_reference: '来源参考', locked_at: '锁定时间',
        coverage_start: '覆盖开始', coverage_end: '覆盖结束', original_amount_minor: '原币金额', cny_amount_fen: 'CNY 金额',
        action: '动作', entity_type: '对象类型', entity_id: '对象 ID', actor_name: '操作人', detail_json: '详情',
        mode: '模式', summary_json: '摘要', started_at: '开始时间', finished_at: '结束时间',
        connection_name: '来源连接', schema_status: '结构状态', kind: '类型', error_code: '错误码',
        platform: '平台', account_alias: '账号别名', account_masked: '账号标识', mfa_status: 'MFA 状态',
        active_from: '生效开始', active_until: '生效结束', subscription_name: '订阅项目', payer_display_name: '付款者',
        rate_locked: '锁定汇率', rate_display: '汇率', next_step: '下一步', paid_at: '付款日期', item_count: '明细数', cutoff_date: '报销截止日',
        actor_name: '提交人', reviewer_name: '审核人'
      };
      const HIDDEN_COLUMNS = new Set([
        'id', 'owner_user_id', 'payer_id', 'active_term_version_id', 'active_payer_assignment_id',
        'subscription_id', 'fx_quote_id', 'subscription_term_version_id', 'payer_assignment_id',
        'source_record_id', 'external_subject', 'vault_ref', 'raw_response_hash',
        'rate_numerator', 'rate_denominator', 'base_currency', 'submission_id'
      ]);
      // 订阅清单按多维表格 1:1 的列顺序展示；账号资产使用封闭列契约；其余集合按动态键补充。
      const COLLECTION_COLUMN_ORDER = {
        subscriptions: ['name', 'term_effective_start', 'term_effective_end', 'billing_cycle', 'original_currency', 'amount_minor', 'payer_name', 'owner_name', 'auto_renew', 'payment_method_masked', 'notes', 'status', 'settlement_mode', 'billing_anchor_date'],
        accounts: ['display_name', 'asset_identifier', 'account_identifier_masked', 'owner_name', 'status', 'expires_on', 'created_at'],
        rates: ['rate_display', 'effective_at', 'provider', 'status', 'fetched_at', 'locked_at', 'provider_reference'],
        'reimbursement-batches': ['payer_name', 'reviewer_name', 'actor_name', 'coverage_start', 'coverage_end', 'total_cny_fen', 'status', 'next_step', 'paid_at', 'created_at', 'item_count']
      };
      const COLLECTION_LABELS = {
        'reimbursement-batches': { name: '报销人' },
        subscriptions: { name: '订阅项目名称', owner_name: '使用者' }
      };
      const FX_ZERO_DECIMAL = ['JPY', 'KRW', 'VND'];
      const CURRENCY_ZH = { USD: '美元', EUR: '欧元', HKD: '港币', JPY: '日元', KRW: '韩元', GBP: '英镑', SGD: '新加坡元', CNY: '人民币' };
      // 汇率统一按“人民币-原币: 1:X”展示；存储仍是最小单位整数有理数，显示不涉及浮点金额。
      const decorateRateRow = (row) => {
        const digits = FX_ZERO_DECIMAL.includes(row.base_currency) ? 0 : 2;
        const perWholeUnit = (row.rate_numerator / row.rate_denominator) * (100 / 10 ** digits);
        const rounded = Math.round(perWholeUnit * 10000) / 10000;
        return Object.assign({}, row, { rate_display: '人民币-' + (CURRENCY_ZH[row.base_currency] || row.base_currency) + ': 1:' + rounded });
      };
      const NEXT_STEP_LABELS = {
        submitted: '等待财务审核',
        reviewing: '财务审核中',
        approved: '等待财务确认付款',
        paid: '已完成',
        returned: '已退回',
        void: '已作废'
      };
      const decorateRow = (collection, row) => {
        if (collection === 'rates') return decorateRateRow(row);
        if (collection === 'reimbursement-batches') {
          return Object.assign({}, row, { next_step: NEXT_STEP_LABELS[row.status] || '—' });
        }
        return row;
      };
      const CYCLE_LABELS = { monthly: '月付', quarterly: '季付', semi_annual: '半年付', yearly: '年付', one_time: '一次性' };
      const SETTLEMENT_LABELS = { actual_bill: '一次性结算', accrual: '按天摊销' };
      const STATUS_LABELS = {
        subscriptions: { active: '有效', paused: '暂停', ended: '已结束' },
        'reimbursement-candidates': { pending: '待报销', batched: '已入批', paid: '已付款', reversed: '已冲销' },
        'reimbursement-batches': { submitted: '待审核', reviewing: '审核中', approved: '待付款', paid: '已付款', reversed: '已冲销' },
        accounts: { active: '有效', inactive: '已停用', retired: '已退役' },
        rates: { verified: '已验证', stale: '已过期', manual: '人工补录', failed: '失败' },
        people: { active: '在职', inactive: '停用' }
      };
      const canReviewFinance = (config.roles || []).some((role) => ['system_admin', 'finance_reviewer'].includes(role));
      const canManageUsers = (config.roles || []).includes('system_admin');
      const canManageAccounts = (config.roles || []).some((role) => ['system_admin', 'asset_admin'].includes(role));
      const labelFor = (collection, key) => (COLLECTION_LABELS[collection] && COLLECTION_LABELS[collection][key]) || FIELD_LABELS[key] || key;
      const orderedKeys = (collection, keys) => {
        const order = COLLECTION_COLUMN_ORDER[collection];
        if (!order) return keys;
        if (collection === 'accounts') return order.filter((key) => keys.includes(key));
        const preferred = order.filter((key) => keys.includes(key));
        const extras = keys.filter((key) => !order.includes(key));
        return preferred.concat(extras);
      };
      const formatCell = (collection, key, value) => {
        if (key === 'term_effective_end' && (value == null || value === '')) return '持续';
        if (value == null || value === '') return '—';
        if (key === 'status' || key === 'employment_status') {
          const map = STATUS_LABELS[collection];
          if (map && map[value]) return map[value];
        }
        if (key === 'amount_minor' || key === 'original_amount_minor') return (Number(value) / 100).toFixed(2);
        if (key === 'cny_amount_fen' || key === 'total_cny_fen') return '¥' + (Number(value) / 100).toFixed(2);
        if (key === 'auto_renew') return Number(value) ? '是' : '否';
        if (key === 'billing_cycle') return CYCLE_LABELS[value] || value;
        if (key === 'settlement_mode') return SETTLEMENT_LABELS[value] || value;
        if (key === 'roles') return Array.isArray(value) ? value.join('、') : String(value);
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
      };
      const collectionRows = {};
      const subscriptionsFilterState = { status: 'active', owner: '', payer: '', q: '' };
      ${canManageAccounts ? "const accountsFilterState = { owner: '', asset: '', status: '', q: '' };" : ''}
      const WRAPPABLE_COLUMNS = new Set(['notes', 'detail_json', 'summary_json', 'account_identifier_masked']);
      const cellTag = (key, content) => '<td' + (WRAPPABLE_COLUMNS.has(key) ? ' class="cell-wrap"' : '') + '>' + content + '</td>';
      const renderRowsInto = (panel, rows, totalCount) => {
        const label = panel.dataset.label || '数据';
        if (!rows.length) {
          const hint = totalCount ? '当前筛选没有匹配记录。' : '数据导入、权限配置或接口启用后会显示在这里。';
          panel.innerHTML = '<div class="empty-state"><strong>暂无' + escapeHtml(label) + '</strong><span>' + hint + '</span></div>';
          return;
        }
        const displayRows = rows.map((row) => decorateRow(panel.dataset.collection, row));
        const keys = orderedKeys(panel.dataset.collection, Array.from(new Set(displayRows.flatMap((row) => Object.keys(row || {})))).filter((key) => !HIDDEN_COLUMNS.has(key)));
        if (!keys.length) return;
        const selectableCandidates = panel.dataset.collection === 'reimbursement-candidates';
        const editableSubscriptions = panel.dataset.collection === 'subscriptions' && Boolean(document.getElementById('subscription-edit-panel'));
        const financeBatchActions = panel.dataset.collection === 'reimbursement-batches' && canReviewFinance;
        const editablePeople = panel.dataset.collection === 'people' && canManageUsers && Boolean(document.getElementById('user-edit-panel'));
        const editableWhitelist = panel.dataset.collection === 'login-whitelist' && canManageUsers;
        ${canManageAccounts ? "const editableAccounts = panel.dataset.collection === 'accounts' && canManageAccounts && Boolean(document.getElementById('account-edit-panel'));" : 'const editableAccounts = false;'}
        const hasActions = editableSubscriptions || financeBatchActions || editablePeople || editableWhitelist || editableAccounts;
        const batchActionCell = (row) => {
          if (!row || typeof row.id !== 'string') return '<td>—</td>';
          if (row.status === 'submitted' || row.status === 'reviewing') {
            return '<td><button class="button secondary" type="button" data-action="approve-batch" data-batch-id="' + escapeHtml(row.id) + '">审核通过</button></td>';
          }
          if (row.status === 'approved') {
            return '<td><button class="button primary" type="button" data-action="mark-paid-batch" data-batch-id="' + escapeHtml(row.id) + '">确认付款</button></td>';
          }
          return '<td>—</td>';
        };
        const actionCell = (row) => {
          if (!row || typeof row.id !== 'string') return '<td>—</td>';
          if (editableSubscriptions) {
            return '<td><button class="button secondary" type="button" data-action="edit-subscription" data-subscription-id="' + escapeHtml(row.id) + '">编辑</button></td>';
          }
          if (financeBatchActions) return batchActionCell(row);
          if (editablePeople) {
            return '<td><button class="button secondary" type="button" data-action="edit-user" data-user-id="' + escapeHtml(row.id) + '">编辑</button></td>';
          }
          if (editableWhitelist) {
            return '<td><button class="button secondary" type="button" data-action="delete-whitelist-rule" data-rule-id="' + escapeHtml(row.id) + '">删除</button></td>';
          }
          ${canManageAccounts ? `if (editableAccounts) {
            return '<td><button class="button secondary" type="button" data-action="edit-account" data-account-id="' + escapeHtml(row.id) + '">编辑</button> <button class="button danger" type="button" data-action="delete-account" data-account-id="' + escapeHtml(row.id) + '" data-account-name="' + escapeHtml(String(row.display_name || '该账号资产')) + '">删除</button></td>';
          }` : ''}
          return '';
        };
        const head = (selectableCandidates ? '<th><input type="checkbox" data-action="toggle-all-candidates" aria-label="全选候选费用" title="全选/全不选" /></th>' : '') + keys.map((key) => '<th>' + escapeHtml(labelFor(panel.dataset.collection, key)) + '</th>').join('') + (hasActions ? '<th>操作</th>' : '');
        const body = displayRows.slice(0, 100).map((row, rowIndex) => '<tr>' + keys.map((key) => {
          return cellTag(key, escapeHtml(formatCell(panel.dataset.collection, key, row && row[key])));
        }).join('') + (hasActions ? actionCell(rows[rowIndex]) : '') + '</tr>').join('');
        const candidateBody = selectableCandidates ? displayRows.slice(0, 100).map((row) => {
          const id = row && row.id;
          const selectable = row && row.status === 'pending' && typeof id === 'string';
          const checkbox = selectable ? '<td><input type="checkbox" data-candidate-id="' + escapeHtml(id) + '" aria-label="选择候选费用" /></td>' : '<td>—</td>';
          return '<tr>' + checkbox + keys.map((key) => {
            return cellTag(key, escapeHtml(formatCell(panel.dataset.collection, key, row && row[key])));
          }).join('') + '</tr>';
        }).join('') : body;
        panel.innerHTML = '<table' + (hasActions ? ' class="sticky-actions"' : '') + '><thead><tr>' + head + '</tr></thead><tbody>' + candidateBody + '</tbody></table>';
      };
      const uniqueNamedOptions = (rows, idKey, nameKey) => {
        const seen = new Map();
        rows.forEach((row) => {
          const value = row && typeof row[idKey] === 'string' ? row[idKey] : '';
          const label = row && typeof row[nameKey] === 'string' ? row[nameKey].trim() : '';
          if (!value || seen.has(value)) return;
          seen.set(value, label || value);
        });
        return Array.from(seen.entries())
          .map(([value, label]) => ({ value, label }))
          .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
      };
      const fillFilterSelect = (attr, values, allLabel, currentValue) => {
        const select = document.querySelector('[data-subscriptions-filter="' + attr + '"]');
        if (!select) return '';
        select.innerHTML = '<option value="">' + allLabel + '</option>' + values
          .map((item) => '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</option>')
          .join('');
        if (values.some((item) => item.value === currentValue)) {
          select.value = currentValue;
          return currentValue;
        }
        return '';
      };
      const applySubscriptionsFilter = () => {
        const panel = document.querySelector('[data-collection="subscriptions"]');
        if (!panel) return;
        const all = collectionRows.subscriptions || [];
        const rows = all.filter((row) => {
          if (subscriptionsFilterState.status && row && row.status !== subscriptionsFilterState.status) return false;
          if (subscriptionsFilterState.owner && row && row.owner_user_id !== subscriptionsFilterState.owner) return false;
          if (subscriptionsFilterState.payer && row && row.payer_id !== subscriptionsFilterState.payer) return false;
          if (subscriptionsFilterState.q) {
            const hay = (
              String((row && row.name) || '') + ' ' +
              String((row && row.notes) || '') + ' ' +
              String((row && row.payment_method_masked) || '') + ' ' +
              String((row && row.owner_name) || '') + ' ' +
              String((row && row.payer_name) || '')
            ).toLowerCase();
            if (!hay.includes(subscriptionsFilterState.q.toLowerCase())) return false;
          }
          return true;
        });
        renderRowsInto(panel, rows, all.length);
      };
      ${canManageAccounts ? `const applyAccountsFilter = () => {
        const panel = document.querySelector('[data-collection="accounts"]');
        if (!panel) return;
        const all = collectionRows.accounts || [];
        const rows = all.filter((row) => {
          if (accountsFilterState.owner && row && row.owner_user_id !== accountsFilterState.owner) return false;
          if (accountsFilterState.asset && row && row.asset_identifier !== accountsFilterState.asset) return false;
          if (accountsFilterState.status && row && row.status !== accountsFilterState.status) return false;
          if (accountsFilterState.q) {
            const hay = (
              String((row && row.display_name) || '') + ' ' +
              String((row && row.asset_identifier) || '') + ' ' +
              String((row && row.account_identifier_masked) || '')
            ).toLowerCase();
            if (!hay.includes(accountsFilterState.q.toLowerCase())) return false;
          }
          return true;
        });
        renderRowsInto(panel, rows, all.length);
      };` : ''}
      const renderCollection = (panel, payload) => {
        const rows = recordsFrom(payload);
        collectionRows[panel.dataset.collection] = rows;
        if (panel.dataset.collection === 'subscriptions') {
          subscriptionsFilterState.owner = fillFilterSelect('owner', uniqueNamedOptions(rows, 'owner_user_id', 'owner_name'), '全部使用者', subscriptionsFilterState.owner);
          subscriptionsFilterState.payer = fillFilterSelect('payer', uniqueNamedOptions(rows, 'payer_id', 'payer_name'), '全部付款者', subscriptionsFilterState.payer);
          return applySubscriptionsFilter();
        }
        if (panel.dataset.collection === 'accounts') {
          ${canManageAccounts ? `
          const assetValues = Array.from(new Set(rows
            .map((row) => row && typeof row.asset_identifier === 'string' ? row.asset_identifier.trim() : '')
            .filter(Boolean)))
            .sort((left, right) => left.localeCompare(right, 'zh-CN'));
          const assetSelect = document.querySelector('[data-accounts-filter="' + 'asset' + '"]');
          if (assetSelect) {
            assetSelect.innerHTML = '<option value="">全部资产标识</option>' + assetValues
              .map((asset) => '<option value="' + escapeHtml(asset) + '">' + escapeHtml(asset) + '</option>')
              .join('');
            if (assetValues.includes(accountsFilterState.asset)) assetSelect.value = accountsFilterState.asset;
            else accountsFilterState.asset = '';
          }
          return applyAccountsFilter();` : `
          return renderRowsInto(panel, rows, rows.length);`}
        }
        renderRowsInto(panel, rows, rows.length);
      };
      const fen = (value) => '¥' + (Number(value || 0) / 100).toFixed(2);
      const updateDashboardMetrics = (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
        const lookup = {
          '待处理候选': data.pending_candidates,
          '待审报销批次': data.review_batches,
          '汇率异常': data.fx_exceptions,
          '我的订阅': data.owned_subscriptions,
          '我的账号资产': data.owned_account_assets,
        };
        if (data.my_pending_candidates) {
          lookup['我的待报销'] = fen(data.my_pending_candidates.total_cny_fen);
          lookup['进行中报销'] = fen(data.my_inflight_batches && data.my_inflight_batches.total_cny_fen);
          lookup['已报销（累计）'] = fen(data.my_paid_batches && data.my_paid_batches.total_cny_fen);
          lookup['待报销金额'] = fen(data.my_pending_candidates.total_cny_fen);
          lookup['待审核批次'] = String((data.my_inflight_batches && data.my_inflight_batches.count) ?? 0);
          lookup['进行中金额'] = fen(data.my_inflight_batches && data.my_inflight_batches.total_cny_fen);
          lookup['已付款金额（累计）'] = fen(data.my_paid_batches && data.my_paid_batches.total_cny_fen);
        } else {
          lookup['待报销金额'] = fen(data.pending_candidates && data.pending_candidates.total_cny_fen);
          lookup['待审核批次'] = String((data.review_batches && data.review_batches.count) ?? 0);
          lookup['进行中金额'] = fen(data.inflight_batches && data.inflight_batches.total_cny_fen);
          lookup['已付款金额（累计）'] = fen(data.paid_summary && data.paid_summary.total_cny_fen);
        }
        Object.entries(lookup).forEach(([label, value]) => {
          const el = document.querySelector('[data-metric="' + label + '"]');
          const display = value && typeof value === 'object' && 'count' in value ? value.count : value;
          if (el && display != null) el.textContent = String(display);
        });
      };
      const refreshCollection = async (panel) => {
        const url = collectionEndpoints[panel.dataset.collection];
        if (!url) return;
        try {
          const payload = await jsonRequest(url);
          renderCollection(panel, payload);
          if (panel.dataset.collection === 'dashboard') {
            updateDashboardMetrics(payload);
            renderDashboardCharts(payload);
          }
        } catch (error) {
          panel.innerHTML = '<div class="empty-state"><strong>暂时无法读取数据</strong><span>' + escapeHtml(error.message || '请检查登录、权限或 API 配置。') + '</span></div>';
        }
      };
      const renderDashboardCharts = (payload) => {
        const monthlyPanel = document.getElementById('dashboard-monthly-chart');
        const pipelinePanel = document.getElementById('dashboard-pipeline-chart');
        if (!monthlyPanel && !pipelinePanel) return;
        const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : {};
        const monthly = Array.isArray(data.monthly_paid) ? data.monthly_paid : [];
        if (monthlyPanel) {
          renderBarChart(monthlyPanel, monthly.map((point) => ({ label: String(point.month || '').slice(2), value: point.total_cny_fen || 0 })));
        }
        if (pipelinePanel) {
          renderPipelineChart(pipelinePanel, [
            { label: '待报销', value: (data.pending_candidates && data.pending_candidates.total_cny_fen) || 0, color: '#a86200' },
            { label: '进行中', value: (data.inflight_batches && data.inflight_batches.total_cny_fen) || 0, color: '#4968ca' },
            { label: '已付款（累计）', value: (data.paid_summary && data.paid_summary.total_cny_fen) || 0, color: '#1d7a55' },
          ]);
        }
      };
      const refreshAll = () => document.querySelectorAll('[data-collection]').forEach((panel) => { void refreshCollection(panel); });
      const setResult = (id, message, kind) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.className = 'action-result ' + (kind || '');
        el.textContent = message;
      };
      const candidateIds = () => Array.from(new Set(
        Array.from(document.querySelectorAll('[data-candidate-id]:checked')).map((input) => input.dataset.candidateId).filter(Boolean),
      ));
      const reimbursementPayload = () => ({ candidate_ids: candidateIds() });
      document.querySelectorAll('form[data-api]').forEach((form) => form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (form.dataset.submitting === 'true') return;
        form.dataset.submitting = 'true';
        const submitButtons = Array.from(form.querySelectorAll('button[type="submit"]'));
        const setSubmitBusy = (busy, label) => {
          submitButtons.forEach((button) => {
            if (busy) {
              if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
              button.disabled = true;
              button.textContent = label;
            } else {
              button.disabled = false;
              if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
            }
          });
        };
        const resultEl = form.querySelector('[data-form-result]');
        const setFormResult = (kind, message) => {
          if (!resultEl) return;
          resultEl.className = 'action-result ' + (kind || '');
          resultEl.textContent = message;
        };
        const endpointKey = form.dataset.api;
        const formData = new FormData(form);
        const values = Object.fromEntries(formData.entries());
        Object.keys(values).forEach((key) => { if (values[key] === '') delete values[key]; });
        try {
          let url = endpointKey === 'subscriptions' ? api.subscriptions
            ${canManageAccounts ? ": endpointKey === 'account-assets' ? api.accountAssets" : ''}
            : endpointKey === 'fx-quotes' ? api.fxQuotes
            : endpointKey === 'users' ? api.users
            : endpointKey === 'login-whitelist' ? api.loginWhitelist
            : null;
          let method = 'POST';
          let payload = values;
          if (endpointKey === 'user-edit') {
            const editUserId = values.user_id;
            if (!editUserId) throw new Error('缺少用户 ID。');
            url = api.userOperational.replace(':id', encodeURIComponent(editUserId));
            method = 'PUT';
            payload = { display_name: values.display_name, employment_status: values.employment_status };
          }
          ${canManageAccounts ? `if (endpointKey === 'account-operational') {
            const accountId = values.account_id;
            if (!accountId) throw new Error('缺少账号资产 ID。');
            url = api.accountOperational.replace(':id', encodeURIComponent(accountId));
            method = 'PUT';
            const ownerSelect = form.elements.owner_user_id;
            const includeOwner = ownerSelect.dataset.optionsLoaded === 'true'
              && ownerSelect.dataset.ownerSelectionReady === 'true';
            payload = {
              display_name: values.display_name,
              account_identifier: values.account_identifier,
              asset_identifier: values.asset_identifier,
              ...(includeOwner ? { owner_user_id: values.owner_user_id || null } : {}),
              status: values.status,
              expires_on: values.expires_on || null,
              vault_ref: values.vault_ref || null,
            };
          }` : ''}
          if (endpointKey === 'user-roles') {
            const userId = values.user_id;
            if (!userId) throw new Error('请选择用户。');
            url = api.users + '/' + encodeURIComponent(userId) + '/roles';
            method = 'PUT';
            values.role_codes = formData.getAll('role_codes').map(String).filter(Boolean);
            delete values.user_id;
          }
          if (endpointKey === 'subscriptions') {
            const amountText = typeof values.amount === 'string' ? values.amount.trim() : '';
            const termParts = [amountText, values.original_currency, values.billing_cycle, values.effective_start].map((value) => (typeof value === 'string' ? value.trim() : ''));
            const filled = termParts.filter((value) => value !== '').length;
            if (values.payer_id && filled === 0) throw new Error('关联付款者需要同时填写订阅总价、币种、周期和开始日期。');
            if (filled > 0) {
              if (filled < 4) throw new Error('订阅总价、币种、周期和开始日期需一起填写。');
              const major = Number(amountText);
              if (!Number.isFinite(major) || major < 0) throw new Error('订阅总价必须是非负数字。');
              values.term = {
                effective_start: values.effective_start,
                effective_end: values.term_effective_end || null,
                billing_cycle: values.billing_cycle,
                original_currency: String(values.original_currency).toUpperCase(),
                amount_minor: Math.round(major * 100),
              };
            }
            delete values.amount;
            delete values.original_currency;
            delete values.billing_cycle;
            delete values.effective_start;
            delete values.term_effective_end;
            payload = values;
          }
          if (endpointKey === 'subscription-operational') {
            const subscriptionId = values.subscription_id;
            if (!subscriptionId) throw new Error('缺少订阅 ID。');
            url = api.subscriptionOperational.replace(':id', encodeURIComponent(subscriptionId));
            method = 'PUT';
            const amountText = typeof values.amount === 'string' ? values.amount.trim() : '';
            const termFields = [amountText, values.original_currency, values.billing_cycle, values.effective_start].map((value) => (typeof value === 'string' ? value.trim() : ''));
            const filled = termFields.filter((value) => value !== '').length;
            let term;
            if (filled > 0) {
              if (filled < 4) throw new Error('价格、币种、周期和生效日期需一起填写。');
              const major = Number(amountText);
              if (!Number.isFinite(major) || major < 0) throw new Error('订阅总价必须是非负数字。');
              term = {
                effective_start: values.effective_start,
                billing_cycle: values.billing_cycle,
                original_currency: String(values.original_currency).toUpperCase(),
                amount_minor: Math.round(major * 100),
              };
            }
            payload = {
              auto_renew: values.auto_renew === 'true',
              owner_user_id: values.owner_user_id || null,
              payer_user_id: values.payer_user_id || null,
              payment_method_masked: values.payment_method_masked || null,
              notes: values.notes || null,
              term_effective_end: values.term_effective_end || null,
              ...(term ? { term } : {}),
            };
          }
          if (!url) {
            form.dataset.submitting = '';
            return toast('该表单尚未绑定 API。');
          }
          const pendingLabel = endpointKey === 'subscriptions' ? '正在创建…' : '正在保存…';
          const pendingToast = endpointKey === 'subscriptions' ? '正在创建订阅，请稍候…' : '正在保存，请稍候…';
          setSubmitBusy(true, pendingLabel);
          setFormResult('', pendingToast);
          toast(pendingToast);
          await jsonRequest(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
          form.reset();
          if (endpointKey === 'subscriptions') {
            const panel = document.getElementById('subscription-create-panel');
            const toggle = document.querySelector('[data-action="toggle-create-subscription"]');
            if (panel) panel.hidden = true;
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
          }
          if (endpointKey === 'subscription-operational') {
            const panel = document.getElementById('subscription-edit-panel');
            if (panel) panel.hidden = true;
          }
          const success = form.dataset.success || '已保存。';
          setFormResult('success', success);
          toast(success);
          refreshAll();
        } catch (error) {
          const message = error.message || '保存失败。';
          setFormResult('error', message);
          toast(message);
        } finally {
          form.dataset.submitting = '';
          setSubmitBusy(false);
        }
      }));
      document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'refresh') {
          if (config.page === 'reimbursements' && api.reimbursementGenerate) {
            try { await jsonRequest(api.reimbursementGenerate, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) { /* 生成失败不阻断刷新，Cron 每日兜底 */ }
          }
          if (config.page === 'finance') void loadFinanceOverview();
          return refreshAll();
        }
        if (action === 'toggle-create-subscription') {
          const panel = document.getElementById('subscription-create-panel');
          if (!panel) return;
          panel.hidden = !panel.hidden;
          button.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
          return;
        }
        ${canManageAccounts ? `if (action === 'toggle-create-account') {
          const panel = document.getElementById('account-create-panel');
          if (!panel) return;
          panel.hidden = !panel.hidden;
          button.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
          return;
        }` : ''}
        if (action === 'edit-subscription') {
          const panel = document.getElementById('subscription-edit-panel');
          const rows = collectionRows.subscriptions || [];
          const row = rows.find((candidate) => candidate && candidate.id === button.dataset.subscriptionId);
          if (!panel || !row) return;
          const form = panel.querySelector('form');
          form.elements.subscription_id.value = row.id;
          form.elements.name.value = row.name || '';
          form.elements.owner_user_id.value = row.owner_user_id || '';
          form.elements.payer_user_id.value = row.payer_owner_user_id || '';
          form.elements.amount.value = row.amount_minor == null || row.amount_minor === ''
            ? ''
            : (Number(row.amount_minor) / 100).toFixed(2);
          form.elements.original_currency.value = row.original_currency || '';
          form.elements.billing_cycle.value = row.billing_cycle || 'monthly';
          form.elements.effective_start.value = row.term_effective_start || '';
          form.elements.term_effective_end.value = row.term_effective_end || '';
          form.elements.auto_renew.value = row.auto_renew ? 'true' : 'false';
          form.elements.payment_method_masked.value = row.payment_method_masked || '';
          form.elements.notes.value = row.notes || '';
          panel.hidden = false;
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (action === 'cancel-edit-subscription') {
          const panel = document.getElementById('subscription-edit-panel');
          if (panel) {
            panel.hidden = true;
            const form = panel.querySelector('form');
            if (form) form.reset();
          }
          return;
        }
        if (action === 'edit-user') {
          const panel = document.getElementById('user-edit-panel');
          const rows = collectionRows.people || [];
          const row = rows.find((candidate) => candidate && candidate.id === button.dataset.userId);
          if (!panel || !row) return;
          const form = panel.querySelector('form');
          form.elements.user_id.value = row.id;
          form.elements.display_name.value = row.display_name || '';
          form.elements.employment_status.value = row.employment_status || 'active';
          panel.hidden = false;
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (action === 'cancel-edit-user') {
          const panel = document.getElementById('user-edit-panel');
          if (panel) {
            panel.hidden = true;
            const form = panel.querySelector('form');
            if (form) form.reset();
          }
          return;
        }
        ${canManageAccounts ? `if (action === 'edit-account') {
          const panel = document.getElementById('account-edit-panel');
          const rows = collectionRows.accounts || [];
          const row = rows.find((candidate) => candidate && candidate.id === button.dataset.accountId);
          if (!panel || !row) return;
          const form = panel.querySelector('form');
          form.elements.account_id.value = row.id;
          form.elements.display_name.value = row.display_name || '';
          form.elements.account_identifier.value = row.account_identifier_masked || '';
          form.elements.asset_identifier.value = row.asset_identifier || '';
          const ownerSelect = form.elements.owner_user_id;
          ownerSelect.dataset.pendingValue = row.owner_user_id || '';
          ownerSelect.dataset.ownerSelectionReady = 'false';
          if (ownerSelect.dataset.optionsLoaded === 'true') applyPendingSelectValue(ownerSelect);
          form.elements.status.value = row.status || 'active';
          form.elements.expires_on.value = row.expires_on || '';
          form.elements.vault_ref.value = row.vault_ref || '';
          panel.hidden = false;
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (action === 'cancel-edit-account') {
          const panel = document.getElementById('account-edit-panel');
          if (panel) {
            panel.hidden = true;
            const form = panel.querySelector('form');
            if (form) form.reset();
          }
          return;
        }
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
        }` : ''}
        if (action === 'delete-whitelist-rule') {
          const ruleId = button.dataset.ruleId;
          if (!ruleId) return;
          if (!window.confirm('确定删除该白名单规则？删除后命中该规则的用户将无法自动开户。')) return;
          button.disabled = true;
          try {
            await jsonRequest(api.loginWhitelistDelete.replace(':id', encodeURIComponent(ruleId)), { method: 'DELETE' });
            toast('白名单规则已删除。');
            refreshAll();
          } catch (error) {
            toast(error.message || '删除失败。');
            button.disabled = false;
          }
          return;
        }
        if (action === 'toggle-all-candidates') {
          const panel = button.closest('[data-collection]');
          if (!panel) return;
          panel.querySelectorAll('input[data-candidate-id]').forEach((checkbox) => { checkbox.checked = button.checked; });
          return;
        }
        if (action === 'approve-batch' || action === 'mark-paid-batch') {
          const batchId = button.dataset.batchId;
          if (!batchId) return;
          let url = api.reimbursementApprove.replace(':id', encodeURIComponent(batchId));
          let body = '{}';
          if (action === 'mark-paid-batch') {
            const today = new Date().toISOString().slice(0, 10);
            const paidAt = window.prompt('确认付款日期（YYYY-MM-DD）', today);
            if (paidAt === null) return;
            if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(paidAt.trim())) return toast('付款日期必须是 YYYY-MM-DD。');
            url = api.reimbursementMarkPaid.replace(':id', encodeURIComponent(batchId));
            body = JSON.stringify({ paid_at: paidAt.trim() });
          }
          button.disabled = true;
          try {
            await jsonRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            toast(action === 'approve-batch' ? '批次已审核通过。' : '批次已确认付款。');
            refreshAll();
          } catch (error) {
            toast(error.message || '操作失败。');
            button.disabled = false;
          }
          return;
        }
        if (action === 'create-reimbursement') {
          const payload = reimbursementPayload();
          if (!payload.candidate_ids.length) return setResult('reimbursement-result', '请先勾选要报销的候选费用。', 'error');
          const modal = document.getElementById('reviewer-modal');
          if (modal) modal.hidden = false;
          return;
        }
        if (action === 'cancel-reviewer') {
          const modal = document.getElementById('reviewer-modal');
          if (modal) modal.hidden = true;
          return;
        }
        if (action === 'confirm-reviewer') {
          const payload = reimbursementPayload();
          if (!payload.candidate_ids.length) {
            const modal = document.getElementById('reviewer-modal');
            if (modal) modal.hidden = true;
            return setResult('reimbursement-result', '候选已失效，请重新勾选。', 'error');
          }
          const reviewerId = document.getElementById('reviewer-modal-select')?.value;
          if (!reviewerId) return setResult('reviewer-modal-result', '请选择审批者。', 'error');
          payload.reviewer_user_id = reviewerId;
          const modal = document.getElementById('reviewer-modal');
          if (modal) modal.hidden = true;
          try {
            const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': crypto.randomUUID() };
            const result = await jsonRequest(api.reimbursementCreate, { method: 'POST', headers, body: JSON.stringify(payload) });
            const data = result.data && typeof result.data === 'object' ? result.data : result;
            const batches = data.batches || data.items || [];
            setResult('reimbursement-result', '报销已提交：' + (Array.isArray(batches) ? batches.length : 0) + ' 个付款者批次，等待审批者审核。', 'success');
            refreshAll();
          } catch (error) { setResult('reimbursement-result', error.message || '操作失败。', 'error'); }
          return;
        }
        if (action === 'sync-fx') {
          try { await jsonRequest(api.fxSync, { method: 'POST' }); toast('汇率同步任务已提交。'); refreshAll(); }
          catch (error) { toast(error.message || '汇率同步不可用。'); }
          return;
        }
        if (action === 'sync-fx') {
          try { await jsonRequest(api.fxSync, { method: 'POST' }); toast('汇率同步任务已提交。'); refreshAll(); }
          catch (error) { toast(error.message || '汇率同步不可用。'); }
          return;
        }
        if (action === 'preview-import') {
          importSchemaVersionId = null;
          const approveButton = document.querySelector('[data-action="approve-import-mapping"]');
          const applyButton = document.querySelector('[data-action="apply-import"]');
          if (approveButton) approveButton.disabled = true;
          if (applyButton) applyButton.disabled = true;
          try {
            const result = await jsonRequest(api.importPreview, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = result.data && typeof result.data === 'object' ? result.data : result;
            if (typeof data.schema_version_id === 'string') importSchemaVersionId = data.schema_version_id;
            if (importSchemaVersionId && data.requires_mapping_approval && approveButton) approveButton.disabled = false;
            if (importSchemaVersionId && !data.requires_mapping_approval && applyButton) applyButton.disabled = false;
            const summary = data.summary || data.message || (Array.isArray(data.tables) ? ('只读预览完成：' + data.tables.length + ' 张表，' + (data.requires_mapping_approval ? '请审批字段 ID 映射。' : '映射已审批，可执行正式导入。')) : '只读预览完成，请检查导入运行记录。');
            setResult('import-result', typeof summary === 'string' ? summary : JSON.stringify(summary), 'success');
            refreshAll();
          } catch (error) { setResult('import-result', error.message || '预览失败。', 'error'); }
          return;
        }
        if (action === 'approve-import-mapping') {
          if (!importSchemaVersionId) return setResult('import-result', '请先完成只读预览。', 'error');
          try {
            await jsonRequest(api.importApprove.replace(':id', encodeURIComponent(importSchemaVersionId)), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            setResult('import-result', '字段映射已审批，可以执行正式导入。', 'success');
            const applyButton = document.querySelector('[data-action="apply-import"]');
            if (applyButton) applyButton.disabled = false;
            button.disabled = true;
          } catch (error) { setResult('import-result', error.message || '审批失败。', 'error'); }
          return;
        }
        if (action === 'apply-import') {
          try {
            const result = await jsonRequest(api.importApply, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = result.data && typeof result.data === 'object' ? result.data : result;
            const s = data.summary || {};
            const text = '导入完成：新增人员 ' + (s.created_users || 0) + '、账号资产 ' + (s.created_accounts || 0) + '、订阅 ' + (s.created_subscriptions || 0) + '、付款者 ' + (s.created_payers || 0) + '；跳过未变 ' + (s.skipped_unchanged || 0) + ' 条、来源已变更 ' + (s.skipped_changed || 0) + ' 条、异常 ' + (s.error_count || 0) + ' 条。';
            setResult('import-result', text, s.error_count ? 'error' : 'success');
            refreshAll();
          } catch (error) { setResult('import-result', error.message || '导入失败。', 'error'); }
          return;
        }
      });
      const onSubscriptionsFilterChange = (event) => {
        const el = event.target.closest('[data-subscriptions-filter]');
        if (!el) return;
        subscriptionsFilterState[el.dataset.subscriptionsFilter] = el.value;
        applySubscriptionsFilter();
      };
      document.addEventListener('input', onSubscriptionsFilterChange);
      document.addEventListener('change', onSubscriptionsFilterChange);
      ${canManageAccounts ? `const onAccountsFilterChange = (event) => {
        const el = event.target.closest('[data-accounts-filter]');
        if (!el) return;
        accountsFilterState[el.dataset.accountsFilter] = el.value;
        applyAccountsFilter();
      };
      document.addEventListener('input', onAccountsFilterChange);
      document.addEventListener('change', (event) => {
        const ownerSelect = event.target.closest('form[data-api="account-operational"] select[data-options-from="account-owners"]');
        if (ownerSelect && ownerSelect.dataset.optionsLoaded === 'true') ownerSelect.dataset.ownerSelectionReady = 'true';
        onAccountsFilterChange(event);
      });` : ''}
      const renderBarChart = (container, series) => {
        const width = 720;
        const height = 210;
        const padTop = 18;
        const padBottom = 36;
        const padLeft = 8;
        const padRight = 8;
        const innerWidth = width - padLeft - padRight;
        const innerHeight = height - padTop - padBottom;
        const maxValue = Math.max(...series.map((point) => point.value), 1);
        const gap = 8;
        const barWidth = Math.max(10, Math.floor((innerWidth - gap * (series.length - 1)) / series.length));
        const totalWidth = barWidth * series.length + gap * (series.length - 1);
        const offsetX = padLeft + Math.max(0, (innerWidth - totalWidth) / 2);
        const parts = series.map((point, index) => {
          const barHeight = Math.round((point.value / maxValue) * innerHeight);
          const x = offsetX + index * (barWidth + gap);
          const y = padTop + innerHeight - barHeight;
          const amount = fen(point.value);
          return '<g>'
            + '<rect x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + Math.max(barHeight, point.value > 0 ? 2 : 0) + '" rx="4" fill="#3559e0"><title>' + escapeHtml(point.label + '：' + amount) + '</title></rect>'
            + (point.value > 0 ? '<text x="' + (x + barWidth / 2) + '" y="' + (y - 5) + '" text-anchor="middle" class="chart-value">' + escapeHtml(amount) + '</text>' : '')
            + '<text x="' + (x + barWidth / 2) + '" y="' + (height - 16) + '" text-anchor="middle" class="chart-axis">' + escapeHtml(point.label) + '</text>'
            + '</g>';
        });
        parts.push('<line x1="' + padLeft + '" y1="' + (padTop + innerHeight) + '" x2="' + (width - padRight) + '" y2="' + (padTop + innerHeight) + '" stroke="#d3dae6" />');
        container.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="近 12 个月已付款金额" style="width:100%">' + parts.join('') + '</svg>';
      };
      const renderPipelineChart = (container, parts) => {
        const total = parts.reduce((sum, part) => sum + part.value, 0);
        if (total <= 0) {
          container.innerHTML = '<div class="empty-state"><strong>暂无报销数据</strong><span>产生候选与批次后会显示管线分布。</span></div>';
          return;
        }
        const width = 720;
        const barHeight = 30;
        let offset = 0;
        const segments = parts.map((part) => {
          const x = offset;
          const segWidth = (part.value / total) * width;
          offset += segWidth;
          return '<rect x="' + x.toFixed(2) + '" y="0" width="' + Math.max(segWidth, 0).toFixed(2) + '" height="' + barHeight + '" fill="' + part.color + '"><title>' + escapeHtml(part.label + '：' + fen(part.value)) + '</title></rect>';
        });
        const legend = parts.map((part) =>
          '<span class="pipeline-legend-item"><span class="pipeline-dot" style="background:' + part.color + '"></span>' + escapeHtml(part.label) + ' ' + escapeHtml(fen(part.value)) + '</span>',
        );
        container.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + barHeight + '" role="img" aria-label="报销管线分布" style="width:100%;border-radius:8px;overflow:hidden">' + segments.join('') + '</svg><div class="pipeline-legend">' + legend.join('') + '</div>';
      };
      const loadFinanceOverview = async () => {
        const monthlyPanel = document.getElementById('finance-monthly-chart');
        const pipelinePanel = document.getElementById('finance-pipeline-chart');
        if (!monthlyPanel || !pipelinePanel || !api.financeOverview) return;
        try {
          const payload = await jsonRequest(api.financeOverview);
          const data = payload.data || {};
          const setMetric = (label, value) => {
            const el = document.querySelector('[data-metric="' + label + '"]');
            if (el) el.textContent = value;
          };
          setMetric('本财年已付款', fen(data.paid_year && data.paid_year.total_cny_fen));
          setMetric('本季度已付款', fen(data.paid_quarter && data.paid_quarter.total_cny_fen));
          setMetric('本月已付款', fen(data.paid_month && data.paid_month.total_cny_fen));
          setMetric('待报销金额', fen(data.pending_candidates && data.pending_candidates.total_cny_fen));
          const monthly = Array.isArray(data.monthly_paid) ? data.monthly_paid : [];
          renderBarChart(monthlyPanel, monthly.map((point) => ({ label: String(point.month || '').slice(2), value: point.total_cny_fen || 0 })));
          renderPipelineChart(pipelinePanel, [
            { label: '待报销', value: (data.pending_candidates && data.pending_candidates.total_cny_fen) || 0, color: '#a86200' },
            { label: '待审核', value: (data.review_batches && data.review_batches.total_cny_fen) || 0, color: '#4968ca' },
            { label: '待付款', value: (data.approved_batches && data.approved_batches.total_cny_fen) || 0, color: '#7c5ce0' },
            { label: '已付款（财年）', value: (data.paid_year && data.paid_year.total_cny_fen) || 0, color: '#1d7a55' },
          ]);
        } catch (error) {
          monthlyPanel.innerHTML = '<div class="empty-state"><strong>暂时无法读取财务总览</strong><span>' + escapeHtml(error.message || '') + '</span></div>';
          pipelinePanel.innerHTML = '';
        }
      };
      if (config.page === 'reimbursements' && api.dashboard) {
        void jsonRequest(api.dashboard).then(updateDashboardMetrics).catch(() => {});
      }
      if (config.page === 'finance') {
        void loadFinanceOverview();
      }
      void loadOptionSelects();
      refreshAll();
    })();
  `;
}
