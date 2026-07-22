// 兰芯云朵行政——订阅资产管理系统 · Cloudflare Worker 入口
//
// 设计边界：飞书 Base 仅可被只读导入；D1 才是订阅、汇率与报销账本的唯一真相。
// 所有财务金额均使用 INTEGER 最小单位；任何浏览器提交的金额、付款者或汇率
// 都不会被直接写入报销明细。

import { Hono, type Context } from 'hono';
import {
  APP_ROLES,
  resolveAccessProviderHint,
  resolveAuthenticatedIdentity,
  validateIdentityForEntry,
  type AppRole,
  type AuthenticatedIdentity,
  type Principal,
} from './lib/auth';
import { accessEntryForRequest, isAllowedEntryOrigin, type AccessEntry } from './lib/access-entry';
import {
  IdentityProblem,
  IdentityStore,
  type ResolvedIdentityPrincipal,
} from './lib/identity-store';
import {
  FeishuBaseReader,
  feishuSourceConfigFromEnv,
  isFeishuImportConfigured,
} from './lib/feishu-source';
import { proposeFeishuFieldMapping, type FeishuTableMetadata } from './lib/feishu-mapping';
import { fetchCnyRate, rateToMinorUnitRational } from './lib/fx';
import {
  buildAccrualCandidates,
  buildActualBillCandidates,
  deriveContiguousPaidThrough,
} from './lib/reimbursement-engine';
import {
  buildSubmissionPlan,
  fingerprintBatchRequest,
  normalizeCandidateIds,
  type PersistedCandidateForSubmission,
} from './lib/reimbursement-submission';
import type { Env } from './lib/types';
import {
  renderAdminUi,
  renderCorporateAccessRequiredUi,
  renderExternalAccessRequiredUi,
  renderExternalIdentityUi,
  uiPageFromPath,
  type UiPage,
} from './ui';

type AppVariables = {
  entry: AccessEntry | null;
  signedIdentity: AuthenticatedIdentity | null;
  principal: Principal | null;
  identityPrincipal: ResolvedIdentityPrincipal | null;
};

export type AppBindings = {
  Bindings: Env;
  Variables: AppVariables;
};

type AppContext = Context<AppBindings>;

type CandidateDbRow = PersistedCandidateForSubmission & {
  payer_owner_user_id: string | null;
  payer_display_name: string;
  payer_assignment_id: string;
  subscription_id: string;
  subscription_name: string;
};

export interface AppDependencies {
  resolveIdentity?: (request: Request, env: Env, entry: AccessEntry) => Promise<AuthenticatedIdentity | null>;
  now?: () => Date;
}

const GLOBAL_READ_ROLES: AppRole[] = [
  'system_admin',
  'asset_admin',
  'finance_reviewer',
  'auditor',
];
const DATA_ADMIN_ROLES: AppRole[] = ['system_admin', 'asset_admin'];
const FINANCE_ROLES: AppRole[] = ['system_admin', 'finance_reviewer'];

class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function problem(c: AppContext, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function jsonBody(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>();
    if (!isRecord(body)) throw new ApiProblem(400, 'invalid_body', '请求体必须是 JSON 对象。');
    return body;
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw new ApiProblem(400, 'invalid_json', '请求体不是有效 JSON。');
  }
}

function requiredString(body: Record<string, unknown>, key: string, maxLength = 255): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new ApiProblem(400, 'invalid_field', `${key} 必须是长度不超过 ${maxLength} 的非空文本。`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string, maxLength = 255): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new ApiProblem(400, 'invalid_field', `${key} 必须是长度不超过 ${maxLength} 的文本。`);
  }
  return value.trim();
}

function integer(body: Record<string, unknown>, key: string, minimum = 0): number {
  const value = body[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new ApiProblem(400, 'invalid_field', `${key} 必须是不小于 ${minimum} 的整数。`);
  }
  return parsed;
}

function booleanFlag(body: Record<string, unknown>, key: string, fallback = 0): number {
  const value = body[key];
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  throw new ApiProblem(400, 'invalid_field', `${key} 必须是布尔值。`);
}

function isoDate(value: string, field = 'date'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiProblem(400, 'invalid_date', `${field} 必须是 YYYY-MM-DD。`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiProblem(400, 'invalid_date', `${field} 不是有效日期。`);
  }
  return value;
}

function optionalIsoDate(value: string | null, field: string): string | null {
  return value === null ? null : isoDate(value, field);
}

function enumValue<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = body[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ApiProblem(400, 'invalid_field', `${key} 的值不合法。`);
  }
  return value as T;
}

function hasAnyRole(principal: Principal, roles: readonly AppRole[]): boolean {
  return principal.roles.some((role) => roles.includes(role));
}

function isGlobalReader(principal: Principal): boolean {
  return hasAnyRole(principal, GLOBAL_READ_ROLES);
}

function ensureMutationOrigin(c: AppContext): Response | undefined {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) return undefined;
  const origin = c.req.header('Origin');
  const entry = c.get('entry');
  if (!entry || entry.kind === 'legacy' || !isAllowedEntryOrigin(origin, entry)) {
    return problem(c, 403, 'origin_not_allowed', '写操作必须来自受信任的系统域名。');
  }
  return undefined;
}

function requireRoles(
  c: AppContext,
  roles: readonly AppRole[],
): Principal | Response {
  const originFailure = ensureMutationOrigin(c);
  if (originFailure) return originFailure;
  const principal = c.get('principal');
  if (!principal) return problem(c, 401, 'authentication_required', '需要通过 Cloudflare Access 登录并分配系统角色。');
  if (!hasAnyRole(principal, roles)) {
    return problem(c, 403, 'insufficient_role', '当前角色没有执行该操作的权限。');
  }
  return principal;
}

function isResponse(value: Principal | Response): value is Response {
  return value instanceof Response;
}

function requireCorporatePrimary(c: AppContext): ResolvedIdentityPrincipal | Response {
  const originFailure = ensureMutationOrigin(c);
  if (originFailure) return originFailure;
  const entry = c.get('entry');
  const principal = c.get('identityPrincipal');
  if (entry?.kind !== 'corporate' || !principal) {
    return problem(c, 401, 'authentication_required', '需要通过企业入口使用已开通的企业身份。');
  }
  if (principal.identityKind !== 'corporate_primary') {
    return problem(c, 403, 'corporate_identity_required', '需要企业主身份完成此操作。');
  }
  return principal;
}

function isIdentityResponse(value: ResolvedIdentityPrincipal | Response): value is Response {
  return value instanceof Response;
}

function identityProblemResponse(c: AppContext, error: IdentityProblem): Response {
  const status = error.code === 'identity_store_unavailable'
    ? 503
    : error.code === 'corporate_email_required' || error.code === 'corporate_identity_required'
      ? 403
      : error.code === 'identity_kind_conflict' || error.code === 'identity_already_bound'
        ? 409
        : 400;
  return problem(c, status, error.code, '当前身份状态无法完成该操作。');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function appendAudit(
  env: Env,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), actorId, action, entityType, entityId, JSON.stringify(detail))
    .run();
}

function placeholderList(ids: string[]): string {
  if (ids.length === 0) throw new ApiProblem(400, 'empty_selection', '至少选择一条候选费用。');
  return ids.map(() => '?').join(', ');
}

async function pendingCandidatesForSelection(
  env: Env,
  principal: Principal,
  candidateIds: string[],
): Promise<CandidateDbRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       candidate.id,
       payer_assignment.payer_id AS payerId,
       candidate.coverage_start AS coverageStart,
       candidate.coverage_end AS coverageEnd,
       candidate.original_currency AS originalCurrency,
       candidate.original_amount_minor AS originalAmountMinor,
       candidate.rate_numerator AS rateNumerator,
       candidate.rate_denominator AS rateDenominator,
       candidate.cny_amount_fen AS cnyAmountFen,
       payer.owner_user_id AS payer_owner_user_id,
       payer.display_name AS payer_display_name,
       candidate.payer_assignment_id,
       subscription.id AS subscription_id,
       subscription.name AS subscription_name
     FROM reimbursement_candidates AS candidate
     JOIN payer_assignments AS payer_assignment ON payer_assignment.id = candidate.payer_assignment_id
     JOIN payers AS payer ON payer.id = payer_assignment.payer_id
     JOIN subscription_term_versions AS term ON term.id = candidate.subscription_term_version_id
     JOIN subscriptions AS subscription ON subscription.id = term.subscription_id
     WHERE candidate.status = 'pending' AND candidate.id IN (${placeholderList(candidateIds)})`,
  )
    .bind(...candidateIds)
    .all<CandidateDbRow>();

  const candidates = rows.results;
  if (candidates.length !== candidateIds.length) {
    throw new ApiProblem(409, 'candidate_unavailable', '所选候选中存在已入批、已付款或不存在的记录；本次未创建任何批次。');
  }
  if (!isGlobalReader(principal)) {
    const canReadPayer = principal.roles.includes('payer');
    if (!canReadPayer || candidates.some((candidate) => candidate.payer_owner_user_id !== principal.userId)) {
      throw new ApiProblem(403, 'payer_scope_denied', '付款者只能操作归属自己的候选费用。');
    }
  }
  return candidates;
}

async function fetchBatchForScope(
  env: Env,
  principal: Principal,
  batchId: string,
): Promise<{ id: string; status: string; payer_id: string; payer_owner_user_id: string | null } | null> {
  const batch = await env.DB.prepare(
    `SELECT batch.id, batch.status, batch.payer_id, payer.owner_user_id AS payer_owner_user_id
     FROM reimbursement_batches AS batch
     JOIN payers AS payer ON payer.id = batch.payer_id
     WHERE batch.id = ?`,
  )
    .bind(batchId)
    .first<{ id: string; status: string; payer_id: string; payer_owner_user_id: string | null }>();
  if (!batch) return null;
  if (!isGlobalReader(principal) && (!principal.roles.includes('payer') || batch.payer_owner_user_id !== principal.userId)) {
    throw new ApiProblem(403, 'payer_scope_denied', '付款者只能操作归属自己的报销批次。');
  }
  return batch;
}

async function deriveBatchWatermarks(env: Env, batchId: string): Promise<Array<{ payerAssignmentId: string; reimbursedThrough: string | null }>> {
  const assignments = await env.DB.prepare(
    `SELECT DISTINCT candidate.payer_assignment_id AS payer_assignment_id, assignment.effective_start
     FROM reimbursement_items AS item
     JOIN reimbursement_candidates AS candidate ON candidate.id = item.candidate_id
     JOIN payer_assignments AS assignment ON assignment.id = candidate.payer_assignment_id
     WHERE item.batch_id = ?`,
  )
    .bind(batchId)
    .all<{ payer_assignment_id: string; effective_start: string }>();
  const watermarks: Array<{ payerAssignmentId: string; reimbursedThrough: string | null }> = [];
  for (const assignment of assignments.results) {
    const coverages = await env.DB.prepare(
      `SELECT item.coverage_start AS start, item.coverage_end AS end
       FROM reimbursement_items AS item
       JOIN reimbursement_candidates AS candidate ON candidate.id = item.candidate_id
       WHERE candidate.payer_assignment_id = ? AND item.status = 'paid'
       ORDER BY item.coverage_start`,
    )
      .bind(assignment.payer_assignment_id)
      .all<{ start: string; end: string }>();
    watermarks.push({
      payerAssignmentId: assignment.payer_assignment_id,
      reimbursedThrough: deriveContiguousPaidThrough({
        startDate: assignment.effective_start,
        paidCoverages: coverages.results,
      }),
    });
  }
  return watermarks;
}

function shanghaiBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = read('year');
  const month = read('month');
  const day = read('day');
  if (!year || !month || !day) throw new Error('unable to resolve Asia/Shanghai business date');
  return `${year}-${month}-${day}`;
}

function currencyMinorDigits(currency: string): number {
  // 当前数据主要是 CNY / USD；此表为常见零位小数货币预留正确换算。
  return ['JPY', 'KRW', 'VND'].includes(currency) ? 0 : 2;
}

async function syncConfiguredFxRates(env: Env): Promise<{
  status: 'success' | 'failed';
  runId: string;
  inserted: number;
  errorCode?: string;
}> {
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sync_runs (id, kind, status) VALUES (?, 'fx_rates', 'running')`,
  ).bind(runId).run();
  if (!env.FX_PROVIDER || !env.FX_PROVIDER_URL) {
    await env.DB.prepare(
      `UPDATE sync_runs
       SET status = 'failed', finished_at = datetime('now'), error_code = 'provider_not_configured',
           detail_json = '{"message":"FX_PROVIDER and FX_PROVIDER_URL are required"}'
       WHERE id = ?`,
    ).bind(runId).run();
    return { status: 'failed', runId, inserted: 0, errorCode: 'provider_not_configured' };
  }
  try {
    const currencies = [...new Set((env.FX_CURRENCIES ?? 'USD')
      .split(',')
      .map((currency) => currency.trim().toUpperCase())
      .filter((currency) => /^[A-Z]{3}$/.test(currency) && currency !== 'CNY'))];
    const effectiveAt = shanghaiBusinessDate();
    const fetched = await Promise.all(currencies.map(async (currency) => {
      const quote = await fetchCnyRate({
        baseCurrency: currency,
        providerUrl: env.FX_PROVIDER_URL!,
        ...(env.FX_API_KEY ? { apiKey: env.FX_API_KEY } : {}),
      });
      const rational = rateToMinorUnitRational(quote.cnyPerWholeUnit, currencyMinorDigits(currency));
      return {
        id: crypto.randomUUID(),
        currency,
        effectiveAt,
        rateNumerator: rational.numerator,
        rateDenominator: rational.denominator,
        providerReference: quote.providerReference ?? null,
        rawResponseHash: await sha256Hex(quote.rawResponse),
      };
    }));
    const inserts = fetched.map((quote) => env.DB.prepare(
      `INSERT INTO fx_quotes (
         id, base_currency, quote_currency, rate_numerator, rate_denominator,
         effective_at, provider, provider_reference, raw_response_hash, status, locked_at
       ) VALUES (?, ?, 'CNY', ?, ?, ?, ?, ?, ?, 'verified', datetime('now'))
       ON CONFLICT(base_currency, quote_currency, effective_at, provider) DO NOTHING`,
    ).bind(
      quote.id,
      quote.currency,
      quote.rateNumerator,
      quote.rateDenominator,
      quote.effectiveAt,
      env.FX_PROVIDER!,
      quote.providerReference,
      quote.rawResponseHash,
    ));
    inserts.push(env.DB.prepare(
      `UPDATE sync_runs SET status = 'success', finished_at = datetime('now'), detail_json = ? WHERE id = ?`,
    ).bind(JSON.stringify({ effective_at: effectiveAt, currencies: currencies.length }), runId));
    const results = await env.DB.batch(inserts);
    return {
      status: 'success',
      runId,
      inserted: results.slice(0, fetched.length).filter((result) => result.meta.changes === 1).length,
    };
  } catch {
    await env.DB.prepare(
      `UPDATE sync_runs SET status = 'failed', finished_at = datetime('now'), error_code = 'provider_request_failed'
       WHERE id = ?`,
    ).bind(runId).run();
    return { status: 'failed', runId, inserted: 0, errorCode: 'provider_request_failed' };
  }
}

export function createApp(dependencies: AppDependencies = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const resolveIdentity = dependencies.resolveIdentity ?? resolveAuthenticatedIdentity;
  const now = dependencies.now ?? (() => new Date());

  app.onError((error, c) => {
    if (error instanceof ApiProblem) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    if (error instanceof IdentityProblem) return identityProblemResponse(c, error);
    // 不回显异常文本，避免把上游 Token、SQL 或 provider 响应泄漏给浏览器。
    return c.json({ error: { code: 'internal_error', message: '系统暂时无法处理该请求。' } }, 500);
  });

  app.use('*', async (c, next) => {
    const requestUrl = new URL(c.req.url);
    const entry = accessEntryForRequest(requestUrl.host, c.env);
    if (!entry) return problem(c, 404, 'unknown_entry_host', '请求的系统入口不存在。');

    c.set('entry', entry);
    c.set('signedIdentity', null);
    c.set('principal', null);
    c.set('identityPrincipal', null);

    if (entry.kind === 'legacy') {
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        return c.redirect(`https://ie-oa.lancloudtech.com${requestUrl.pathname}${requestUrl.search}`, 308);
      }
      return problem(c, 410, 'legacy_host_write_blocked', '请使用新入口完成写操作。');
    }

    if (c.req.path === '/api/health') return next();

    try {
      const identity = await resolveIdentity(c.req.raw, c.env, entry);
      if (!identity) return next();
      validateIdentityForEntry(identity, entry);
      c.set('signedIdentity', identity);

      const store = new IdentityStore(c.env.DB);
      const principal = entry.kind === 'corporate'
        ? await store.ensureCorporatePrincipal(identity, {
          migrationAdminEmail: c.env.MIGRATION_SYSTEM_ADMIN_EMAIL,
        })
        : await store.resolve(identity, 'external');
      if (principal) {
        c.set('principal', principal);
        c.set('identityPrincipal', principal);
      }
      if (
        entry.kind === 'external'
        && !principal
        && c.req.path.startsWith('/api/')
        && c.req.path !== '/api/external/identity-presentations'
      ) {
        return problem(c, 401, 'authentication_required', '该外部身份尚未绑定系统账户。');
      }
    } catch (error) {
      if (error instanceof IdentityProblem) throw error;
      return problem(c, 401, 'invalid_access_assertion', '登录断言无效、过期或不属于本应用。');
    }
    return next();
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: 'lan-cloud-internal-expense',
      deployment_mode: c.env.ENVIRONMENT,
      feishu_import_enabled: c.env.FEISHU_IMPORT_ENABLED === '1',
    }),
  );

app.get('/api/session', (c) => {
  const principal = c.get('principal');
  if (!principal) return problem(c, 401, 'authentication_required', '未识别到已授权用户。');
  return c.json({
    data: {
      entry: c.get('entry')?.kind ?? null,
      user_id: principal.userId,
      subject: principal.subject,
      email: principal.email ?? null,
      roles: principal.roles,
    },
  });
});

app.get('/api/me/identities', async (c) => {
  const auth = requireCorporatePrimary(c);
  if (isIdentityResponse(auth)) return auth;
  const identities = await new IdentityStore(c.env.DB).listMaskedIdentities(auth);
  return c.json({ data: { identities } });
});

app.get('/api/me/identities/link-transactions/recovery', async (c) => {
  const auth = requireCorporatePrimary(c);
  if (isIdentityResponse(auth)) return auth;
  const transactions = await new IdentityStore(c.env.DB).listResumableLinkTransactions(auth, now());
  return c.json({ data: { transactions } });
});

app.post('/api/me/identities/link-transactions', async (c) => {
  const auth = requireCorporatePrimary(c);
  if (isIdentityResponse(auth)) return auth;
  const transaction = await new IdentityStore(c.env.DB).beginLinkTransaction(auth, now());
  return c.json({
    data: {
      id: transaction.id,
      code: transaction.secret,
      expires_at: transaction.expiresAt,
      external_url: 'https://external-ie-oa.lancloudtech.com/',
    },
  }, 201);
});

app.post('/api/external/identity-presentations', async (c) => {
  const originFailure = ensureMutationOrigin(c);
  if (originFailure) return originFailure;
  if (c.get('entry')?.kind !== 'external') {
    return problem(c, 401, 'authentication_required', '需要通过外部登录入口完成身份绑定。');
  }
  const identity = c.get('signedIdentity');
  if (!identity) return problem(c, 401, 'authentication_required', '需要有效的外部登录身份。');
  const body = await jsonBody(c);
  const code = requiredString(body, 'code', 64);
  try {
    const providerHint = await resolveAccessProviderHint(c.req.raw);
    await new IdentityStore(c.env.DB).presentExternalIdentity(identity, code, providerHint, now());
  } catch {
    // This endpoint must not reveal whether a code, account, transaction, or identity exists.
    return problem(c, 400, 'identity_presentation_rejected', '绑定请求未被接受。');
  }
  return c.body(null, 204);
});

app.post('/api/me/identities/link-transactions/:id/confirm', async (c) => {
  const auth = requireCorporatePrimary(c);
  if (isIdentityResponse(auth)) return auth;
  const store = new IdentityStore(c.env.DB);
  await store.confirmLinkTransaction(auth, c.req.param('id'), now());
  return c.json({ data: { identities: await store.listMaskedIdentities(auth) } });
});

app.delete('/api/me/identities/:id', async (c) => {
  const auth = requireCorporatePrimary(c);
  if (isIdentityResponse(auth)) return auth;
  const store = new IdentityStore(c.env.DB);
  await store.revokeLinkedIdentity(auth, c.req.param('id'));
  return c.json({ data: { identities: await store.listMaskedIdentities(auth) } });
});

app.get('/api/dashboard', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const employeeOnly = auth.roles.includes('employee') && !isGlobalReader(auth) && !auth.roles.includes('payer');
  if (employeeOnly) {
    // Employees never query global reimbursement, batch, FX, or import tables.
    const ownedResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM subscriptions WHERE owner_user_id = ?`,
      ).bind(auth.userId),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM account_assets WHERE owner_user_id = ?`,
      ).bind(auth.userId),
    ]);
    return c.json({
      data: {
        pending_candidates: { count: 0, total_cny_fen: 0 },
        review_batches: { count: 0 },
        fx_exceptions: { count: 0 },
        import_exceptions: { count: 0 },
        owned_subscriptions: ownedResults[0]?.results[0] ?? { count: 0 },
        owned_account_assets: ownedResults[1]?.results[0] ?? { count: 0 },
      },
    });
  }
  const payerScoped = !isGlobalReader(auth) && auth.roles.includes('payer');
  const candidateStatement = payerScoped
    ? c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(candidate.cny_amount_fen), 0) AS total_cny_fen
       FROM reimbursement_candidates AS candidate
       JOIN payer_assignments AS assignment ON assignment.id = candidate.payer_assignment_id
       JOIN payers AS payer ON payer.id = assignment.payer_id
       WHERE candidate.status = 'pending' AND payer.owner_user_id = ?`,
    ).bind(auth.userId)
    : c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(cny_amount_fen), 0) AS total_cny_fen
       FROM reimbursement_candidates WHERE status = 'pending'`,
    );
  const batchStatement = payerScoped
    ? c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM reimbursement_batches AS batch
       JOIN payers AS payer ON payer.id = batch.payer_id
       WHERE batch.status IN ('submitted', 'reviewing', 'approved') AND payer.owner_user_id = ?`,
    ).bind(auth.userId)
    : c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM reimbursement_batches
       WHERE status IN ('submitted', 'reviewing', 'approved')`,
    );
  const dashboardResults = await c.env.DB.batch([
    candidateStatement,
    batchStatement,
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM fx_quotes WHERE status IN ('stale', 'failed')`),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM source_import_runs WHERE status IN ('failed', 'schema_drift')`),
  ]);
  return c.json({
    data: {
      pending_candidates: dashboardResults[0]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      review_batches: dashboardResults[1]?.results[0] ?? { count: 0 },
      fx_exceptions: dashboardResults[2]?.results[0] ?? { count: 0 },
      import_exceptions: dashboardResults[3]?.results[0] ?? { count: 0 },
    },
  });
});

app.get('/api/roles', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'auditor']);
  if (isResponse(auth)) return auth;
  const roles = await c.env.DB.prepare(`SELECT id, code, display_name FROM roles ORDER BY code`).all();
  return c.json({ data: roles.results });
});

app.get('/api/users', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'auditor']);
  if (isResponse(auth)) return auth;
  const users = await c.env.DB.prepare(
    `SELECT user.id, user.external_subject, user.email, user.display_name, user.employment_status,
            COALESCE(group_concat(role.code), '') AS role_codes
     FROM users AS user
     LEFT JOIN user_roles AS assignment ON assignment.user_id = user.id
     LEFT JOIN roles AS role ON role.id = assignment.role_id
     GROUP BY user.id
     ORDER BY user.display_name`,
  ).all<{ id: string; external_subject: string; email: string | null; display_name: string; employment_status: string; role_codes: string }>();
  return c.json({
    data: users.results.map((user) => ({
      ...user,
      roles: user.role_codes ? user.role_codes.split(',') : [],
      role_codes: undefined,
    })),
  });
});

app.post('/api/users', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const externalSubject = requiredString(body, 'external_subject', 255);
  const email = optionalString(body, 'email', 255);
  const displayName = requiredString(body, 'display_name', 80);
  await c.env.DB.prepare(
    `INSERT INTO users (id, external_subject, email, display_name)
     VALUES (?, ?, ?, ?)`,
  ).bind(id, externalSubject, email, displayName).run();
  await appendAudit(c.env, auth.userId, 'create_user', 'user', id, { external_subject: externalSubject });
  return c.json({ user_id: id }, 201);
});

app.put('/api/users/:userId/roles', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  if (!Array.isArray(body.role_codes) || body.role_codes.some((role) => typeof role !== 'string' || !APP_ROLES.includes(role as AppRole))) {
    throw new ApiProblem(400, 'invalid_role_codes', 'role_codes 必须是系统预置角色代码数组。');
  }
  const roleCodes = [...new Set(body.role_codes as AppRole[])];
  const userId = c.req.param('userId');
  const existingUser = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first<{ id: string }>();
  if (!existingUser) return problem(c, 404, 'user_not_found', '用户不存在。');
  const roleRows = roleCodes.length === 0
    ? []
    : (await c.env.DB.prepare(`SELECT id, code FROM roles WHERE code IN (${placeholderList(roleCodes)})`).bind(...roleCodes).all<{ id: string; code: AppRole }>()).results;
  if (roleRows.length !== roleCodes.length) throw new ApiProblem(409, 'role_catalog_incomplete', '角色目录未初始化完整。');
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM user_roles WHERE user_id = ?`).bind(userId),
    ...roleRows.map((role) => c.env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)`,
    ).bind(userId, role.id, auth.userId)),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'replace_user_roles', 'user', ?, ?)`,
    ).bind(crypto.randomUUID(), auth.userId, userId, JSON.stringify({ roles: roleCodes })),
  ]);
  return c.json({ user_id: userId, roles: roleCodes });
});

app.get('/api/payers', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer']);
  if (isResponse(auth)) return auth;
  const payers = isGlobalReader(auth)
    ? await c.env.DB.prepare(
      `SELECT payer.*, user.display_name AS owner_name
       FROM payers AS payer LEFT JOIN users AS user ON user.id = payer.owner_user_id
       ORDER BY payer.display_name`,
    ).all()
    : await c.env.DB.prepare(
      `SELECT payer.*, user.display_name AS owner_name
       FROM payers AS payer LEFT JOIN users AS user ON user.id = payer.owner_user_id
       WHERE payer.owner_user_id = ? ORDER BY payer.display_name`,
    ).bind(auth.userId).all();
  return c.json({ data: payers.results });
});

app.post('/api/payers', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const displayName = requiredString(body, 'display_name', 120);
  const ownerUserId = optionalString(body, 'owner_user_id', 80);
  const paymentMethodMasked = optionalString(body, 'payment_method_masked', 120);
  const activeFrom = isoDate(requiredString(body, 'active_from', 10), 'active_from');
  const activeUntil = optionalIsoDate(optionalString(body, 'active_until', 10), 'active_until');
  if (activeUntil && activeUntil < activeFrom) throw new ApiProblem(400, 'invalid_date_range', 'active_until 不能早于 active_from。');
  await c.env.DB.prepare(
    `INSERT INTO payers (id, display_name, owner_user_id, payment_method_masked, active_from, active_until)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, displayName, ownerUserId, paymentMethodMasked, activeFrom, activeUntil).run();
  await appendAudit(c.env, auth.userId, 'create_payer', 'payer', id, { display_name: displayName });
  return c.json({ payer_id: id }, 201);
});

app.get('/api/reimbursement-accounts', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer']);
  if (isResponse(auth)) return auth;
  const accounts = isGlobalReader(auth)
    ? await c.env.DB.prepare(
      `SELECT account.*, payer.display_name AS payer_name, user.display_name AS owner_name
       FROM reimbursement_accounts AS account
       JOIN payers AS payer ON payer.id = account.payer_id
       LEFT JOIN users AS user ON user.id = account.owner_user_id
       ORDER BY payer.display_name, account.platform`,
    ).all()
    : await c.env.DB.prepare(
      `SELECT account.*, payer.display_name AS payer_name, user.display_name AS owner_name
       FROM reimbursement_accounts AS account
       JOIN payers AS payer ON payer.id = account.payer_id
       LEFT JOIN users AS user ON user.id = account.owner_user_id
       WHERE payer.owner_user_id = ? ORDER BY payer.display_name, account.platform`,
    ).bind(auth.userId).all();
  return c.json({ data: accounts.results });
});

app.post('/api/reimbursement-accounts', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const payerId = requiredString(body, 'payer_id', 80);
  const platform = requiredString(body, 'platform', 80);
  const accountAlias = requiredString(body, 'account_alias', 120);
  const accountMasked = optionalString(body, 'account_masked', 160);
  const vaultRef = optionalString(body, 'vault_ref', 255);
  const ownerUserId = optionalString(body, 'owner_user_id', 80);
  const mfaStatus = enumValue(body, 'mfa_status', ['enabled', 'disabled', 'unknown'] as const);
  await c.env.DB.prepare(
    `INSERT INTO reimbursement_accounts (
       id, payer_id, platform, account_alias, account_masked, vault_ref, owner_user_id, mfa_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, payerId, platform, accountAlias, accountMasked, vaultRef, ownerUserId, mfaStatus).run();
  await appendAudit(c.env, auth.userId, 'create_reimbursement_account', 'reimbursement_account', id, { payer_id: payerId, platform });
  return c.json({ reimbursement_account_id: id }, 201);
});

app.get('/api/subscriptions', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  let sql = `SELECT DISTINCT
      subscription.id, subscription.name, subscription.status, subscription.owner_user_id,
      subscription.auto_renew, subscription.payment_method_masked, subscription.notes,
      vendor.name AS vendor_name,
      term.id AS active_term_version_id, term.effective_start AS term_effective_start,
      term.effective_end AS term_effective_end, term.billing_cycle, term.settlement_mode,
      term.billing_anchor_date, term.original_currency, term.amount_minor,
      assignment.id AS active_payer_assignment_id, payer.id AS payer_id,
      payer.display_name AS payer_name
    FROM subscriptions AS subscription
    LEFT JOIN vendors AS vendor ON vendor.id = subscription.vendor_id
    LEFT JOIN subscription_term_versions AS term
      ON term.subscription_id = subscription.id AND term.effective_end IS NULL
    LEFT JOIN payer_assignments AS assignment
      ON assignment.subscription_id = subscription.id AND assignment.effective_end IS NULL
    LEFT JOIN payers AS payer ON payer.id = assignment.payer_id`;
  let statement: D1PreparedStatement;
  if (isGlobalReader(auth)) {
    statement = c.env.DB.prepare(`${sql} ORDER BY subscription.name`);
  } else if (auth.roles.includes('payer')) {
    statement = c.env.DB.prepare(`${sql} WHERE payer.owner_user_id = ? ORDER BY subscription.name`).bind(auth.userId);
  } else {
    statement = c.env.DB.prepare(`${sql} WHERE subscription.owner_user_id = ? ORDER BY subscription.name`).bind(auth.userId);
  }
  const subscriptions = await statement.all();
  return c.json({ data: subscriptions.results });
});

app.post('/api/subscriptions', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const name = requiredString(body, 'name', 120);
  const vendorId = optionalString(body, 'vendor_id', 80);
  const ownerUserId = optionalString(body, 'owner_user_id', 80);
  const autoRenew = booleanFlag(body, 'auto_renew');
  const paymentMethodMasked = optionalString(body, 'payment_method_masked', 120);
  const notes = optionalString(body, 'notes', 2_000);
  await c.env.DB.prepare(
    `INSERT INTO subscriptions (
       id, name, vendor_id, owner_user_id, auto_renew, payment_method_masked, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, name, vendorId, ownerUserId, autoRenew, paymentMethodMasked, notes).run();
  await appendAudit(c.env, auth.userId, 'create_subscription', 'subscription', id, { name });
  return c.json({ subscription_id: id }, 201);
});

app.put('/api/subscriptions/:subscriptionId/operational', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const subscriptionId = c.req.param('subscriptionId');
  const existing = await c.env.DB.prepare(
    `SELECT id, auto_renew, payment_method_masked, notes FROM subscriptions WHERE id = ?`,
  ).bind(subscriptionId).first<{
    id: string;
    auto_renew: number;
    payment_method_masked: string | null;
    notes: string | null;
  }>();
  if (!existing) return problem(c, 404, 'subscription_not_found', '订阅不存在。');
  const autoRenew = booleanFlag(body, 'auto_renew', existing.auto_renew);
  const paymentMethodMasked = body.payment_method_masked === undefined
    ? existing.payment_method_masked
    : optionalString(body, 'payment_method_masked', 120);
  const notes = body.notes === undefined ? existing.notes : optionalString(body, 'notes', 2_000);
  await c.env.DB.prepare(
    `UPDATE subscriptions
     SET auto_renew = ?, payment_method_masked = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(autoRenew, paymentMethodMasked, notes, subscriptionId).run();
  await appendAudit(c.env, auth.userId, 'update_subscription_operational_fields', 'subscription', subscriptionId, { auto_renew: autoRenew });
  return c.json({ subscription_id: subscriptionId, auto_renew: autoRenew });
});

app.post('/api/subscriptions/:subscriptionId/term-versions', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const effectiveStart = isoDate(requiredString(body, 'effective_start', 10), 'effective_start');
  const effectiveEnd = optionalIsoDate(optionalString(body, 'effective_end', 10), 'effective_end');
  if (effectiveEnd && effectiveEnd < effectiveStart) throw new ApiProblem(400, 'invalid_date_range', 'effective_end 不能早于 effective_start。');
  const billingCycle = enumValue(body, 'billing_cycle', ['monthly', 'quarterly', 'yearly', 'one_time'] as const);
  const settlementMode = enumValue(body, 'settlement_mode', ['actual_bill', 'accrual'] as const);
  const billingAnchorDate = isoDate(requiredString(body, 'billing_anchor_date', 10), 'billing_anchor_date');
  const originalCurrency = requiredString(body, 'original_currency', 12).toUpperCase();
  const amountMinor = integer(body, 'amount_minor', 0);
  await c.env.DB.prepare(
    `INSERT INTO subscription_term_versions (
       id, subscription_id, effective_start, effective_end, billing_cycle,
       settlement_mode, billing_anchor_date, original_currency, amount_minor
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    c.req.param('subscriptionId'),
    effectiveStart,
    effectiveEnd,
    billingCycle,
    settlementMode,
    billingAnchorDate,
    originalCurrency,
    amountMinor,
  ).run();
  await appendAudit(c.env, auth.userId, 'create_subscription_term_version', 'subscription_term_version', id, {
    subscription_id: c.req.param('subscriptionId'),
    effective_start: effectiveStart,
  });
  return c.json({ term_version_id: id }, 201);
});

app.post('/api/subscriptions/:subscriptionId/payer-assignments', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const payerId = requiredString(body, 'payer_id', 80);
  const effectiveStart = isoDate(requiredString(body, 'effective_start', 10), 'effective_start');
  const effectiveEnd = optionalIsoDate(optionalString(body, 'effective_end', 10), 'effective_end');
  if (effectiveEnd && effectiveEnd < effectiveStart) throw new ApiProblem(400, 'invalid_date_range', 'effective_end 不能早于 effective_start。');
  await c.env.DB.prepare(
    `INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start, effective_end)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, c.req.param('subscriptionId'), payerId, effectiveStart, effectiveEnd).run();
  await appendAudit(c.env, auth.userId, 'create_payer_assignment', 'payer_assignment', id, {
    subscription_id: c.req.param('subscriptionId'),
    payer_id: payerId,
  });
  return c.json({ payer_assignment_id: id }, 201);
});

app.get('/api/account-assets', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const accounts = isGlobalReader(auth)
    ? await c.env.DB.prepare(
      `SELECT account.*, user.display_name AS owner_name, vendor.name AS vendor_name
       FROM account_assets AS account
       LEFT JOIN users AS user ON user.id = account.owner_user_id
       LEFT JOIN vendors AS vendor ON vendor.id = account.vendor_id
       ORDER BY account.display_name`,
    ).all()
    : await c.env.DB.prepare(
      `SELECT account.*, user.display_name AS owner_name, vendor.name AS vendor_name
       FROM account_assets AS account
       LEFT JOIN users AS user ON user.id = account.owner_user_id
       LEFT JOIN vendors AS vendor ON vendor.id = account.vendor_id
       WHERE account.owner_user_id = ? ORDER BY account.display_name`,
    ).bind(auth.userId).all();
  return c.json({ data: accounts.results });
});

app.post('/api/account-assets', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const displayName = requiredString(body, 'display_name', 120);
  const accountIdentifierMasked = requiredString(body, 'account_identifier_masked', 160);
  const ownerUserId = optionalString(body, 'owner_user_id', 80);
  const vendorId = optionalString(body, 'vendor_id', 80);
  const vaultRef = optionalString(body, 'vault_ref', 255);
  const expiresOn = optionalIsoDate(optionalString(body, 'expires_on', 10), 'expires_on');
  await c.env.DB.prepare(
    `INSERT INTO account_assets (
       id, owner_user_id, vendor_id, account_identifier_masked, display_name, vault_ref, expires_on
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, ownerUserId, vendorId, accountIdentifierMasked, displayName, vaultRef, expiresOn).run();
  await appendAudit(c.env, auth.userId, 'create_account_asset', 'account_asset', id, { display_name: displayName });
  return c.json({ account_asset_id: id }, 201);
});

app.get('/api/account-field-definitions', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor']);
  if (isResponse(auth)) return auth;
  const fields = await c.env.DB.prepare(
    `SELECT id, field_key, label, field_type, options_json, required, active, created_at
     FROM account_field_definitions WHERE active = 1 ORDER BY field_key`,
  ).all();
  return c.json({ data: fields.results });
});

app.post('/api/account-field-definitions', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const fieldKey = requiredString(body, 'field_key', 40);
  if (!/^[a-z][a-z0-9_]*$/.test(fieldKey)) throw new ApiProblem(400, 'invalid_field_key', 'field_key 只能使用小写字母、数字和下划线。');
  const label = requiredString(body, 'label', 60);
  const fieldType = enumValue(body, 'field_type', ['text', 'integer', 'date', 'boolean', 'select'] as const);
  const options = optionalString(body, 'options', 1000);
  const optionsJson = fieldType === 'select' && options
    ? JSON.stringify(options.split(',').map((option) => option.trim()).filter(Boolean))
    : null;
  await c.env.DB.prepare(
    `INSERT INTO account_field_definitions (id, field_key, label, field_type, options_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, fieldKey, label, fieldType, optionsJson).run();
  await appendAudit(c.env, auth.userId, 'create_account_field_definition', 'account_field_definition', id, { field_key: fieldKey });
  return c.json({ account_field_definition_id: id }, 201);
});

app.put('/api/account-assets/:accountId/field-values', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  if (!Array.isArray(body.values) || body.values.length === 0) {
    throw new ApiProblem(400, 'invalid_field_values', 'values 必须至少包含一个追加字段值。');
  }
  const accountId = c.req.param('accountId');
  const statements: D1PreparedStatement[] = [];
  for (const value of body.values) {
    if (!isRecord(value)) throw new ApiProblem(400, 'invalid_field_values', '每个追加字段值必须是对象。');
    const definitionId = requiredString(value, 'field_definition_id', 80);
    const valueText = optionalString(value, 'value_text', 1000);
    const valueInteger = value.value_integer === undefined || value.value_integer === null || value.value_integer === ''
      ? null
      : integer(value, 'value_integer');
    const valueDate = optionalIsoDate(optionalString(value, 'value_date', 10), 'value_date');
    const valueBoolean = value.value_boolean === undefined || value.value_boolean === null || value.value_boolean === ''
      ? null
      : integer(value, 'value_boolean', 0);
    if (valueBoolean !== null && valueBoolean !== 0 && valueBoolean !== 1) throw new ApiProblem(400, 'invalid_field_values', 'value_boolean 必须为 0 或 1。');
    statements.push(c.env.DB.prepare(
      `INSERT INTO account_field_values (
         account_asset_id, field_definition_id, value_text, value_integer, value_date, value_boolean, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_asset_id, field_definition_id) DO UPDATE SET
         value_text = excluded.value_text,
         value_integer = excluded.value_integer,
         value_date = excluded.value_date,
         value_boolean = excluded.value_boolean,
         updated_at = excluded.updated_at`,
    ).bind(accountId, definitionId, valueText, valueInteger, valueDate, valueBoolean));
  }
  statements.push(c.env.DB.prepare(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
     VALUES (?, ?, 'update_account_field_values', 'account_asset', ?, ?)`,
  ).bind(crypto.randomUUID(), auth.userId, accountId, JSON.stringify({ count: body.values.length })));
  await c.env.DB.batch(statements);
  return c.json({ account_asset_id: accountId, updated: body.values.length });
});

function selectedCandidateIds(body: Record<string, unknown>): string[] {
  try {
    return normalizeCandidateIds(body.candidate_ids);
  } catch (error) {
    throw new ApiProblem(400, 'invalid_candidate_selection', (error as Error).message);
  }
}

function buildPlanOrProblem(cutoffDate: string, candidates: CandidateDbRow[]) {
  try {
    return buildSubmissionPlan({ cutoffDate, candidates });
  } catch (error) {
    throw new ApiProblem(409, 'invalid_reimbursement_plan', (error as Error).message);
  }
}

app.get('/api/reimbursements/candidates', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer']);
  if (isResponse(auth)) return auth;
  const requestedStatus = c.req.query('status') ?? 'pending';
  const allowedStatuses = ['pending', 'selected', 'batched', 'paid', 'void'];
  if (!allowedStatuses.includes(requestedStatus)) throw new ApiProblem(400, 'invalid_status', '候选状态不合法。');
  let statement: D1PreparedStatement;
  const baseSql = `SELECT
      candidate.id, candidate.coverage_start, candidate.coverage_end,
      candidate.original_currency, candidate.original_amount_minor,
      candidate.rate_numerator, candidate.rate_denominator, candidate.cny_amount_fen,
      candidate.status, candidate.locked_at, term.billing_cycle, term.settlement_mode,
      subscription.id AS subscription_id, subscription.name AS subscription_name,
      assignment.id AS payer_assignment_id, payer.id AS payer_id, payer.display_name AS payer_name
    FROM reimbursement_candidates AS candidate
    JOIN subscription_term_versions AS term ON term.id = candidate.subscription_term_version_id
    JOIN subscriptions AS subscription ON subscription.id = term.subscription_id
    JOIN payer_assignments AS assignment ON assignment.id = candidate.payer_assignment_id
    JOIN payers AS payer ON payer.id = assignment.payer_id`;
  if (isGlobalReader(auth)) {
    statement = c.env.DB.prepare(`${baseSql} WHERE candidate.status = ? ORDER BY candidate.coverage_start DESC`).bind(requestedStatus);
  } else {
    statement = c.env.DB.prepare(`${baseSql} WHERE candidate.status = ? AND payer.owner_user_id = ? ORDER BY candidate.coverage_start DESC`).bind(requestedStatus, auth.userId);
  }
  const candidates = await statement.all();
  return c.json({ data: candidates.results });
});

app.post('/api/reimbursements/preview', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'payer']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const cutoffDate = isoDate(requiredString(body, 'cutoff_date', 10), 'cutoff_date');
  const candidateIds = selectedCandidateIds(body);
  const candidates = await pendingCandidatesForSelection(c.env, auth, candidateIds);
  const plan = buildPlanOrProblem(cutoffDate, candidates);
  return c.json({
    data: {
      cutoff_date: plan.cutoffDate,
      candidate_ids: plan.candidateIds,
      batches: plan.batches.map((batch) => ({
        payer_id: batch.payerId,
        coverage_start: batch.coverageStart,
        coverage_end: batch.coverageEnd,
        total_cny_fen: batch.totalCnyFen,
        candidate_ids: batch.candidateIds,
      })),
    },
  });
});

app.post('/api/reimbursements/create-batches', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'payer']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const cutoffDate = isoDate(requiredString(body, 'cutoff_date', 10), 'cutoff_date');
  const candidateIds = selectedCandidateIds(body);
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return problem(c, 400, 'idempotency_key_required', '创建报销批次必须提供长度不超过 200 的 Idempotency-Key。');
  }
  const canonicalRequest = fingerprintBatchRequest({ cutoffDate, candidateIds });
  const requestHash = await sha256Hex(canonicalRequest);
  const action = 'create_reimbursement_batches';
  const existing = await c.env.DB.prepare(
    `SELECT request_hash, response_json FROM idempotency_requests
     WHERE actor_id = ? AND action = ? AND idempotency_key = ?`,
  ).bind(auth.userId, action, idempotencyKey).first<{ request_hash: string; response_json: string | null }>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      return problem(c, 409, 'idempotency_key_reused', '同一个 Idempotency-Key 不能对应不同的候选集合或截止日。');
    }
    if (!existing.response_json) return problem(c, 409, 'request_in_progress', '相同请求仍在处理，请稍后重试。');
    try {
      return c.json({ ...JSON.parse(existing.response_json) as Record<string, unknown>, replayed: true });
    } catch {
      return problem(c, 409, 'idempotency_response_invalid', '历史幂等响应不可用，请联系管理员。');
    }
  }

  const candidates = await pendingCandidatesForSelection(c.env, auth, candidateIds);
  const plan = buildPlanOrProblem(cutoffDate, candidates);
  const idempotencyRequestId = crypto.randomUUID();
  const submissionId = crypto.randomUUID();
  const batchIds = new Map(plan.batches.map((batch) => [batch.payerId, crypto.randomUUID()]));
  const responsePayload = {
    submission_id: submissionId,
    cutoff_date: cutoffDate,
    batches: plan.batches.map((batch) => ({
      batch_id: batchIds.get(batch.payerId)!,
      payer_id: batch.payerId,
      coverage_start: batch.coverageStart,
      coverage_end: batch.coverageEnd,
      total_cny_fen: batch.totalCnyFen,
      candidate_ids: batch.candidateIds,
    })),
  };
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO idempotency_requests (id, actor_id, action, idempotency_key, request_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(idempotencyRequestId, auth.userId, action, idempotencyKey, requestHash),
    c.env.DB.prepare(
      `INSERT INTO reimbursement_submissions (id, actor_id, cutoff_date, idempotency_request_id, status)
       VALUES (?, ?, ?, ?, 'submitted')`,
    ).bind(submissionId, auth.userId, cutoffDate, idempotencyRequestId),
  ];
  for (const batch of plan.batches) {
    const batchId = batchIds.get(batch.payerId)!;
    statements.push(c.env.DB.prepare(
      `INSERT INTO reimbursement_batches (
         id, submission_id, payer_id, coverage_start, coverage_end, total_cny_fen, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'submitted')`,
    ).bind(batchId, submissionId, batch.payerId, batch.coverageStart, batch.coverageEnd, batch.totalCnyFen));
    for (const candidate of batch.candidates) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO reimbursement_items (
           id, batch_id, candidate_id, payer_id, coverage_start, coverage_end,
           original_currency, original_amount_minor, rate_numerator, rate_denominator,
           cny_amount_fen, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
      ).bind(
        crypto.randomUUID(),
        batchId,
        candidate.id,
        batch.payerId,
        candidate.coverageStart,
        candidate.coverageEnd,
        candidate.originalCurrency,
        candidate.originalAmountMinor,
        candidate.rateNumerator,
        candidate.rateDenominator,
        candidate.cnyAmountFen,
      ));
      // 先写明细、后更新候选：DB 触发器会要求 insert 时仍是 pending。
      statements.push(c.env.DB.prepare(
        `UPDATE reimbursement_candidates SET status = 'batched'
         WHERE id = ? AND status = 'pending'`,
      ).bind(candidate.id));
    }
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'create_reimbursement_submission', 'reimbursement_submission', ?, ?)`,
    ).bind(crypto.randomUUID(), auth.userId, submissionId, JSON.stringify({ batch_count: plan.batches.length, candidate_count: candidateIds.length })),
    c.env.DB.prepare(
      `UPDATE idempotency_requests SET response_json = ?, completed_at = datetime('now')
       WHERE id = ?`,
    ).bind(JSON.stringify(responsePayload), idempotencyRequestId),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    // 并发重放时，优先返回已经提交的同一幂等响应；其他冲突不泄漏底层 SQL。
    const raced = await c.env.DB.prepare(
      `SELECT request_hash, response_json FROM idempotency_requests
       WHERE actor_id = ? AND action = ? AND idempotency_key = ?`,
    ).bind(auth.userId, action, idempotencyKey).first<{ request_hash: string; response_json: string | null }>();
    if (raced?.request_hash === requestHash && raced.response_json) {
      return c.json({ ...JSON.parse(raced.response_json) as Record<string, unknown>, replayed: true });
    }
    return problem(c, 409, 'reimbursement_conflict', '候选费用已被其他请求占用或账本约束未满足；本次没有创建半成品。');
  }
  return c.json({ ...responsePayload, replayed: false }, 201);
});

app.get('/api/reimbursements/batches', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer']);
  if (isResponse(auth)) return auth;
  const baseSql = `SELECT batch.id, batch.submission_id, batch.payer_id, payer.display_name AS payer_name,
      batch.coverage_start, batch.coverage_end, batch.total_cny_fen, batch.status, batch.paid_at,
      submission.cutoff_date, submission.created_at,
      COUNT(item.id) AS item_count
    FROM reimbursement_batches AS batch
    JOIN reimbursement_submissions AS submission ON submission.id = batch.submission_id
    JOIN payers AS payer ON payer.id = batch.payer_id
    LEFT JOIN reimbursement_items AS item ON item.batch_id = batch.id
    `;
  const batches = isGlobalReader(auth)
    ? await c.env.DB.prepare(`${baseSql} GROUP BY batch.id ORDER BY batch.created_at DESC`).all()
    : await c.env.DB.prepare(`${baseSql} WHERE payer.owner_user_id = ? GROUP BY batch.id ORDER BY batch.created_at DESC`).bind(auth.userId).all();
  return c.json({ data: batches.results });
});

app.post('/api/reimbursements/:batchId/approve', async (c) => {
  const auth = requireRoles(c, FINANCE_ROLES);
  if (isResponse(auth)) return auth;
  const batchId = c.req.param('batchId');
  const batch = await fetchBatchForScope(c.env, auth, batchId);
  if (!batch) return problem(c, 404, 'batch_not_found', '报销批次不存在。');
  if (!['submitted', 'reviewing'].includes(batch.status)) return problem(c, 409, 'batch_not_approvable', '当前批次状态不能审核通过。');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE reimbursement_batches SET status = 'approved' WHERE id = ? AND status IN ('submitted', 'reviewing')`).bind(batchId),
    c.env.DB.prepare(`UPDATE reimbursement_items SET status = 'approved' WHERE batch_id = ? AND status IN ('submitted', 'draft')`).bind(batchId),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'approve_reimbursement_batch', 'reimbursement_batch', ?, '{}')`,
    ).bind(crypto.randomUUID(), auth.userId, batchId),
  ]);
  return c.json({ batch_id: batchId, status: 'approved' });
});

app.post('/api/reimbursements/:batchId/mark-paid', async (c) => {
  const auth = requireRoles(c, FINANCE_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const paidAt = isoDate(requiredString(body, 'paid_at', 10), 'paid_at');
  const batchId = c.req.param('batchId');
  const batch = await fetchBatchForScope(c.env, auth, batchId);
  if (!batch) return problem(c, 404, 'batch_not_found', '报销批次不存在。');
  if (batch.status !== 'approved') return problem(c, 409, 'batch_not_payable', '只有已审核通过的报销批次可以确认付款。');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE reimbursement_batches SET status = 'paid', paid_at = ?
       WHERE id = ? AND status = 'approved'`,
    ).bind(paidAt, batchId),
    c.env.DB.prepare(
      `UPDATE reimbursement_items SET status = 'paid'
       WHERE batch_id = ? AND status = 'approved'`,
    ).bind(batchId),
    c.env.DB.prepare(
      `UPDATE reimbursement_candidates SET status = 'paid'
       WHERE id IN (SELECT candidate_id FROM reimbursement_items WHERE batch_id = ? AND status = 'paid')`,
    ).bind(batchId),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'mark_reimbursement_batch_paid', 'reimbursement_batch', ?, ?)`,
    ).bind(crypto.randomUUID(), auth.userId, batchId, JSON.stringify({ paid_at: paidAt })),
  ]);
  return c.json({ batch_id: batchId, status: 'paid', paid_at: paidAt, watermarks: await deriveBatchWatermarks(c.env, batchId) });
});

type CandidateGenerationSource = {
  term_version_id: string;
  subscription_id: string;
  billing_cycle: 'monthly' | 'quarterly' | 'yearly' | 'one_time';
  settlement_mode: 'actual_bill' | 'accrual';
  term_effective_start: string;
  term_effective_end: string | null;
  billing_anchor_date: string;
  original_currency: string;
  amount_minor: number;
  payer_assignment_id: string;
  payer_id: string;
  payer_effective_start: string;
  payer_effective_end: string | null;
};

function laterDate(left: string, right: string): string {
  return left > right ? left : right;
}

async function latestLockedFxRate(
  env: Env,
  currency: string,
  cutoffDate: string,
): Promise<{ fxQuoteId: string | null; rateNumerator: number; rateDenominator: number }> {
  if (currency === 'CNY') return { fxQuoteId: null, rateNumerator: 1, rateDenominator: 1 };
  const quote = await env.DB.prepare(
    `SELECT id, rate_numerator, rate_denominator
     FROM fx_quotes
     WHERE base_currency = ? AND quote_currency = 'CNY'
       AND status IN ('verified', 'manual') AND effective_at <= ?
     ORDER BY effective_at DESC, fetched_at DESC
     LIMIT 1`,
  ).bind(currency, cutoffDate).first<{ id: string; rate_numerator: number; rate_denominator: number }>();
  if (!quote) throw new ApiProblem(409, 'missing_fx_quote', `${currency} 在 ${cutoffDate} 前没有可锁定的 CNY 汇率快照。`);
  return { fxQuoteId: quote.id, rateNumerator: quote.rate_numerator, rateDenominator: quote.rate_denominator };
}

async function paidWatermarkForAssignment(
  env: Env,
  source: CandidateGenerationSource,
): Promise<string | null> {
  const paid = await env.DB.prepare(
    `SELECT item.coverage_start AS start, item.coverage_end AS end
     FROM reimbursement_items AS item
     JOIN reimbursement_candidates AS candidate ON candidate.id = item.candidate_id
     WHERE candidate.subscription_term_version_id = ?
       AND candidate.payer_assignment_id = ?
       AND item.status = 'paid'
     ORDER BY item.coverage_start`,
  ).bind(source.term_version_id, source.payer_assignment_id).all<{ start: string; end: string }>();
  return deriveContiguousPaidThrough({
    startDate: laterDate(source.term_effective_start, source.payer_effective_start),
    paidCoverages: paid.results,
  });
}

/**
 * 根据版本化条款、付款者有效期和连续已付款水位生成候选。它只创建未存在的
 * 费用快照；实际报销选择仍由单独的 batch API 管理。
 */
app.post('/api/reimbursements/generate-candidates', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const cutoffDate = isoDate(requiredString(body, 'cutoff_date', 10), 'cutoff_date');
  const subscriptionId = optionalString(body, 'subscription_id', 80);
  const sources = await c.env.DB.prepare(
    `SELECT
       term.id AS term_version_id, subscription.id AS subscription_id,
       term.billing_cycle, term.settlement_mode,
       term.effective_start AS term_effective_start, term.effective_end AS term_effective_end,
       term.billing_anchor_date, term.original_currency, term.amount_minor,
       assignment.id AS payer_assignment_id, assignment.payer_id,
       assignment.effective_start AS payer_effective_start, assignment.effective_end AS payer_effective_end
     FROM subscription_term_versions AS term
     JOIN subscriptions AS subscription ON subscription.id = term.subscription_id
     JOIN payer_assignments AS assignment ON assignment.subscription_id = subscription.id
     WHERE subscription.status = 'active'
       AND term.effective_start <= ?
       AND (term.effective_end IS NULL OR term.effective_end >= ?)
       AND assignment.effective_start <= ?
       AND (assignment.effective_end IS NULL OR assignment.effective_end >= ?)
       AND (? IS NULL OR subscription.id = ?)
     ORDER BY subscription.id, term.effective_start, assignment.effective_start`,
  ).bind(cutoffDate, cutoffDate, cutoffDate, cutoffDate, subscriptionId, subscriptionId).all<CandidateGenerationSource>();

  const drafts: Array<{
    termVersionId: string;
    payerAssignmentId: string;
    fxQuoteId: string | null;
    coverageStart: string;
    coverageEnd: string;
    originalCurrency: string;
    originalAmountMinor: number;
    rateNumerator: number;
    rateDenominator: number;
    cnyAmountFen: number;
  }> = [];
  for (const source of sources.results) {
    const fx = await latestLockedFxRate(c.env, source.original_currency, cutoffDate);
    const lastReimbursedThrough = await paidWatermarkForAssignment(c.env, source);
    const request = {
      subscriptionId: source.subscription_id,
      payerId: source.payer_id,
      currency: source.original_currency,
      amountMinor: source.amount_minor,
      billingCycle: source.billing_cycle,
      billingAnchorDate: source.billing_anchor_date,
      subscriptionStartDate: source.term_effective_start,
      ...(source.term_effective_end ? { subscriptionEndDate: source.term_effective_end } : {}),
      payerActiveFrom: source.payer_effective_start,
      ...(source.payer_effective_end ? { payerActiveUntil: source.payer_effective_end } : {}),
      ...(lastReimbursedThrough ? { lastReimbursedThrough } : {}),
      cutoffDate,
      rate: { numerator: fx.rateNumerator, denominator: fx.rateDenominator },
    };
    const generated = source.settlement_mode === 'actual_bill'
      ? buildActualBillCandidates(request)
      : buildAccrualCandidates(request);
    for (const candidate of generated) {
      drafts.push({
        termVersionId: source.term_version_id,
        payerAssignmentId: source.payer_assignment_id,
        fxQuoteId: fx.fxQuoteId,
        coverageStart: candidate.coverageStart,
        coverageEnd: candidate.coverageEnd,
        originalCurrency: candidate.originalCurrency,
        originalAmountMinor: candidate.originalAmountMinor,
        rateNumerator: candidate.rateNumerator,
        rateDenominator: candidate.rateDenominator,
        cnyAmountFen: candidate.cnyAmountFen,
      });
    }
  }
  if (drafts.length === 0) return c.json({ generated: 0, source_count: sources.results.length, cutoff_date: cutoffDate });
  const statements: D1PreparedStatement[] = drafts.map((candidate) => c.env.DB.prepare(
    `INSERT INTO reimbursement_candidates (
       id, subscription_term_version_id, payer_assignment_id,
       coverage_start, coverage_end, original_currency, original_amount_minor,
       fx_quote_id, rate_numerator, rate_denominator, cny_amount_fen, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT DO NOTHING`,
  ).bind(
    crypto.randomUUID(),
    candidate.termVersionId,
    candidate.payerAssignmentId,
    candidate.coverageStart,
    candidate.coverageEnd,
    candidate.originalCurrency,
    candidate.originalAmountMinor,
    candidate.fxQuoteId,
    candidate.rateNumerator,
    candidate.rateDenominator,
    candidate.cnyAmountFen,
  ));
  statements.push(c.env.DB.prepare(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
     VALUES (?, ?, 'generate_reimbursement_candidates', 'candidate_generation', ?, ?)`,
  ).bind(crypto.randomUUID(), auth.userId, cutoffDate, JSON.stringify({ source_count: sources.results.length, drafted_count: drafts.length })));
  const results = await c.env.DB.batch(statements);
  const inserted = results.slice(0, drafts.length).filter((result) => result.meta.changes === 1).length;
  return c.json({ generated: inserted, skipped_existing: drafts.length - inserted, source_count: sources.results.length, cutoff_date: cutoffDate }, 201);
});

app.get('/api/fx-quotes', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer']);
  if (isResponse(auth)) return auth;
  const quotes = await c.env.DB.prepare(
    `SELECT id, base_currency, quote_currency, rate_numerator, rate_denominator,
            effective_at, fetched_at, provider, provider_reference, status, locked_at
     FROM fx_quotes ORDER BY effective_at DESC, base_currency`,
  ).all();
  return c.json({ data: quotes.results });
});

app.post('/api/fx-quotes', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const baseCurrency = requiredString(body, 'base_currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency)) throw new ApiProblem(400, 'invalid_currency', 'base_currency 必须是三位 ISO 币种代码。');
  const rateNumerator = integer(body, 'rate_numerator', 1);
  const rateDenominator = integer(body, 'rate_denominator', 1);
  if (baseCurrency === 'CNY' && (rateNumerator !== 1 || rateDenominator !== 1)) {
    throw new ApiProblem(400, 'invalid_cny_rate', 'CNY 汇率快照必须固定为 1 / 1。');
  }
  const rawEffectiveAt = requiredString(body, 'effective_at', 40);
  const effectiveAt = isoDate(rawEffectiveAt.slice(0, 10), 'effective_at');
  const provider = requiredString(body, 'provider', 80);
  const providerReference = optionalString(body, 'provider_reference', 255);
  await c.env.DB.prepare(
    `INSERT INTO fx_quotes (
       id, base_currency, quote_currency, rate_numerator, rate_denominator,
       effective_at, provider, provider_reference, status, locked_at
     ) VALUES (?, ?, 'CNY', ?, ?, ?, ?, ?, 'manual', datetime('now'))`,
  ).bind(id, baseCurrency, rateNumerator, rateDenominator, effectiveAt, provider, providerReference).run();
  await appendAudit(c.env, auth.userId, 'create_manual_fx_quote', 'fx_quote', id, { base_currency: baseCurrency, effective_at: effectiveAt });
  return c.json({ fx_quote_id: id }, 201);
});

app.post('/api/exchange-rates/sync', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer']);
  if (isResponse(auth)) return auth;
  const result = await syncConfiguredFxRates(c.env);
  await appendAudit(c.env, auth.userId, 'sync_fx_rates', 'sync_run', result.runId, { status: result.status, inserted: result.inserted });
  if (result.status === 'failed') {
    return c.json({ error: { code: result.errorCode, message: '汇率同步未执行或失败；系统没有填入猜测汇率。' }, sync_run_id: result.runId }, 501);
  }
  return c.json({ sync_run_id: result.runId, inserted: result.inserted });
});

app.get('/api/imports', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor']);
  if (isResponse(auth)) return auth;
  const importResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT run.id, run.mode, run.status, run.cursor, run.summary_json,
              run.started_at, run.finished_at, connection.display_name AS connection_name,
              schema_version.status AS schema_status
       FROM source_import_runs AS run
       JOIN source_connections AS connection ON connection.id = run.connection_id
       LEFT JOIN source_schema_versions AS schema_version ON schema_version.id = run.schema_version_id
       ORDER BY run.started_at DESC LIMIT 100`,
    ),
    c.env.DB.prepare(
      `SELECT id, kind, status, started_at, finished_at, error_code, detail_json
       FROM sync_runs ORDER BY started_at DESC LIMIT 100`,
    ),
  ]);
  return c.json({
    data: {
      feishu_import_runs: importResults[0]?.results ?? [],
      sync_runs: importResults[1]?.results ?? [],
    },
  });
});

/**
 * 读取真实 Base 元数据和记录数量，但不写回 Base，也不返回敏感 token 或原始
 * 记录内容。字段 ID 将作为后续映射审批的唯一锚点。
 */
app.post('/api/imports/feishu/preview', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const config = feishuSourceConfigFromEnv(c.env);
  if (!isFeishuImportConfigured(config)) {
    return problem(c, 503, 'feishu_import_not_configured', '飞书只读应用尚未配置或导入开关未开启。');
  }
  const connectionId = 'source-feishu-base-primary';
  const importRunId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO source_connections (id, source_system, display_name, import_enabled)
       VALUES (?, 'feishu_base', '兰芯云朵资产管理（只读）', 1)`,
    ).bind(connectionId),
    c.env.DB.prepare(
      `INSERT INTO source_import_runs (id, connection_id, mode, status)
       VALUES (?, ?, 'preview', 'running')`,
    ).bind(importRunId, connectionId),
  ]);
  try {
    const requestedTables = [c.env.FEISHU_PERSON_TABLE_ID, c.env.FEISHU_SUBSCRIPTION_TABLE_ID]
      .filter((tableId): tableId is string => Boolean(tableId));
    const discovery = await new FeishuBaseReader(config).discover(requestedTables);
    const sourceMetadata: FeishuTableMetadata[] = discovery.map((entry) => ({
      tableId: entry.table.tableId,
      name: entry.table.name,
      fields: entry.fields.map((field) => ({ fieldId: field.fieldId, name: field.name })),
    }));
    const mappingProposal = proposeFeishuFieldMapping(sourceMetadata);
    const schema = {
      source: 'feishu_base',
      tables: discovery.map((entry) => ({
        table_id: entry.table.tableId,
        table_name: entry.table.name,
        record_count: entry.recordCount,
        fields: entry.fields.map((field) => ({ field_id: field.fieldId, name: field.name, type: field.type })),
      })),
      mapping_proposal: mappingProposal,
    };
    const schemaHash = await sha256Hex(JSON.stringify(schema));
    const existing = await c.env.DB.prepare(
      `SELECT id, status FROM source_schema_versions WHERE connection_id = ? AND schema_hash = ?`,
    ).bind(connectionId, schemaHash).first<{ id: string; status: 'approved' | 'schema_drift' | 'retired' }>();
    const schemaVersionId = existing?.id ?? crypto.randomUUID();
    const schemaStatus = existing?.status ?? 'schema_drift';
    if (!existing) {
      await c.env.DB.prepare(
        `INSERT INTO source_schema_versions (id, connection_id, schema_hash, mapping_json, status)
         VALUES (?, ?, ?, ?, 'schema_drift')`,
      ).bind(schemaVersionId, connectionId, schemaHash, JSON.stringify(schema)).run();
    }
    const runStatus = schemaStatus === 'approved' ? 'success' : 'schema_drift';
    await c.env.DB.prepare(
      `UPDATE source_import_runs
       SET schema_version_id = ?, status = ?, summary_json = ?, finished_at = datetime('now')
       WHERE id = ?`,
    ).bind(schemaVersionId, runStatus, JSON.stringify({ table_count: discovery.length, schema_hash: schemaHash }), importRunId).run();
    await appendAudit(c.env, auth.userId, 'preview_feishu_source', 'source_import_run', importRunId, { table_count: discovery.length, schema_status: schemaStatus });
    return c.json({
      data: {
        import_run_id: importRunId,
        schema_version_id: schemaVersionId,
        schema_status: schemaStatus,
        requires_mapping_approval: schemaStatus !== 'approved',
        mapping_proposal: mappingProposal,
        tables: schema.tables,
      },
    });
  } catch {
    await c.env.DB.prepare(
      `UPDATE source_import_runs
       SET status = 'failed', finished_at = datetime('now'), summary_json = '{"message":"read-only source preview failed"}'
       WHERE id = ?`,
    ).bind(importRunId).run();
    return problem(c, 502, 'feishu_preview_failed', '无法读取飞书只读来源；请检查应用权限、Base 共享范围和字段配置。');
  }
});

app.post('/api/imports/feishu/schema-versions/:schemaVersionId/approve', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  const schemaVersionId = c.req.param('schemaVersionId');
  const schemaVersion = await c.env.DB.prepare(
    `SELECT id, status, mapping_json FROM source_schema_versions WHERE id = ?`,
  ).bind(schemaVersionId).first<{ id: string; status: string; mapping_json: string }>();
  if (!schemaVersion) return problem(c, 404, 'schema_version_not_found', '来源结构版本不存在。');
  if (schemaVersion.status === 'approved') return c.json({ schema_version_id: schemaVersionId, status: 'approved' });
  let proposal: unknown;
  try {
    const stored = JSON.parse(schemaVersion.mapping_json) as { mapping_proposal?: unknown };
    proposal = stored.mapping_proposal;
  } catch {
    return problem(c, 409, 'mapping_document_invalid', '来源映射文档损坏，不能审批。');
  }
  if (!isRecord(proposal) || proposal.status !== 'pending_approval' || !isRecord(proposal.diagnostics) || proposal.diagnostics.readiness !== 'ready') {
    return problem(c, 409, 'mapping_not_ready', '字段 ID 映射仍有缺失或歧义，不能审批。');
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE source_schema_versions SET status = 'approved' WHERE id = ? AND status = 'schema_drift'`,
    ).bind(schemaVersionId),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'approve_feishu_field_mapping', 'source_schema_version', ?, '{}')`,
    ).bind(crypto.randomUUID(), auth.userId, schemaVersionId),
  ]);
  return c.json({ schema_version_id: schemaVersionId, status: 'approved' });
});

app.post('/api/imports/feishu/apply', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  // 明确禁止依据中文列名猜测映射。只有字段 ID 映射被管理员审批后，才应开放 apply。
  return problem(c, 409, 'mapping_approval_required', '当前只开放只读预览。请先确认并审批字段 ID 映射，再启用正式导入。');
});

app.get('/api/audit-events', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'auditor', 'finance_reviewer']);
  if (isResponse(auth)) return auth;
  const requestedLimit = Number(c.req.query('limit') ?? '100');
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 250)) : 100;
  const events = await c.env.DB.prepare(
    `SELECT event.id, event.action, event.entity_type, event.entity_id, event.detail_json, event.created_at,
            user.display_name AS actor_name
     FROM audit_events AS event
     LEFT JOIN users AS user ON user.id = event.actor_id
     ORDER BY event.created_at DESC LIMIT ?`,
  ).bind(limit).all();
  return c.json({ data: events.results });
});

app.post('/api/attachments/:entityType/:entityId', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'payer']);
  if (isResponse(auth)) return auth;
  if (!c.env.RECEIPTS_BUCKET) return problem(c, 503, 'receipt_storage_not_configured', '报销附件 R2 存储桶尚未配置。');
  const entityType = c.req.param('entityType');
  if (!['candidate', 'batch', 'item'].includes(entityType)) return problem(c, 400, 'invalid_attachment_entity', '附件只能关联候选、批次或报销明细。');
  const entityId = c.req.param('entityId');
  const tableByEntity: Record<string, string> = {
    candidate: 'reimbursement_candidates',
    batch: 'reimbursement_batches',
    item: 'reimbursement_items',
  };
  const exists = await c.env.DB.prepare(`SELECT id FROM ${tableByEntity[entityType]!} WHERE id = ?`).bind(entityId).first<{ id: string }>();
  if (!exists) return problem(c, 404, 'attachment_entity_not_found', '附件关联的业务对象不存在。');
  const contentLength = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 10 * 1024 * 1024) {
    return problem(c, 413, 'attachment_too_large', '附件不得超过 10 MB。');
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > 10 * 1024 * 1024) return problem(c, 413, 'attachment_too_large', '附件必须介于 1 B 和 10 MB 之间。');
  const fileName = (c.req.header('X-File-Name') ?? 'receipt.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'receipt.bin';
  const attachmentId = crypto.randomUUID();
  const objectKey = `receipts/${entityType}/${entityId}/${attachmentId}-${fileName}`;
  await c.env.RECEIPTS_BUCKET.put(objectKey, body, { httpMetadata: { contentType: c.req.header('Content-Type') ?? 'application/octet-stream' } });
  try {
    await c.env.DB.prepare(
      `INSERT INTO attachments (id, entity_type, entity_id, r2_object_key, file_name, content_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(attachmentId, entityType, entityId, objectKey, fileName, c.req.header('Content-Type') ?? null, body.byteLength, auth.userId).run();
  } catch (error) {
    await c.env.RECEIPTS_BUCKET.delete(objectKey);
    throw error;
  }
  await appendAudit(c.env, auth.userId, 'upload_receipt_attachment', entityType, entityId, { attachment_id: attachmentId, size_bytes: body.byteLength });
  return c.json({ attachment_id: attachmentId }, 201);
});

app.get('/api/attachments/:attachmentId', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer']);
  if (isResponse(auth)) return auth;
  if (!c.env.RECEIPTS_BUCKET) return problem(c, 503, 'receipt_storage_not_configured', '报销附件 R2 存储桶尚未配置。');
  const attachment = await c.env.DB.prepare(
    `SELECT attachment.id, attachment.r2_object_key, attachment.file_name, attachment.content_type,
            attachment.size_bytes,
            COALESCE(candidate_payer.owner_user_id, batch_payer.owner_user_id, item_payer.owner_user_id) AS payer_owner_user_id
     FROM attachments AS attachment
     LEFT JOIN reimbursement_candidates AS candidate
       ON attachment.entity_type = 'candidate' AND candidate.id = attachment.entity_id
     LEFT JOIN payer_assignments AS candidate_assignment ON candidate_assignment.id = candidate.payer_assignment_id
     LEFT JOIN payers AS candidate_payer ON candidate_payer.id = candidate_assignment.payer_id
     LEFT JOIN reimbursement_batches AS batch
       ON attachment.entity_type = 'batch' AND batch.id = attachment.entity_id
     LEFT JOIN payers AS batch_payer ON batch_payer.id = batch.payer_id
     LEFT JOIN reimbursement_items AS item
       ON attachment.entity_type = 'item' AND item.id = attachment.entity_id
     LEFT JOIN payers AS item_payer ON item_payer.id = item.payer_id
     WHERE attachment.id = ?`,
  ).bind(c.req.param('attachmentId')).first<{
    id: string;
    r2_object_key: string;
    file_name: string;
    content_type: string | null;
    size_bytes: number;
    payer_owner_user_id: string | null;
  }>();
  if (!attachment) return problem(c, 404, 'attachment_not_found', '附件不存在。');
  if (!isGlobalReader(auth) && (!auth.roles.includes('payer') || attachment.payer_owner_user_id !== auth.userId)) {
    return problem(c, 403, 'payer_scope_denied', '付款者只能读取归属自己的附件。');
  }
  const object = await c.env.RECEIPTS_BUCKET.get(attachment.r2_object_key);
  if (!object) return problem(c, 404, 'attachment_object_not_found', '附件对象已不存在，请检查存储审计记录。');
  const fileName = attachment.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(object.body, {
    headers: {
      'Content-Type': attachment.content_type ?? object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Length': String(attachment.size_bytes),
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

function renderUiRoute(
  c: AppContext,
  page: UiPage,
  options: { status?: 200 | 404; trustedBody?: string } = {},
): Response {
  const entry = c.get('entry');
  const principal = c.get('principal');
  if (entry?.kind === 'external') {
    if (!c.get('signedIdentity')) return c.html(renderExternalAccessRequiredUi(), 401);
    if (page === 'profile') return c.redirect('https://ie-oa.lancloudtech.com/profile', 302);
    if (!principal) return c.html(renderExternalIdentityUi());
  } else if (entry?.kind === 'corporate' && !principal) {
    return c.html(renderCorporateAccessRequiredUi(), 401);
  }

  if (!principal) return c.html(renderCorporateAccessRequiredUi(), 401);
  return c.html(renderAdminUi({
    page,
    principal: { displayName: principal.email, roles: principal.roles },
    trustedBody: options.trustedBody,
  }), options.status ?? 200);
}

app.get('/', (c) => renderUiRoute(c, 'dashboard'));

for (const route of ['/subscriptions', '/accounts', '/reimbursements', '/rates', '/people', '/imports', '/profile']) {
  app.get(route, (c) => renderUiRoute(c, uiPageFromPath(new URL(c.req.url).pathname)));
}

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return problem(c, 404, 'not_found', 'API 路径不存在。');
  return renderUiRoute(c, 'dashboard', {
    status: 404,
    trustedBody: '<section class="notice warning"><strong>页面不存在。</strong> 请从左侧导航进入系统功能。</section>',
  });
});

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncConfiguredFxRates(env));
  },
} satisfies ExportedHandler<Env>;
