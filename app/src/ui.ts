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
  'rates',
  'people',
  'imports',
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
  /**
   * 仅允许由本服务端生成的可信 HTML。业务数据请通过 JSON API 返回，避免把
   * 来自用户或飞书的数据直接拼入 HTML。
   */
  trustedBody?: string;
}

export const UI_API_CONTRACT = {
  identities: '/api/me/identities',
  beginIdentityLink: '/api/me/identities/link-transactions',
  resumableIdentityLinks: '/api/me/identities/link-transactions/recovery',
  confirmIdentityLink: '/api/me/identities/link-transactions/:id/confirm',
  revokeIdentity: '/api/me/identities/:id',
  presentExternalIdentity: '/api/external/identity-presentations',
  dashboard: '/api/dashboard',
  subscriptions: '/api/subscriptions',
  accountAssets: '/api/account-assets',
  accountFieldDefinitions: '/api/account-field-definitions',
  reimbursementCandidates: '/api/reimbursements/candidates',
  reimbursementGenerate: '/api/reimbursements/generate-candidates',
  reimbursementPreview: '/api/reimbursements/preview',
  reimbursementCreate: '/api/reimbursements/create-batches',
  reimbursementBatches: '/api/reimbursements/batches',
  fxQuotes: '/api/fx-quotes',
  fxSync: '/api/exchange-rates/sync',
  users: '/api/users',
  roles: '/api/roles',
  reimbursementAccounts: '/api/reimbursement-accounts',
  imports: '/api/imports',
  importPreview: '/api/imports/feishu/preview',
  auditEvents: '/api/audit-events',
} as const;

const EMPLOYEE_UI_API_CONTRACT = {
  identities: UI_API_CONTRACT.identities,
  beginIdentityLink: UI_API_CONTRACT.beginIdentityLink,
  resumableIdentityLinks: UI_API_CONTRACT.resumableIdentityLinks,
  confirmIdentityLink: UI_API_CONTRACT.confirmIdentityLink,
  revokeIdentity: UI_API_CONTRACT.revokeIdentity,
  dashboard: UI_API_CONTRACT.dashboard,
  subscriptions: UI_API_CONTRACT.subscriptions,
  accountAssets: UI_API_CONTRACT.accountAssets,
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
  { page: 'accounts', href: '/accounts', icon: '◇', label: '账号资产', description: '账号与可追加字段' },
  { page: 'reimbursements', href: '/reimbursements', icon: '￥', label: '报销中心', description: '候选、合单与付款' },
  { page: 'rates', href: '/rates', icon: '↗', label: '汇率', description: '快照与同步状态' },
  { page: 'people', href: '/people', icon: '◎', label: '人员与权限', description: '用户、角色与付款者' },
  { page: 'imports', href: '/imports', icon: '⇄', label: '导入与审计', description: '飞书只读导入血缘' },
  { page: 'profile', href: '/profile', icon: '◌', label: '个人设置', description: '登录身份与外部绑定' },
];

const PAGE_META: Record<UiPage, { title: string; eyebrow: string; description: string }> = {
  dashboard: {
    title: '管理总览',
    eyebrow: '兰芯云朵行政',
    description: '集中查看订阅资产、待报销费用、汇率与导入异常。',
  },
  subscriptions: {
    title: '订阅资产',
    eyebrow: 'SUBSCRIPTIONS',
    description: '维护订阅主体、版本化条款、付款者有效期与自动续费信息。',
  },
  accounts: {
    title: '账号资产',
    eyebrow: 'ACCOUNT ASSETS',
    description: '记录内部账号资产；可追加非财务关键字段，不保存密码或验证码。',
  },
  reimbursements: {
    title: '报销中心',
    eyebrow: 'REIMBURSEMENT',
    description: '批量选择候选费用后，系统按付款者自动拆分为报销批次。',
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
  imports: {
    title: '导入与审计',
    eyebrow: 'READ-ONLY SOURCE',
    description: '飞书多维表格仅作为只读来源，先预览和确认映射，再受控导入。',
  },
  profile: {
    title: '个人设置',
    eyebrow: 'IDENTITY SETTINGS',
    description: '管理企业主身份与已绑定的外部登录方式。',
  },
};

const EMPLOYEE_PAGES: UiPage[] = ['dashboard', 'subscriptions', 'accounts', 'profile'];

function isEmployeeOnly(principal: UiPrincipal | null | undefined): boolean {
  const roles = principal?.roles ?? [];
  return roles.includes('employee') && roles.every((role) => role === 'employee');
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

function employeeDashboardPage(): string {
  return `<section class="metric-grid employee-metric-grid">
    ${card('我的订阅', '—', '仅统计归属自己的订阅资产')}
    ${card('我的账号资产', '—', '仅统计归属自己的账号资产', 'accent')}
  </section>
  <section class="surface">
    ${sectionHeading('我的资产概览', '此页面只显示你被分配的订阅与账号资产。')}
    ${emptyCollection('dashboard', '个人概览')}
  </section>`;
}

function dashboardPage(employeeOnly = false): string {
  if (employeeOnly) return employeeDashboardPage();
  return `<section class="metric-grid">
    ${card('待处理候选', '—', '按截止日和上次连续已报销日期计算')}
    ${card('待审报销批次', '—', '一笔提交会按付款者拆分', 'accent')}
    ${card('汇率异常', '—', '仅显示缺失、过期或同步失败的快照', 'warning')}
    ${card('导入待确认', '—', '字段漂移或映射错误不会自动写入账本', 'neutral')}
  </section>
  <section class="surface">
    ${sectionHeading('今日操作', '从只读导入、账期计算到报销付款，关键状态均会留存审计记录。')}
    <div class="action-grid">
      <a class="action-card" href="/imports"><span>01</span><strong>预览飞书导入</strong><p>核对字段映射与新增、变更、异常记录。</p></a>
      <a class="action-card" href="/subscriptions"><span>02</span><strong>维护订阅条款</strong><p>修改价格或付款者时以新版本生效，不改历史账。</p></a>
      <a class="action-card" href="/reimbursements"><span>03</span><strong>生成报销草稿</strong><p>勾选候选费用，按付款者一键合单。</p></a>
    </div>
  </section>
  <section class="surface">
    ${sectionHeading('系统动态', '同步、金额锁定、付款确认和权限变更会写入审计日志。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('dashboard', '概览数据')}
  </section>`;
}

function subscriptionsPage(employeeOnly = false): string {
  if (employeeOnly) {
    return `<section class="surface">
      ${sectionHeading('订阅清单', '仅显示归属自己的订阅资产。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
      ${emptyCollection('subscriptions', '订阅')}
    </section>`;
  }
  return `<section class="split-grid">
    <article class="surface form-surface">
      ${sectionHeading('新增订阅', '新增后请创建一条版本化条款；价格、币种、周期不直接覆盖历史。')}
      <form data-api="subscriptions" data-success="订阅已创建。下一步请补充条款版本和付款者有效期。">
        <label>订阅名称<input name="name" required maxlength="120" placeholder="例如：团队协作工具" /></label>
        <label>供应商 ID（可选）<input name="vendor_id" maxlength="80" placeholder="从供应商列表选择后填入" /></label>
        <label>归属人员 ID（可选）<input name="owner_user_id" maxlength="80" /></label>
        <label>付款方式（脱敏，可选）<input name="payment_method_masked" maxlength="120" placeholder="例如：Visa **** 1234" /></label>
        <label>备注（可选）<textarea name="notes" rows="2" maxlength="2000" placeholder="不填写密码、卡号或验证码"></textarea></label>
        <label><span>自动续费</span><select name="auto_renew"><option value="false">否</option><option value="true">是</option></select></label>
        <div class="form-actions"><button class="button primary" type="submit">创建订阅</button></div>
      </form>
    </article>
    <article class="surface explain-card">
      <span class="eyebrow">规则</span>
      <h2>条款与付款者均有有效期</h2>
      <p>每一笔候选费用都会复制当时的价格、原币金额、汇率和付款者。历史报销不会因今天改价、换卡或换人而变动。</p>
      <ul>
        <li>周期：月付、季付、年付、一次性</li>
        <li>结算：实际账单或按天摊销</li>
        <li>续费：作为订阅属性记录并在到期前提醒</li>
      </ul>
    </article>
  </section>
  <section class="surface">
    ${sectionHeading('订阅清单', '可按状态、供应商和付款者筛选；原始导入数据保持可追溯。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('subscriptions', '订阅')}
  </section>`;
}

function accountsPage(employeeOnly = false): string {
  if (employeeOnly) {
    return `<section class="surface">
      ${sectionHeading('账号资产清单', '仅显示归属自己的账号资产。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
      ${emptyCollection('accounts', '账号资产')}
    </section>`;
  }
  return `<section class="split-grid account-grid">
    <article class="surface form-surface">
      ${sectionHeading('新增账号资产', '只录入必要的标识和脱敏信息；密钥、密码和验证码不进入本系统。')}
      <form data-api="account-assets" data-success="账号资产已创建。">
        <label>展示名称<input name="display_name" required maxlength="120" placeholder="例如：设计团队 Figma 账号" /></label>
        <label>账号标识（脱敏）<input name="account_identifier_masked" required maxlength="160" placeholder="例如：kai***@example.com" /></label>
        <label>归属人员 ID（可选）<input name="owner_user_id" maxlength="80" /></label>
        <label>供应商 ID（可选）<input name="vendor_id" maxlength="80" /></label>
        <label>到期日（可选）<input name="expires_on" type="date" /></label>
        <div class="form-actions"><button class="button primary" type="submit">创建账号资产</button></div>
      </form>
    </article>
    <article class="surface form-surface">
      ${sectionHeading('追加字段', '字段只能用于账号资产的非核心属性；金额、付款者和账期仍由固定账本字段管理。')}
      <form data-api="account-field-definitions" data-success="字段定义已创建，可在账号资产详情填写。">
        <label>字段名称<input name="label" required maxlength="60" placeholder="例如：GitHub 用户名" /></label>
        <label>字段键<input name="field_key" required maxlength="40" pattern="[a-z][a-z0-9_]*" placeholder="github_username" /></label>
        <label>字段类型<select name="field_type"><option value="text">文本</option><option value="integer">整数</option><option value="date">日期</option><option value="boolean">是/否</option><option value="select">单选</option></select></label>
        <label>选项（仅单选，逗号分隔）<input name="options" maxlength="300" placeholder="个人、团队、共享" /></label>
        <div class="form-actions"><button class="button primary" type="submit">新增字段</button></div>
      </form>
    </article>
  </section>
  <section class="surface">
    ${sectionHeading('账号资产清单', '可按人员、供应商、状态和到期日管理。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('accounts', '账号资产')}
  </section>`;
}

function reimbursementsPage(): string {
  return `<section class="notice info"><strong>合单规则：</strong>一次提交中的候选费用按付款者拆分为报销批次；不同币种先锁定汇率换算为 CNY 分后合计。</section>
  <section class="split-grid">
    <article class="surface form-surface">
      ${sectionHeading('批量报销', '在下方勾选候选费用（或粘贴 ID），先预览，再明确创建草稿。')}
      <label>候选费用 ID（可选，逗号分隔）<textarea id="candidate-ids" rows="5" placeholder="也可直接在下方列表勾选"></textarea></label>
      <label>报销截止日<input id="reimbursement-cutoff" type="date" /></label>
      <div class="form-actions">
        <button class="button secondary" type="button" data-action="generate-candidates">按截止日生成候选</button>
        <button class="button secondary" type="button" data-action="preview-reimbursement">预览合单</button>
        <button class="button primary" type="button" data-action="create-reimbursement">创建报销草稿</button>
      </div>
      <div class="action-result" id="reimbursement-result" aria-live="polite"></div>
    </article>
    <article class="surface explain-card">
      <span class="eyebrow">防重原则</span>
      <h2>上次报销日期不是手填总账</h2>
      <p>系统从已付款明细的连续覆盖期间推导“已报销截至日”。中间有缺口时，未来已付款项目也不会让水位越过缺口。</p>
      <ul>
        <li>候选金额、原币和汇率快照生成后即锁定</li>
        <li>每个候选只能有一条有效报销明细</li>
        <li>已付款批次不可编辑，修正需要冲销或调整明细</li>
      </ul>
    </article>
  </section>
  <section class="surface">
    ${sectionHeading('候选费用', '勾选前检查覆盖期间、付款者、汇率状态与附件。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('reimbursement-candidates', '报销候选')}
  </section>
  <section class="surface">
    ${sectionHeading('报销批次', '付款确认仅开放给具备财务权限的用户。')}
    ${emptyCollection('reimbursement-batches', '报销批次')}
  </section>`;
}

function ratesPage(): string {
  return `<section class="split-grid">
    <article class="surface form-surface">
      ${sectionHeading('补录汇率快照', '仅用于经过确认的人工汇率。系统按有理数保存，避免浮点误差。')}
      <form data-api="fx-quotes" data-success="汇率快照已提交。候选费用生成时会锁定此快照。">
        <div class="two-columns"><label>原币<select name="base_currency"><option>USD</option><option>EUR</option><option>HKD</option><option>JPY</option><option>CNY</option></select></label><label>生效时间<input name="effective_at" type="datetime-local" required /></label></div>
        <label>分子（CNY 分）<input name="rate_numerator" type="number" min="1" step="1" required placeholder="例如：720" /></label>
        <label>分母（原币最小单位）<input name="rate_denominator" type="number" min="1" step="1" required value="100" /></label>
        <label>来源说明<input name="provider" required maxlength="80" placeholder="例如：财务确认 / 汇率服务商" /></label>
        <div class="form-actions"><button class="button primary" type="submit">保存快照</button><button class="button secondary" type="button" data-action="sync-fx">尝试同步</button></div>
      </form>
    </article>
    <article class="surface explain-card">
      <span class="eyebrow">CRON</span>
      <h2>自动同步不等于伪造数据</h2>
      <p>每日 Cron 只有在配置了受信任的汇率服务后才会抓取数据。没有 provider 或请求失败时，系统记录失败状态，不填充猜测汇率。</p>
      <p class="muted">汇率定义：1 个原币最小单位 = 分子 / 分母 个 CNY 分。</p>
    </article>
  </section>
  <section class="surface">
    ${sectionHeading('汇率快照历史', '含来源、生效时间、状态和锁定时间。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('rates', '汇率快照')}
  </section>`;
}

function peoplePage(): string {
  return `<section class="surface">
    ${sectionHeading('权限边界', '角色决定可见范围和可执行动作；身份验证由 Cloudflare Access 完成，业务角色由 D1 维护。')}
    <div class="role-grid">
      <article><strong>系统管理员</strong><span>系统配置、用户与权限</span></article>
      <article><strong>资产管理员</strong><span>账号资产、订阅与来源映射</span></article>
      <article><strong>财务审核人</strong><span>报销审核、付款确认</span></article>
      <article><strong>付款者</strong><span>查看归属自己的报销批次</span></article>
      <article><strong>员工</strong><span>查看本人可见的账号和订阅</span></article>
      <article><strong>审计员</strong><span>只读审计、导入与汇率记录</span></article>
    </div>
  </section>
  <section class="split-grid account-grid">
    <article class="surface form-surface">
      ${sectionHeading('新增系统用户', '绑定 Cloudflare Access 的稳定 subject；不要把邮箱当作唯一身份。')}
      <form data-api="users" data-success="系统用户已创建，请再分配角色。">
        <label>Access subject<input name="external_subject" required maxlength="255" placeholder="来自 Cloudflare Access JWT 的 sub" /></label>
        <label>显示名称<input name="display_name" required maxlength="80" /></label>
        <label>邮箱（可选）<input name="email" type="email" maxlength="255" /></label>
        <div class="form-actions"><button class="button primary" type="submit">创建用户</button></div>
      </form>
    </article>
    <article class="surface form-surface">
      ${sectionHeading('分配角色', '角色替换是明确操作；提交后以 D1 审计记录为准。')}
      <form data-api="user-roles" data-success="用户角色已更新。">
        <label>用户 ID<input name="user_id" required maxlength="80" /></label>
        <label>角色代码（逗号分隔）<input name="role_codes" maxlength="200" placeholder="asset_admin,finance_reviewer" /></label>
        <div class="form-actions"><button class="button primary" type="submit">更新角色</button></div>
      </form>
    </article>
  </section>
  <section class="split-grid">
    <article class="surface form-surface">
      ${sectionHeading('报销系统账号', '只保存账号别名、脱敏标识与凭据库引用，不保存第三方平台密码。')}
      <form data-api="reimbursement-accounts" data-success="报销系统账号已保存。">
        <label>付款者 ID<input name="payer_id" required maxlength="80" /></label>
        <label>平台<input name="platform" required maxlength="80" placeholder="例如：企业报销平台" /></label>
        <label>账号别名<input name="account_alias" required maxlength="120" /></label>
        <label>账号标识（脱敏，可选）<input name="account_masked" maxlength="160" placeholder="finance***@example.com" /></label>
        <label>凭据库引用（可选）<input name="vault_ref" maxlength="255" placeholder="仅保存外部 vault 引用" /></label>
        <label>MFA 状态<select name="mfa_status"><option value="unknown">未知</option><option value="enabled">已启用</option><option value="disabled">未启用</option></select></label>
        <div class="form-actions"><button class="button primary" type="submit">保存报销账号</button></div>
      </form>
    </article>
    <article class="surface explain-card">
      <span class="eyebrow">安全边界</span>
      <h2>权限与凭据分离</h2>
      <p>Access 负责认证，D1 角色控制业务权限；报销平台实际凭据只保留在企业密码管理器中。本系统仅记录责任人、MFA 状态及可审计的凭据库引用。</p>
    </article>
  </section>
  <section class="surface">
    ${sectionHeading('系统用户', '外部身份使用稳定 subject 绑定，邮箱不能作为唯一安全凭据。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('people', '系统用户')}
  </section>`;
}

function importsPage(): string {
  return `<section class="notice safety"><strong>只读保障：</strong>此系统不向原飞书多维表格回写记录、字段、权限或视图。导入前先显示差异和映射错误。</section>
  <section class="split-grid">
    <article class="surface explain-card">
      <span class="eyebrow">SOURCE OF TRUTH</span>
      <h2>飞书 Base → 暂存 → D1</h2>
      <p>飞书是初始化与同步的数据来源；D1 才是独立系统的业务账本。每条导入记录保留来源表、record ID、版本和哈希，以便审计。</p>
      <ol>
        <li>读取字段结构和记录，不写回飞书</li>
        <li>比较已批准的字段映射与本次结构</li>
        <li>显示新增、变更、无效值和字段漂移</li>
        <li>管理员确认后，才执行受控 apply</li>
      </ol>
      <div class="form-actions"><button class="button primary" type="button" data-action="preview-import">开始只读预览</button></div>
      <div class="action-result" id="import-result" aria-live="polite"></div>
    </article>
    <article class="surface form-surface">
      ${sectionHeading('当前来源映射', '首期仅读取“人员账号、邮箱管理”和“资产订阅”两张原表。')}
      <dl class="mapping-list">
        <div><dt>人员账号、邮箱管理</dt><dd>人员、邮箱、手机号及各类内部账号 → 人员/账号资产和可追加字段（预览后确认）。</dd></div>
        <div><dt>资产订阅</dt><dd>订阅项目、订阅者、付款者、周期、币种、金额、开始日和续费信息 → 订阅与条款版本。</dd></div>
        <div><dt>发票与备注</dt><dd>附件元数据与备注进入审计/附件引用；文件本体可存 R2。</dd></div>
      </dl>
    </article>
  </section>
  <section class="surface">
    ${sectionHeading('导入运行记录', '预览、应用、结构漂移和失败均会留下运行记录。', '<button class="button secondary" type="button" data-action="refresh">刷新</button>')}
    ${emptyCollection('imports', '导入运行记录')}
  </section>
  <section class="surface">
    ${sectionHeading('审计事件', '不展示密码、Token、完整卡号或附件正文。')}
    ${emptyCollection('audit-events', '审计事件')}
  </section>`;
}

function profilePage(): string {
  return `<section class="surface identity-settings-card">
    ${sectionHeading('登录身份', '企业主身份用于完成外部登录方式的绑定、确认和撤销。外部身份不会按邮箱自动合并。')}
    <div class="identity-list" id="identity-list" aria-live="polite">
      <article class="identity-row corporate-identity">
        <div><strong>企业主身份（不可解绑）</strong><span>已通过企业入口验证；如身份变更，请联系系统管理员进行离线恢复。</span></div>
        <span class="pill">企业身份</span>
      </article>
      <div class="empty-state"><strong>正在读取已绑定登录方式</strong><span>只会显示脱敏后的外部身份信息。</span></div>
    </div>
  </section>
  <section class="surface">
    ${sectionHeading('待恢复的外部绑定', '页面刷新后不会重新显示绑定码。系统只保留你本人未完成绑定的状态、到期时间和脱敏身份；仅已收到外部身份的记录可以确认。')}
    <div class="identity-link-recovery" id="identity-link-recovery" aria-live="polite">
      <div class="empty-state"><strong>正在检查未完成的绑定</strong><span>不会显示绑定码、外部登录主体或完整邮箱。</span></div>
    </div>
  </section>
  <section class="surface">
    ${sectionHeading('绑定外部登录', '生成短时一次性绑定码后，请前往外部入口使用 Cloudflare 或 GitHub 登录。绑定码不会写入链接、日志或审计详情。')}
    <div class="identity-provider-grid">
      <article class="identity-provider" data-provider-card="cloudflare">
        <div><strong>Cloudflare</strong><span data-provider-status="cloudflare">正在检查绑定状态</span></div>
        <button class="button secondary" type="button" data-action="begin-identity-link" data-provider-label="Cloudflare">绑定 Cloudflare</button>
      </article>
      <article class="identity-provider" data-provider-card="github">
        <div><strong>GitHub</strong><span data-provider-status="github">正在检查绑定状态</span></div>
        <button class="button secondary" type="button" data-action="begin-identity-link" data-provider-label="GitHub">绑定 GitHub</button>
      </article>
    </div>
    <div class="action-result" id="identity-link-result" aria-live="polite"></div>
    <div class="identity-link-transaction" id="identity-link-transaction" aria-live="polite"></div>
  </section>`;
}

function pageContent(page: UiPage, employeeOnly: boolean): string {
  switch (page) {
    case 'subscriptions':
      return subscriptionsPage(employeeOnly);
    case 'accounts':
      return accountsPage(employeeOnly);
    case 'reimbursements':
      return reimbursementsPage();
    case 'rates':
      return ratesPage();
    case 'people':
      return peoplePage();
    case 'imports':
      return importsPage();
    case 'profile':
      return profilePage();
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
  const requestedPage = options.page ?? 'dashboard';
  const page = employeeOnly && !EMPLOYEE_PAGES.includes(requestedPage) ? 'dashboard' : requestedPage;
  const meta = employeeOnly && page === 'dashboard'
    ? { ...PAGE_META.dashboard, description: '查看归属自己的订阅与账号资产。' }
    : PAGE_META[page];
  const userLabel = options.principal?.displayName?.trim() || '未识别用户';
  const roles = options.principal?.roles?.length ? options.principal.roles.join(' · ') : '未分配角色';
  const navigation = NAV_ITEMS.filter((item) => !employeeOnly || EMPLOYEE_PAGES.includes(item.page)).map((item) => {
    const selected = item.page === page;
    return `<a href="${item.href}" class="nav-item ${selected ? 'selected' : ''}" ${selected ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true">${item.icon}</span><span><strong>${item.label}</strong><small>${item.description}</small></span>
    </a>`;
  }).join('');
  const body = options.trustedBody ?? pageContent(page, employeeOnly);
  const boot = jsonForInlineScript({ page, api: employeeOnly ? EMPLOYEE_UI_API_CONTRACT : UI_API_CONTRACT });

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
      <div class="source-badge"><span class="status-dot"></span><span>飞书来源只读<br /><small>D1 独立账本</small></span></div>
    </aside>
    <main class="main-content">
      <header class="topbar">
        <div><p class="eyebrow">${meta.eyebrow}</p><h1>${meta.title}</h1><p class="page-description">${meta.description}</p></div>
        <div class="identity" title="角色由 D1 中的授权关系决定"><span class="avatar">${escapeHtml(userLabel.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(userLabel)}</strong><small>${escapeHtml(roles)}</small></span></div>
      </header>
      <div class="page-content">${body}</div>
    </main>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script>window.__LAN_CLOUD_UI__ = ${boot};</script>
  <script>${clientScript()}</script>
</body>
</html>`;
}

/**
 * 外部入口不携带业务 shell、身份邮箱或账户存在性信息。未绑定的 Access
 * 身份只能在这里提交由企业主身份生成的一次性绑定码。
 */
export function renderExternalIdentityUi(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>外部登录绑定 · 兰芯云朵行政</title>
  <style>
    :root { color:#172032; background:#f5f7fb; font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
    * { box-sizing:border-box; } body { min-height:100vh; margin:0; display:grid; place-items:center; padding:24px; }
    main { width:min(100%,480px); background:#fff; border:1px solid #e7ebf1; border-radius:16px; box-shadow:0 12px 30px rgba(30,47,80,.08); padding:28px; }
    .eyebrow { color:#4968ca; font-size:11px; font-weight:800; letter-spacing:.12em; margin:0 0 6px; } h1 { font-size:25px; margin:0 0 10px; letter-spacing:-.03em; } p { color:#697386; font-size:14px; line-height:1.65; margin:0 0 20px; }
    form { display:grid; gap:10px; } label { color:#404b61; display:grid; font-size:12px; font-weight:700; gap:5px; } input { border:1px solid #ccd4e2; border-radius:8px; font:inherit; padding:10px; width:100%; } input:focus { border-color:#6782e9; box-shadow:0 0 0 3px rgba(77,108,224,.13); outline:0; }
    button { background:#3559e0; border:0; border-radius:8px; color:#fff; cursor:pointer; font:inherit; font-size:13px; font-weight:750; padding:11px 14px; } button:disabled { cursor:wait; opacity:.7; }
    #external-binding-result { color:#55627b; font-size:12px; min-height:18px; margin-top:14px; } #external-binding-result.error { color:#bf3a3a; } #external-binding-result.success { color:#1d7a55; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">EXTERNAL IDENTITY LINK</p>
    <h1>输入绑定码</h1>
    <p>请先在企业入口的“个人设置”生成绑定码，再在此处提交。提交后请返回企业入口完成明确确认。</p>
    <form id="external-binding-form">
      <label for="external-binding-code">绑定码<input id="external-binding-code" name="code" type="password" autocomplete="one-time-code" required maxlength="64" /></label>
      <button type="submit">提交绑定码</button>
    </form>
    <div id="external-binding-result" aria-live="polite"></div>
  </main>
  <script>
    (() => {
      const form = document.getElementById('external-binding-form');
      const result = document.getElementById('external-binding-result');
      const setResult = (message, kind) => {
        result.className = kind || '';
        result.textContent = message;
      };
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        const code = String(new FormData(form).get('code') || '').trim();
        if (!code) return setResult('请输入绑定码。', 'error');
        submit.disabled = true;
        try {
          const response = await fetch('${UI_API_CONTRACT.presentExternalIdentity}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ code })
          });
          if (response.status === 401) {
            setResult('请先完成外部 Access 登录后重试。', 'error');
            return;
          }
          if (!response.ok) throw new Error('rejected');
          form.reset();
          setResult('绑定请求已接收。请返回企业入口完成确认。', 'success');
        } catch (_) {
          setResult('绑定请求未被接受。请确认绑定码仍有效后重试。', 'error');
        } finally {
          submit.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;
}

/** A data-free fallback when Cloudflare Access did not provide an external identity. */
export function renderExternalAccessRequiredUi(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>需要外部 Access 登录 · 兰芯云朵行政</title>
  <style>
    :root { color:#172032; background:#f5f7fb; font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
    * { box-sizing:border-box; } body { min-height:100vh; margin:0; display:grid; place-items:center; padding:24px; }
    main { width:min(100%,480px); background:#fff; border:1px solid #e7ebf1; border-radius:16px; box-shadow:0 12px 30px rgba(30,47,80,.08); padding:28px; }
    .eyebrow { color:#4968ca; font-size:11px; font-weight:800; letter-spacing:.12em; margin:0 0 6px; } h1 { font-size:25px; margin:0 0 10px; letter-spacing:-.03em; } p { color:#697386; font-size:14px; line-height:1.65; margin:0; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">EXTERNAL ACCESS REQUIRED</p>
    <h1>需要外部 Access 登录</h1>
    <p>请先完成外部 Access 登录，然后返回此页面继续绑定。</p>
  </main>
</body>
</html>`;
}

/** A controlled corporate-entry response when Access did not yield a business principal. */
export function renderCorporateAccessRequiredUi(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>需要企业登录 · 兰芯云朵行政</title></head>
<body><main><h1>需要企业邮箱登录</h1><p>请使用 @lancloudtech.com 企业账号通过 Cloudflare Access 登录后再访问系统。</p></main></body>
</html>`;
}

function styles(): string {
  return `
    :root { --ink:#172032; --muted:#697386; --line:#e7ebf1; --surface:#fff; --canvas:#f5f7fb; --brand:#3559e0; --brand-dark:#263fa5; --accent:#e8efff; --warn:#a86200; --warn-bg:#fff4df; --danger:#bf3a3a; --good:#1d7a55; --shadow:0 12px 30px rgba(30,47,80,.08); font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
    * { box-sizing:border-box; } body { margin:0; color:var(--ink); background:var(--canvas); font-size:14px; line-height:1.5; }
    .app-shell { min-height:100vh; display:grid; grid-template-columns:250px minmax(0,1fr); }
    .sidebar { padding:22px 14px; background:#10182d; color:#e8eeff; display:flex; flex-direction:column; gap:25px; }
    .brand { color:#fff; text-decoration:none; display:flex; align-items:center; gap:10px; padding:0 8px; } .brand-mark { display:grid; place-items:center; height:33px; width:33px; border-radius:10px; background:linear-gradient(140deg,#7997ff,#4464ed); font-weight:800; } .brand strong,.brand small { display:block; } .brand small { color:#aab8df; font-size:11px; margin-top:1px; }
    nav { display:grid; gap:4px; } .nav-item { color:#aeb9d6; display:flex; align-items:center; gap:11px; padding:10px 10px; border-radius:10px; text-decoration:none; transition:.15s background,.15s color; } .nav-item:hover { background:#1c2949; color:#fff; } .nav-item.selected { background:#314aaf; color:#fff; } .nav-icon { width:20px; text-align:center; font-size:17px; } .nav-item strong,.nav-item small { display:block; } .nav-item strong { font-size:13px; } .nav-item small { font-size:10px; color:inherit; opacity:.68; }
    .source-badge { margin-top:auto; display:flex; gap:8px; padding:12px; border:1px solid #263658; border-radius:11px; background:#14203a; font-size:12px; color:#cfdbff; } .source-badge small { color:#91a3d3; } .status-dot { width:8px; height:8px; border-radius:50%; background:#63d49b; margin-top:5px; flex:none; }
    .main-content { min-width:0; padding:0 36px 40px; } .topbar { padding:32px 0 25px; display:flex; align-items:flex-start; justify-content:space-between; gap:20px; } .eyebrow { margin:0 0 4px; color:#4968ca; font-size:11px; font-weight:800; letter-spacing:.12em; } h1,h2,p { margin-top:0; } h1 { font-size:28px; line-height:1.2; letter-spacing:-.04em; margin-bottom:7px; } h2 { font-size:16px; margin-bottom:4px; letter-spacing:-.015em; } .page-description,.section-heading p { color:var(--muted); margin-bottom:0; }
    .identity { min-width:170px; display:flex; align-items:center; justify-content:flex-end; gap:9px; padding:8px 0; } .avatar { display:grid; place-items:center; width:32px; height:32px; border-radius:50%; background:#dce5ff; color:#2f4db6; font-weight:800; } .identity strong,.identity small { display:block; } .identity small { color:var(--muted); max-width:180px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:11px; }
    .page-content { display:grid; gap:18px; max-width:1400px; } .surface { background:var(--surface); border:1px solid var(--line); border-radius:15px; box-shadow:var(--shadow); padding:20px; } .metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; } .metric { min-height:118px; padding:16px; background:var(--surface); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); display:flex; flex-direction:column; } .metric p { color:var(--muted); margin:0 0 12px; font-size:12px; } .metric strong { font-size:28px; letter-spacing:-.04em; } .metric small { margin-top:auto; color:var(--muted); font-size:11px; } .metric.accent { border-color:#c7d4ff; background:#fbfcff; } .metric.warning { border-color:#ffe2ac; background:#fffdfa; } .metric.neutral { background:#fafbfc; }
    .section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:16px; } .section-heading h2 { margin:0 0 4px; } .section-heading p { font-size:12px; } .action-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; } .action-card { min-height:135px; padding:16px; border:1px solid var(--line); border-radius:12px; color:inherit; text-decoration:none; background:#fbfcff; } .action-card:hover { border-color:#aebffc; transform:translateY(-1px); } .action-card span { color:#657dcf; font-size:11px; font-weight:800; } .action-card strong { display:block; margin:12px 0 4px; } .action-card p { color:var(--muted); font-size:12px; margin-bottom:0; }
    .split-grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr); gap:18px; } .account-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .form-surface form { display:grid; gap:12px; } label { display:grid; gap:5px; color:#404b61; font-size:12px; font-weight:700; } input,select,textarea { border:1px solid #ccd4e2; border-radius:8px; background:#fff; color:var(--ink); font:inherit; font-weight:400; padding:9px 10px; width:100%; outline:none; } input:focus,select:focus,textarea:focus { border-color:#6782e9; box-shadow:0 0 0 3px rgba(77,108,224,.13); } textarea { resize:vertical; } .two-columns { display:grid; grid-template-columns:1fr 1fr; gap:10px; } .form-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:3px; }
    .button { border:1px solid transparent; border-radius:8px; cursor:pointer; font:inherit; font-size:12px; font-weight:750; line-height:1; padding:10px 13px; transition:.15s transform,.15s background; } .button:hover { transform:translateY(-1px); } .button.primary { color:#fff; background:var(--brand); } .button.primary:hover { background:var(--brand-dark); } .button.secondary { color:#34446b; border-color:#cdd5e4; background:#fff; } .button.secondary:hover { background:#f3f5fa; }
    .explain-card { background:linear-gradient(150deg,#fbfcff,#f2f5ff); } .explain-card p,.explain-card li { color:#57637a; } .explain-card ul,.explain-card ol { margin:14px 0 0; padding-left:18px; display:grid; gap:7px; font-size:12px; } .muted { color:var(--muted)!important; font-size:12px; } .notice { border-radius:11px; padding:13px 15px; font-size:13px; } .notice.info { color:#2d4eae; border:1px solid #cbd7ff; background:#edf2ff; } .notice.safety { color:#246343; border:1px solid #b9e5cc; background:#effaf4; }
    .data-panel { border:1px dashed #d3dae6; border-radius:10px; overflow:auto; min-height:102px; } .empty-state { padding:26px 18px; display:grid; justify-items:start; gap:4px; color:#66738a; } .empty-state strong { color:#34415a; } .empty-state span { font-size:12px; } table { width:100%; border-collapse:collapse; min-width:580px; } th,td { padding:10px 12px; text-align:left; vertical-align:top; border-bottom:1px solid #edf0f5; font-size:12px; } th { color:#697386; background:#f9fafc; font-weight:750; white-space:nowrap; } td { color:#28354d; word-break:break-word; } tr:last-child td { border-bottom:0; } .pill { display:inline-flex; border-radius:99px; padding:2px 7px; background:#edf1fb; color:#4960aa; font-size:11px; white-space:nowrap; }
    .role-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; } .role-grid article { padding:13px; border:1px solid var(--line); border-radius:10px; background:#fcfcfe; } .role-grid strong,.role-grid span { display:block; } .role-grid span { color:var(--muted); font-size:11px; margin-top:4px; } .mapping-list { display:grid; gap:12px; margin:0; } .mapping-list div { padding-bottom:12px; border-bottom:1px solid var(--line); } .mapping-list div:last-child { padding-bottom:0; border:0; } .mapping-list dt { font-weight:750; } .mapping-list dd { margin:3px 0 0; color:var(--muted); font-size:12px; } .action-result { min-height:18px; color:#55627b; font-size:12px; } .action-result.error { color:var(--danger); } .action-result.success { color:var(--good); }
    .identity-list,.identity-link-recovery { display:grid; gap:9px; } .identity-row,.identity-provider { align-items:center; background:#fbfcff; border:1px solid var(--line); border-radius:10px; display:flex; gap:14px; justify-content:space-between; padding:13px; } .identity-row > div,.identity-provider > div { min-width:0; } .identity-row strong,.identity-row span,.identity-provider strong,.identity-provider span { display:block; } .identity-row > div > span,.identity-provider > div > span { color:var(--muted); font-size:12px; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .corporate-identity { border-color:#c7d4ff; background:#f7f9ff; } .identity-provider-grid { display:grid; gap:10px; grid-template-columns:repeat(2,minmax(0,1fr)); } .identity-link-transaction { display:grid; gap:8px; margin-top:14px; } .identity-link-transaction p { color:var(--muted); font-size:12px; margin:0; overflow-wrap:anywhere; }
    .toast { position:fixed; right:20px; bottom:20px; max-width:360px; transform:translateY(120px); opacity:0; transition:.2s; background:#19233b; color:#fff; padding:11px 13px; border-radius:9px; box-shadow:var(--shadow); font-size:12px; pointer-events:none; } .toast.show { transform:translateY(0); opacity:1; }
    @media (max-width:980px) { .app-shell { grid-template-columns:1fr; } .sidebar { position:sticky; top:0; z-index:3; padding:10px 16px; display:flex; flex-direction:row; align-items:center; overflow:auto; } .brand { min-width:max-content; } .sidebar nav { display:flex; gap:3px; } .nav-item { min-width:max-content; padding:7px 9px; } .nav-item small { display:none; } .source-badge { display:none; } .main-content { padding:0 20px 28px; } .metric-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:640px) { .main-content { padding:0 14px 24px; } .topbar { padding:22px 0 18px; } .topbar .identity { display:none; } h1 { font-size:24px; } .metric-grid,.split-grid,.account-grid,.action-grid,.role-grid,.two-columns,.identity-provider-grid { grid-template-columns:1fr; } .surface { padding:16px; } .section-heading { display:grid; } .identity-row,.identity-provider { align-items:flex-start; flex-direction:column; } }
  `;
}

function clientScript(): string {
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
        imports: api.imports,
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
      const renderCollection = (panel, payload) => {
        const rows = recordsFrom(payload);
        const label = panel.dataset.label || '数据';
        if (!rows.length) {
          panel.innerHTML = '<div class="empty-state"><strong>暂无' + escapeHtml(label) + '</strong><span>数据导入、权限配置或接口启用后会显示在这里。</span></div>';
          return;
        }
        const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row || {})))).slice(0, 8);
        if (!keys.length) return;
        const selectableCandidates = panel.dataset.collection === 'reimbursement-candidates';
        const head = (selectableCandidates ? '<th>选择</th>' : '') + keys.map((key) => '<th>' + escapeHtml(key) + '</th>').join('');
        const body = rows.slice(0, 100).map((row) => '<tr>' + keys.map((key) => {
          const value = row && row[key];
          const display = typeof value === 'object' ? JSON.stringify(value) : value;
          return '<td>' + escapeHtml(display == null ? '—' : display) + '</td>';
        }).join('') + '</tr>').join('');
        const candidateBody = selectableCandidates ? rows.slice(0, 100).map((row) => {
          const id = row && row.id;
          const selectable = row && row.status === 'pending' && typeof id === 'string';
          const checkbox = selectable ? '<td><input type="checkbox" data-candidate-id="' + escapeHtml(id) + '" aria-label="选择候选费用" /></td>' : '<td>—</td>';
          return '<tr>' + checkbox + keys.map((key) => {
            const value = row && row[key];
            const display = typeof value === 'object' ? JSON.stringify(value) : value;
            return '<td>' + escapeHtml(display == null ? '—' : display) + '</td>';
          }).join('') + '</tr>';
        }).join('') : body;
        panel.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + candidateBody + '</tbody></table>';
      };
      const updateDashboardMetrics = (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
        const lookup = {
          '待处理候选': data.pending_candidates,
          '待审报销批次': data.review_batches,
          '汇率异常': data.fx_exceptions,
          '导入待确认': data.import_exceptions,
          '我的订阅': data.owned_subscriptions,
          '我的账号资产': data.owned_account_assets,
        };
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
          if (panel.dataset.collection === 'dashboard') updateDashboardMetrics(payload);
        } catch (error) {
          panel.innerHTML = '<div class="empty-state"><strong>暂时无法读取数据</strong><span>' + escapeHtml(error.message || '请检查登录、权限或 API 配置。') + '</span></div>';
        }
      };
      const refreshAll = () => document.querySelectorAll('[data-collection]').forEach((panel) => { void refreshCollection(panel); });
      const setResult = (id, message, kind) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.className = 'action-result ' + (kind || '');
        el.textContent = message;
      };
      const setIdentityResult = (message, kind) => setResult('identity-link-result', message, kind);
      const identityText = (value) => typeof value === 'string' ? value : '';
      const providerLabel = (provider) => provider === 'cloudflare'
        ? 'Cloudflare'
        : provider === 'github'
          ? 'GitHub'
          : '外部登录';
      const identityElement = (tag, text, className) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        element.textContent = text;
        return element;
      };
      const renderIdentities = (identities) => {
        const panel = document.getElementById('identity-list');
        if (!panel) return;
        const safeIdentities = Array.isArray(identities) ? identities : [];
        const corporate = document.createElement('article');
        corporate.className = 'identity-row corporate-identity';
        const corporateText = document.createElement('div');
        corporateText.append(
          identityElement('strong', '企业主身份（不可解绑）'),
          identityElement('span', '已通过企业入口验证；如身份变更，请联系系统管理员进行离线恢复。'),
        );
        corporate.append(corporateText, identityElement('span', '企业身份', 'pill'));
        panel.replaceChildren(corporate);

        const linked = safeIdentities.filter((identity) => identity && identity.identity_kind === 'linked_external');
        const activeByProvider = new Map();
        linked.forEach((identity) => {
          if (identity.status === 'active' && (identity.provider_hint === 'cloudflare' || identity.provider_hint === 'github')) {
            activeByProvider.set(identity.provider_hint, identity);
          }
        });
        const hasUnclassifiedActiveIdentity = linked.some((identity) => identity.status === 'active'
          && identity.provider_hint !== 'cloudflare' && identity.provider_hint !== 'github');
        document.querySelectorAll('[data-provider-status]').forEach((status) => {
          const identity = activeByProvider.get(status.dataset.providerStatus);
          const masked = identityText(identity && identity.email_masked);
          status.textContent = identity
            ? ('已绑定' + (masked ? ' · ' + masked : ''))
            : hasUnclassifiedActiveIdentity
              ? '已绑定（登录方式未识别）'
              : '尚未绑定';
        });

        if (!linked.length) {
          panel.append(identityElement('p', '尚未绑定外部登录方式。', 'muted'));
          return;
        }
        linked.forEach((identity) => {
          const row = document.createElement('article');
          row.className = 'identity-row';
          const details = document.createElement('div');
          const label = providerLabel(identity.provider_hint);
          const masked = identityText(identity.email_masked);
          const status = identity.status === 'active' ? '已绑定' : '已停用';
          details.append(
            identityElement('strong', label + ' 外部登录'),
            identityElement('span', (masked ? masked + ' · ' : '') + status),
          );
          row.append(details);
          if (identity.status === 'active' && typeof identity.id === 'string') {
            const revoke = document.createElement('button');
            revoke.type = 'button';
            revoke.className = 'button secondary';
            revoke.textContent = '撤销绑定';
            revoke.addEventListener('click', async () => {
              revoke.disabled = true;
              try {
                await jsonRequest(api.revokeIdentity.replace(':id', encodeURIComponent(identity.id)), {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                  body: '{}',
                });
                setIdentityResult('外部登录方式已撤销。', 'success');
                await loadIdentities();
              } catch (_) {
                setIdentityResult('暂时无法撤销该外部登录方式。', 'error');
              } finally {
                revoke.disabled = false;
              }
            });
            row.append(revoke);
          } else {
            row.append(identityElement('span', '已停用', 'pill'));
          }
          panel.append(row);
        });
      };
      const loadIdentities = async () => {
        try {
          const result = await jsonRequest(api.identities);
          const data = result && typeof result.data === 'object' ? result.data : {};
          renderIdentities(data.identities);
        } catch (_) {
          setIdentityResult('暂时无法读取登录身份，请稍后重试。', 'error');
        }
      };
      const safeResumableLinkTransactions = (transactions) => Array.isArray(transactions)
        ? transactions.filter((transaction) => transaction
          && typeof transaction === 'object'
          && typeof transaction.id === 'string'
          && (transaction.status === 'pending' || transaction.status === 'candidate_presented'))
        : [];
      const renderResumableLinkTransactions = (transactions) => {
        const panel = document.getElementById('identity-link-recovery');
        const safeTransactions = safeResumableLinkTransactions(transactions);
        if (!panel) return safeTransactions;
        panel.replaceChildren();
        if (!safeTransactions.length) {
          panel.append(identityElement('p', '没有可恢复的外部绑定。', 'muted'));
          return safeTransactions;
        }
        safeTransactions.forEach((transaction) => {
          const transactionId = identityText(transaction.id);
          const status = identityText(transaction.status);
          const provider = providerLabel(identityText(transaction.provider_hint));
          const emailMasked = status === 'candidate_presented'
            ? identityText(transaction.email_masked)
            : '';
          const expiresAt = identityText(transaction.expires_at);
          const row = document.createElement('article');
          row.className = 'identity-row';
          const details = document.createElement('div');
          if (status === 'candidate_presented') {
            details.append(
              identityElement('strong', provider + ' 登录身份已提交'),
              identityElement(
                'span',
                (emailMasked ? emailMasked + ' · ' : '') + '请核对后确认绑定' + (expiresAt ? '，到期：' + expiresAt : '。'),
              ),
            );
            const confirm = document.createElement('button');
            confirm.type = 'button';
            confirm.className = 'button primary';
            confirm.textContent = '继续确认绑定';
            confirm.addEventListener('click', async () => {
              confirm.disabled = true;
              try {
                await confirmRecoveredLinkTransaction(transactionId);
              } catch (_) {
                setIdentityResult('暂时无法确认该绑定，请刷新页面后重试。', 'error');
                confirm.disabled = false;
              }
            });
            row.append(details, confirm);
          } else {
            details.append(
              identityElement('strong', '等待外部身份提交'),
              identityElement(
                'span',
                '请使用仍在安全位置保存的一次性绑定码完成外部入口操作；刷新后不会重新显示绑定码。'
                  + (expiresAt ? ' 到期：' + expiresAt : ''),
              ),
            );
            row.append(details, identityElement('span', '等待提交', 'pill'));
          }
          panel.append(row);
        });
        return safeTransactions;
      };
      const loadResumableLinkTransactions = async () => {
        const panel = document.getElementById('identity-link-recovery');
        if (!panel) return [];
        try {
          const result = await jsonRequest(api.resumableIdentityLinks);
          const data = result && typeof result.data === 'object' ? result.data : {};
          return renderResumableLinkTransactions(data.transactions);
        } catch (_) {
          panel.replaceChildren(identityElement('p', '暂时无法读取未完成的绑定，请稍后刷新页面。', 'muted'));
          return [];
        }
      };
      const confirmRecoveredLinkTransaction = async (transactionId) => {
        await jsonRequest(api.confirmIdentityLink.replace(':id', encodeURIComponent(transactionId)), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: '{}',
        });
        document.getElementById('identity-link-transaction')?.replaceChildren();
        await Promise.all([loadIdentities(), loadResumableLinkTransactions()]);
        setIdentityResult('外部登录方式已确认。', 'success');
      };
      const showLinkTransaction = (transaction, label) => {
        const transactionId = identityText(transaction && transaction.id);
        const code = identityText(transaction && transaction.code);
        const externalUrl = identityText(transaction && transaction.external_url);
        if (!transactionId || !code || !externalUrl) throw new Error('invalid_link_transaction');
        const panel = document.getElementById('identity-link-transaction');
        if (!panel) return;
        panel.replaceChildren();
        const instruction = identityElement('p', label + ' 绑定码已生成。请在十分钟内点击“复制绑定码”，再前往外部入口登录并提交。');
        const actions = document.createElement('div');
        actions.className = 'form-actions';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'button primary';
        copy.textContent = '复制绑定码';
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          try {
            await navigator.clipboard.writeText(code);
            setIdentityResult('绑定码已复制到剪贴板。请打开外部入口并提交。', 'success');
          } catch (_) {
            setIdentityResult('暂时无法复制绑定码。请允许浏览器访问剪贴板后重试。', 'error');
          } finally {
            copy.disabled = false;
          }
        });
        const externalLink = document.createElement('a');
        externalLink.href = externalUrl;
        externalLink.className = 'button secondary';
        externalLink.textContent = '打开外部入口';
        externalLink.target = '_blank';
        externalLink.rel = 'noopener noreferrer';
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'button secondary';
        refresh.textContent = '刷新身份状态';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'button primary';
        confirm.textContent = '确认绑定';
        confirm.disabled = true;
        refresh.addEventListener('click', async () => {
          refresh.disabled = true;
          try {
            const transactions = await loadResumableLinkTransactions();
            const resumed = transactions.find((candidate) => candidate.id === transactionId);
            if (resumed && resumed.status === 'candidate_presented') {
              confirm.disabled = false;
              setIdentityResult('已收到外部登录身份。请核对后明确确认绑定。', 'success');
            } else {
              confirm.disabled = true;
              setIdentityResult('尚未收到外部登录身份。请完成外部入口操作后再刷新。', 'error');
            }
          } finally {
            refresh.disabled = false;
          }
        });
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          try {
            await confirmRecoveredLinkTransaction(transactionId);
          } catch (_) {
            setIdentityResult('暂时无法确认该绑定，请刷新身份状态后重试。', 'error');
            confirm.disabled = false;
          }
        });
        actions.append(copy, externalLink, refresh, confirm);
        panel.append(instruction, actions);
      };
      document.querySelectorAll('[data-action="begin-identity-link"]').forEach((button) => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await jsonRequest(api.beginIdentityLink, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: '{}',
            });
            const transaction = result && typeof result.data === 'object' ? result.data : null;
            showLinkTransaction(transaction, identityText(button.dataset.providerLabel) || '外部登录');
            await loadResumableLinkTransactions();
            setIdentityResult('请完成外部入口操作后刷新身份状态，再明确确认绑定。', 'success');
          } catch (_) {
            setIdentityResult('暂时无法生成绑定码，请稍后重试。', 'error');
          } finally {
            button.disabled = false;
          }
        });
      });
      const candidateIds = () => Array.from(new Set([
        ...(document.getElementById('candidate-ids')?.value || '').split(',').map((value) => value.trim()).filter(Boolean),
        ...Array.from(document.querySelectorAll('[data-candidate-id]:checked')).map((input) => input.dataset.candidateId).filter(Boolean)
      ]));
      const reimbursementPayload = () => ({ candidate_ids: candidateIds(), cutoff_date: document.getElementById('reimbursement-cutoff')?.value || undefined });
      document.querySelectorAll('form[data-api]').forEach((form) => form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const endpointKey = form.dataset.api;
        const values = Object.fromEntries(new FormData(form).entries());
        Object.keys(values).forEach((key) => { if (values[key] === '') delete values[key]; });
        try {
          let url = endpointKey === 'subscriptions' ? api.subscriptions
            : endpointKey === 'account-assets' ? api.accountAssets
            : endpointKey === 'account-field-definitions' ? api.accountFieldDefinitions
            : endpointKey === 'fx-quotes' ? api.fxQuotes
            : endpointKey === 'users' ? api.users
            : endpointKey === 'reimbursement-accounts' ? api.reimbursementAccounts
            : null;
          let method = 'POST';
          if (endpointKey === 'user-roles') {
            const userId = values.user_id;
            if (!userId) throw new Error('请填写用户 ID。');
            url = api.users + '/' + encodeURIComponent(userId) + '/roles';
            method = 'PUT';
            values.role_codes = String(values.role_codes || '').split(',').map((role) => role.trim()).filter(Boolean);
            delete values.user_id;
          }
          if (!url) return toast('该表单尚未绑定 API。');
          await jsonRequest(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(values) });
          form.reset();
          toast(form.dataset.success || '已保存。');
          refreshAll();
        } catch (error) { toast(error.message || '保存失败。'); }
      }));
      document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'refresh') return refreshAll();
        if (action === 'generate-candidates') {
          const cutoffDate = document.getElementById('reimbursement-cutoff')?.value;
          if (!cutoffDate) return setResult('reimbursement-result', '请先选择报销截止日。', 'error');
          try {
            const result = await jsonRequest(api.reimbursementGenerate, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cutoff_date: cutoffDate }) });
            setResult('reimbursement-result', '候选生成完成：新增 ' + String(result.generated || 0) + ' 条，跳过既有 ' + String(result.skipped_existing || 0) + ' 条。', 'success');
            refreshAll();
          } catch (error) { setResult('reimbursement-result', error.message || '生成候选失败。', 'error'); }
          return;
        }
        if (action === 'preview-reimbursement' || action === 'create-reimbursement') {
          const payload = reimbursementPayload();
          if (!payload.candidate_ids.length) return setResult('reimbursement-result', '请至少输入一个候选费用 ID。', 'error');
          const url = action === 'preview-reimbursement' ? api.reimbursementPreview : api.reimbursementCreate;
          try {
            const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
            if (action === 'create-reimbursement') headers['Idempotency-Key'] = crypto.randomUUID();
            const result = await jsonRequest(url, { method: 'POST', headers, body: JSON.stringify(payload) });
            const data = result.data && typeof result.data === 'object' ? result.data : result;
            const batches = data.batches || data.items || [];
            setResult('reimbursement-result', (action === 'preview-reimbursement' ? '预览完成' : '草稿已创建') + '：' + (Array.isArray(batches) ? batches.length : 0) + ' 个付款者批次。', 'success');
            if (action === 'create-reimbursement') refreshAll();
          } catch (error) { setResult('reimbursement-result', error.message || '操作失败。', 'error'); }
          return;
        }
        if (action === 'sync-fx') {
          try { await jsonRequest(api.fxSync, { method: 'POST' }); toast('汇率同步任务已提交。'); refreshAll(); }
          catch (error) { toast(error.message || '汇率同步不可用。'); }
          return;
        }
        if (action === 'preview-import') {
          try {
            const result = await jsonRequest(api.importPreview, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = result.data && typeof result.data === 'object' ? result.data : result;
            const summary = data.summary || data.message || (Array.isArray(data.tables) ? ('只读预览完成：' + data.tables.length + ' 张表，待确认字段 ID 映射。') : '只读预览完成，请检查导入运行记录。');
            setResult('import-result', typeof summary === 'string' ? summary : JSON.stringify(summary), 'success');
            refreshAll();
          } catch (error) { setResult('import-result', error.message || '预览失败。', 'error'); }
        }
      });
      if (config.page === 'profile') {
        void loadIdentities();
        void loadResumableLinkTransactions();
      }
      refreshAll();
    })();
  `;
}
