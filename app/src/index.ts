// 兰芯云朵行政——订阅资产管理系统 · Cloudflare Worker 入口
//
// 设计边界：飞书 Base 仅可被只读导入；D1 才是订阅、汇率与报销账本的唯一真相。
// 所有财务金额均使用 INTEGER 最小单位；任何浏览器提交的金额、付款者或汇率
// 都不会被直接写入报销明细。

import { Hono, type Context } from 'hono';
import {
  APP_ROLES,
  resolveAuthenticatedIdentity,
  validateIdentityForEntry,
  type AppRole,
  type AuthenticatedIdentity,
  type Principal,
} from './lib/auth';
import { accessEntryForRequest, isAllowedEntryOrigin, normalizeVerifiedEmail, type AccessEntry } from './lib/access-entry';
import { IdentityProblem, IdentityStore } from './lib/identity-store';
import { fetchCnyRate, rateToMinorUnitRational } from './lib/fx';
import {
  BILLING_CYCLES,
  buildActualBillCandidates,
  deriveContiguousPaidThrough,
} from './lib/reimbursement-engine';
import {
  displayUntil,
  generationEndCap,
  shouldMarkEnded,
  sunsetReason,
} from './lib/subscription-sunset';
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
  uiPageFromPath,
  type UiPage,
} from './ui';

type AppVariables = {
  entry: AccessEntry | null;
  principal: Principal | null;
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
  fetcher?: typeof fetch;
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

function identityProblemResponse(c: AppContext, error: IdentityProblem): Response {
  const status = error.code === 'identity_store_unavailable'
    ? 503
    : error.code === 'corporate_email_required' || error.code === 'corporate_identity_required' || error.code === 'email_not_whitelisted'
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

function assertCutoffNotFuture(cutoffDate: string): void {
  if (cutoffDate > shanghaiBusinessDate()) {
    throw new ApiProblem(400, 'cutoff_in_future', '报销截止日不能晚于今天；系统不允许提前开始未来的报销。');
  }
}

/** 报销截止日可选：缺省按 Asia/Shanghai 业务当天；任何情况都不允许未来日期。 */
function resolveCutoffDate(body: Record<string, unknown>): string {
  const cutoffDate = body.cutoff_date === undefined || body.cutoff_date === null || body.cutoff_date === ''
    ? shanghaiBusinessDate()
    : isoDate(requiredString(body, 'cutoff_date', 10), 'cutoff_date');
  assertCutoffNotFuture(cutoffDate);
  return cutoffDate;
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
  if (!isGlobalReader(principal) && candidates.some((candidate) => candidate.payer_owner_user_id !== principal.userId)) {
    throw new ApiProblem(403, 'payer_scope_denied', '只能操作付款者为自己的候选费用。');
  }
  return candidates;
}

async function fetchMonthlyPaidSeries(env: Env): Promise<Array<{ month: string; total_cny_fen: number }>> {
  const today = shanghaiBusinessDate();
  const monthIndex = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 - 11;
  const startMonth = `${Math.floor(monthIndex / 12)}-${String((monthIndex % 12) + 1).padStart(2, '0')}-01`;
  const rows = await env.DB.prepare(
    `SELECT strftime('%Y-%m', paid_at) AS month, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
     FROM reimbursement_batches
     WHERE status = 'paid' AND paid_at >= ?
     GROUP BY month ORDER BY month`,
  ).bind(startMonth).all<{ month: string; total_cny_fen: number }>();
  const byMonth = new Map(rows.results.map((row) => [row.month, row.total_cny_fen]));
  const series: Array<{ month: string; total_cny_fen: number }> = [];
  const cursor = new Date(`${startMonth}T00:00:00.000Z`);
  for (let index = 0; index < 12; index += 1) {
    const key = cursor.toISOString().slice(0, 7);
    series.push({ month: key, total_cny_fen: byMonth.get(key) ?? 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return series;
}

async function fetchBatchForScope(
  env: Env,
  principal: Principal,
  batchId: string,
): Promise<{ id: string; status: string; payer_id: string; payer_owner_user_id: string | null; reviewer_user_id: string | null } | null> {
  const batch = await env.DB.prepare(
    `SELECT batch.id, batch.status, batch.payer_id, batch.reviewer_user_id, payer.owner_user_id AS payer_owner_user_id
     FROM reimbursement_batches AS batch
     JOIN payers AS payer ON payer.id = batch.payer_id
     WHERE batch.id = ?`,
  )
    .bind(batchId)
    .first<{ id: string; status: string; payer_id: string; payer_owner_user_id: string | null; reviewer_user_id: string | null }>();
  if (!batch) return null;
  const canAccess = isGlobalReader(principal)
    || batch.payer_owner_user_id === principal.userId
    || batch.reviewer_user_id === principal.userId;
  if (!canAccess) {
    throw new ApiProblem(403, 'payer_scope_denied', '只能操作付款者为自己或指派给自己审批的报销批次。');
  }
  return batch;
}

/** 审批/付款必须由被指派的审批人完成；system_admin 可代行，历史无指派批次维持财务角色可办。 */
function assertBatchReviewer(principal: Principal, batch: { reviewer_user_id: string | null }): void {
  if (principal.roles.includes('system_admin')) return;
  if (!batch.reviewer_user_id) return;
  if (batch.reviewer_user_id !== principal.userId) {
    throw new ApiProblem(403, 'reviewer_required', '该批次已指派给其他审批人，只能由其完成审批。');
  }
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

async function findUniqueUserIdByName(
  env: Env,
  displayName: string,
): Promise<{ outcome: 'found'; userId: string } | { outcome: 'none' } | { outcome: 'ambiguous' }> {
  const rows = await env.DB.prepare('SELECT id FROM users WHERE display_name = ?')
    .bind(displayName)
    .all<{ id: string }>();
  if (rows.results.length > 1) return { outcome: 'ambiguous' };
  if (rows.results.length === 1) return { outcome: 'found', userId: rows.results[0]!.id };
  return { outcome: 'none' };
}

/** 导入创建的人员不是登录身份：不写 email / external_subject，也不授予任何角色。 */
async function createImportedUser(env: Env, displayName: string): Promise<string> {
  const userId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id, display_name, employment_status) VALUES (?, ?, 'active')`)
    .bind(userId, displayName)
    .run();
  return userId;
}

type CandidateGenerationSource = {
  term_version_id: string;
  subscription_id: string;
  auto_renew: number;
  billing_cycle: typeof BILLING_CYCLES[number];
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

/**
 * 锁定订阅开始日当天的 CNY 汇率：优先使用当天已有快照；缺失且配置了汇率服务时
 * 自动抓取该日历史汇率入库后锁定；服务不可用时不猜测，明确报错等待人工处理。
 */
async function fxRateForSubscriptionStart(
  env: Env,
  currency: string,
  startDate: string,
  cutoffDate: string,
  fetcher: typeof fetch,
): Promise<{ fxQuoteId: string | null; rateNumerator: number; rateDenominator: number }> {
  if (currency === 'CNY') return { fxQuoteId: null, rateNumerator: 1, rateDenominator: 1 };
  const exact = await env.DB.prepare(
    `SELECT id, rate_numerator, rate_denominator
     FROM fx_quotes
     WHERE base_currency = ? AND quote_currency = 'CNY'
       AND status IN ('verified', 'manual') AND effective_at = ?
     ORDER BY fetched_at DESC LIMIT 1`,
  ).bind(currency, startDate).first<{ id: string; rate_numerator: number; rate_denominator: number }>();
  if (exact) return { fxQuoteId: exact.id, rateNumerator: exact.rate_numerator, rateDenominator: exact.rate_denominator };
  if (env.FX_PROVIDER && env.FX_PROVIDER_URL) {
    let quote: Awaited<ReturnType<typeof fetchCnyRate>>;
    try {
      quote = await fetchCnyRate({
        baseCurrency: currency,
        providerUrl: env.FX_PROVIDER_URL,
        ...(env.FX_API_KEY ? { apiKey: env.FX_API_KEY } : {}),
        date: startDate,
        fetcher,
      });
    } catch {
      throw new ApiProblem(502, 'fx_provider_request_failed', `${currency} 在 ${startDate} 的历史汇率抓取失败；请稍后重试或人工补录。`);
    }
    const rational = rateToMinorUnitRational(quote.cnyPerWholeUnit, currencyMinorDigits(currency));
    const effectiveAt = quote.providerReference && /^\d{4}-\d{2}-\d{2}$/.test(quote.providerReference)
      ? quote.providerReference
      : startDate;
    await env.DB.prepare(
      `INSERT INTO fx_quotes (
         id, base_currency, quote_currency, rate_numerator, rate_denominator,
         effective_at, provider, provider_reference, raw_response_hash, status, locked_at
       ) VALUES (?, ?, 'CNY', ?, ?, ?, ?, ?, ?, 'verified', datetime('now'))
       ON CONFLICT(base_currency, quote_currency, effective_at, provider) DO NOTHING`,
    ).bind(
      crypto.randomUUID(),
      currency,
      rational.numerator,
      rational.denominator,
      effectiveAt,
      env.FX_PROVIDER,
      quote.providerReference ?? null,
      await sha256Hex(quote.rawResponse),
    ).run();
    const stored = await env.DB.prepare(
      `SELECT id, rate_numerator, rate_denominator
       FROM fx_quotes
       WHERE base_currency = ? AND quote_currency = 'CNY' AND effective_at = ? AND provider = ?
       LIMIT 1`,
    ).bind(currency, effectiveAt, env.FX_PROVIDER).first<{ id: string; rate_numerator: number; rate_denominator: number }>();
    if (stored) return { fxQuoteId: stored.id, rateNumerator: stored.rate_numerator, rateDenominator: stored.rate_denominator };
  }
  return latestLockedFxRate(env, currency, cutoffDate);
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
 * 一次性从开始日展示一个月；不自动续费或已到期则展示到当前账期的下一周期开始日。
 */
async function lapseTerminalSubscriptions(env: Env, today: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT
       subscription.id AS id,
       subscription.auto_renew AS auto_renew,
       term.billing_cycle AS billing_cycle,
       term.effective_start AS term_start,
       term.effective_end AS term_end,
       term.billing_anchor_date AS billing_anchor_date
     FROM subscriptions AS subscription
     LEFT JOIN subscription_term_versions AS term
       ON term.id = (
         SELECT candidate.id
         FROM subscription_term_versions AS candidate
         WHERE candidate.subscription_id = subscription.id
         ORDER BY
           CASE
             WHEN candidate.effective_start <= ?
               AND (candidate.effective_end IS NULL OR candidate.effective_end >= ?)
             THEN 0
             ELSE 1
           END,
           candidate.effective_start DESC
         LIMIT 1
       )
     WHERE subscription.status = 'active'`,
  ).bind(today, today).all<{
    id: string;
    auto_renew: number;
    billing_cycle: typeof BILLING_CYCLES[number] | null;
    term_start: string | null;
    term_end: string | null;
    billing_anchor_date: string | null;
  }>();

  const ended: Array<{ id: string; reason: string; displayUntil: string }> = [];
  for (const row of rows.results) {
    const reason = sunsetReason({
      billingCycle: row.billing_cycle,
      autoRenew: Boolean(row.auto_renew),
      termEnd: row.term_end,
    });
    if (!reason) continue;
    const until = displayUntil({
      billingCycle: row.billing_cycle,
      autoRenew: Boolean(row.auto_renew),
      termStart: row.term_start,
      termEnd: row.term_end,
      billingAnchorDate: row.billing_anchor_date,
    });
    if (!until || !shouldMarkEnded(today, until)) continue;
    ended.push({ id: row.id, reason, displayUntil: until });
  }
  if (ended.length === 0) return 0;
  await env.DB.batch(ended.flatMap((item) => [
    env.DB.prepare(
      `UPDATE subscriptions SET status = 'ended', updated_at = datetime('now') WHERE id = ? AND status = 'active'`,
    ).bind(item.id),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, NULL, 'lapse_subscription', 'subscription', ?, ?)`,
    ).bind(crypto.randomUUID(), item.id, JSON.stringify({
      reason: item.reason,
      display_until: item.displayUntil,
    })),
  ]));
  return ended.length;
}

/**
 * 根据版本化条款、付款者有效期和连续已付款水位生成候选。它只创建未存在的
 * 费用快照；实际报销选择仍由单独的 batch API 管理。
 */
async function generateReimbursementCandidates(
  env: Env,
  options: {
    cutoffDate: string;
    fetcher: typeof fetch;
    subscriptionId?: string | null;
    payerOwnerUserId?: string | null;
  },
): Promise<{
  generated: number;
  skipped_existing: number;
  source_count: number;
  drafted_count: number;
  cutoff_date: string;
}> {
  const { cutoffDate, fetcher } = options;
  const subscriptionId = options.subscriptionId ?? null;
  const payerOwnerUserId = options.payerOwnerUserId ?? null;
  const sourceVisibility = `
       WHERE (
         subscription.status = 'active'
         OR (? IS NOT NULL AND subscription.id = ?)
         OR (
           subscription.status = 'ended'
           AND NOT EXISTS (
             SELECT 1 FROM reimbursement_candidates AS existing
             JOIN subscription_term_versions AS existing_term ON existing_term.id = existing.subscription_term_version_id
             WHERE existing_term.subscription_id = subscription.id AND existing.status != 'void'
           )
         )
       )
         AND term.effective_start <= ?
         AND assignment.effective_start <= ?
         AND (assignment.effective_end IS NULL OR assignment.effective_end >= ?)`;
  const sources = payerOwnerUserId
    ? await env.DB.prepare(
      `SELECT
         term.id AS term_version_id, subscription.id AS subscription_id, subscription.auto_renew,
         term.billing_cycle, term.settlement_mode,
         term.effective_start AS term_effective_start, term.effective_end AS term_effective_end,
         term.billing_anchor_date, term.original_currency, term.amount_minor,
         assignment.id AS payer_assignment_id, assignment.payer_id,
         assignment.effective_start AS payer_effective_start, assignment.effective_end AS payer_effective_end
       FROM subscription_term_versions AS term
       JOIN subscriptions AS subscription ON subscription.id = term.subscription_id
       JOIN payer_assignments AS assignment ON assignment.subscription_id = subscription.id
       JOIN payers AS payer ON payer.id = assignment.payer_id
       ${sourceVisibility}
         AND payer.owner_user_id = ?
         AND (? IS NULL OR subscription.id = ?)
       ORDER BY subscription.id, term.effective_start, assignment.effective_start`,
    ).bind(subscriptionId, subscriptionId, cutoffDate, cutoffDate, cutoffDate, payerOwnerUserId, subscriptionId, subscriptionId).all<CandidateGenerationSource>()
    : await env.DB.prepare(
      `SELECT
         term.id AS term_version_id, subscription.id AS subscription_id, subscription.auto_renew,
         term.billing_cycle, term.settlement_mode,
         term.effective_start AS term_effective_start, term.effective_end AS term_effective_end,
         term.billing_anchor_date, term.original_currency, term.amount_minor,
         assignment.id AS payer_assignment_id, assignment.payer_id,
         assignment.effective_start AS payer_effective_start, assignment.effective_end AS payer_effective_end
       FROM subscription_term_versions AS term
       JOIN subscriptions AS subscription ON subscription.id = term.subscription_id
       JOIN payer_assignments AS assignment ON assignment.subscription_id = subscription.id
       ${sourceVisibility}
         AND (? IS NULL OR subscription.id = ?)
       ORDER BY subscription.id, term.effective_start, assignment.effective_start`,
    ).bind(subscriptionId, subscriptionId, cutoffDate, cutoffDate, cutoffDate, subscriptionId, subscriptionId).all<CandidateGenerationSource>();

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
    const fx = await fxRateForSubscriptionStart(env, source.original_currency, source.term_effective_start, cutoffDate, fetcher);
    const lastReimbursedThrough = await paidWatermarkForAssignment(env, source);
    const subscriptionEndDate = generationEndCap({
      billingCycle: source.billing_cycle,
      autoRenew: Boolean(source.auto_renew),
      termStart: source.term_effective_start,
      termEnd: source.term_effective_end,
    });
    const request = {
      subscriptionId: source.subscription_id,
      payerId: source.payer_id,
      currency: source.original_currency,
      amountMinor: source.amount_minor,
      billingCycle: source.billing_cycle,
      billingAnchorDate: source.term_effective_start,
      subscriptionStartDate: source.term_effective_start,
      ...(subscriptionEndDate ? { subscriptionEndDate } : {}),
      payerActiveFrom: source.payer_effective_start,
      ...(source.payer_effective_end ? { payerActiveUntil: source.payer_effective_end } : {}),
      ...(lastReimbursedThrough ? { lastReimbursedThrough } : {}),
      cutoffDate,
      rate: { numerator: fx.rateNumerator, denominator: fx.rateDenominator },
    };
    const generated = buildActualBillCandidates(request);
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
  if (drafts.length === 0) {
    await lapseTerminalSubscriptions(env, cutoffDate);
    return { generated: 0, skipped_existing: 0, source_count: sources.results.length, drafted_count: 0, cutoff_date: cutoffDate };
  }
  const statements: D1PreparedStatement[] = drafts.map((candidate) => env.DB.prepare(
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
  const results = await env.DB.batch(statements);
  const inserted = results.filter((result) => result.meta.changes === 1).length;
  await lapseTerminalSubscriptions(env, cutoffDate);
  return {
    generated: inserted,
    skipped_existing: drafts.length - inserted,
    source_count: sources.results.length,
    drafted_count: drafts.length,
    cutoff_date: cutoffDate,
  };
}

/** 每日自动生成报销候选：账期开始日到达当天即入池，幂等跳过既有；失败只留记录。 */
async function scheduledCandidateGeneration(env: Env): Promise<void> {
  const runId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sync_runs (id, kind, status) VALUES (?, 'candidate_generation', 'running')`).bind(runId).run();
  try {
    const cutoffDate = shanghaiBusinessDate();
    const result = await generateReimbursementCandidates(env, { cutoffDate, fetcher: fetch });
    await env.DB.prepare(
      `UPDATE sync_runs SET status = 'success', finished_at = datetime('now'), detail_json = ? WHERE id = ?`,
    ).bind(
      JSON.stringify({
        cutoff_date: cutoffDate,
        generated: result.generated,
        skipped_existing: result.skipped_existing,
        source_count: result.source_count,
      }),
      runId,
    ).run();
  } catch {
    await env.DB.prepare(
      `UPDATE sync_runs SET status = 'failed', finished_at = datetime('now'), error_code = 'candidate_generation_failed' WHERE id = ?`,
    ).bind(runId).run();
  }
}

export function createApp(dependencies: AppDependencies = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const resolveIdentity = dependencies.resolveIdentity ?? resolveAuthenticatedIdentity;
  const now = dependencies.now ?? (() => new Date());
  const fetcher = dependencies.fetcher ?? fetch;

  app.onError((error, c) => {
    if (error instanceof ApiProblem) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    if (error instanceof IdentityProblem) return identityProblemResponse(c, error);
    // 不回显异常文本，避免把上游 Token、SQL 或 provider 响应泄漏给浏览器。
    return c.json({ error: { code: 'internal_error', message: '系统暂时无法处理该请求。' } }, 500);
  });

  // 页面与 API 一律 no-store：部署后浏览器必须拿到最新代码与数据，杜绝启发式缓存。
  app.use('*', async (c, next) => {
    try {
      await next();
    } finally {
      c.header('Cache-Control', 'no-store');
    }
  });

  app.use('*', async (c, next) => {
    const requestUrl = new URL(c.req.url);
    const entry = accessEntryForRequest(requestUrl.host, c.env);
    if (!entry) return problem(c, 404, 'unknown_entry_host', '请求的系统入口不存在。');

    c.set('entry', entry);

    c.set('principal', null);
    c.set('principal', null);

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

      const store = new IdentityStore(c.env.DB);
      const principal = await store.ensureCorporatePrincipal(identity, {
        migrationAdminEmail: c.env.MIGRATION_SYSTEM_ADMIN_EMAIL,
      });
      if (principal) c.set('principal', principal);
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
    }),
  );

// 应用级 /cdn-cgi/access/logout 只清本应用会话；全局（团队域）会话仍在，
// 其他入口会被 SSO 静默续期。真正的“登出所有入口”必须跳团队域登出。
app.get('/logout', (c) => {
  const issuer = c.env.ACCESS_ISSUER?.replace(/\/+$/, '');
  if (issuer) return c.redirect(`${issuer}/cdn-cgi/access/logout`, 302);
  return c.redirect('/cdn-cgi/access/logout', 302);
});

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

app.get('/api/dashboard', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  if (!isGlobalReader(auth)) {
    // 员工只读自己的范围：归属资产 + 付款者为自己的报销指标，绝不查询全局表。
    const personalResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM subscriptions WHERE owner_user_id = ?`,
      ).bind(auth.userId),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM account_assets WHERE owner_user_id = ?`,
      ).bind(auth.userId),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(candidate.cny_amount_fen), 0) AS total_cny_fen
         FROM reimbursement_candidates AS candidate
         JOIN payer_assignments AS assignment ON assignment.id = candidate.payer_assignment_id
         JOIN payers AS payer ON payer.id = assignment.payer_id
         WHERE candidate.status = 'pending' AND payer.owner_user_id = ?`,
      ).bind(auth.userId),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(batch.total_cny_fen), 0) AS total_cny_fen
         FROM reimbursement_batches AS batch
         JOIN payers AS payer ON payer.id = batch.payer_id
         WHERE batch.status IN ('submitted', 'reviewing', 'approved') AND payer.owner_user_id = ?`,
      ).bind(auth.userId),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(batch.total_cny_fen), 0) AS total_cny_fen
         FROM reimbursement_batches AS batch
         JOIN payers AS payer ON payer.id = batch.payer_id
         WHERE batch.status = 'paid' AND payer.owner_user_id = ?`,
      ).bind(auth.userId),
    ]);
    return c.json({
      data: {
        pending_candidates: { count: 0, total_cny_fen: 0 },
        review_batches: { count: 0 },
        fx_exceptions: { count: 0 },
        owned_subscriptions: personalResults[0]?.results[0] ?? { count: 0 },
        owned_account_assets: personalResults[1]?.results[0] ?? { count: 0 },
        my_pending_candidates: personalResults[2]?.results[0] ?? { count: 0, total_cny_fen: 0 },
        my_inflight_batches: personalResults[3]?.results[0] ?? { count: 0, total_cny_fen: 0 },
        my_paid_batches: personalResults[4]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      },
    });
  }
  const dashboardResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(cny_amount_fen), 0) AS total_cny_fen
       FROM reimbursement_candidates WHERE status = 'pending'`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM reimbursement_batches
       WHERE status IN ('submitted', 'reviewing', 'approved')`,
    ),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM fx_quotes WHERE status IN ('stale', 'failed')`),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
       FROM reimbursement_batches WHERE status IN ('submitted', 'reviewing', 'approved')`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
       FROM reimbursement_batches WHERE status = 'paid'`,
    ),
  ]);
  return c.json({
    data: {
      pending_candidates: dashboardResults[0]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      review_batches: dashboardResults[1]?.results[0] ?? { count: 0 },
      fx_exceptions: dashboardResults[2]?.results[0] ?? { count: 0 },
      inflight_batches: dashboardResults[3]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      paid_summary: dashboardResults[4]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      monthly_paid: await fetchMonthlyPaidSeries(c.env),
    },
  });
});

app.get('/api/finance/overview', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'finance_reviewer', 'auditor']);
  if (isResponse(auth)) return auth;
  const today = shanghaiBusinessDate();
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const quarterStartMonth = String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0');
  const quarterStart = `${year}-${quarterStartMonth}-01`;

  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(cny_amount_fen), 0) AS total_cny_fen
       FROM reimbursement_candidates WHERE status = 'pending'`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
       FROM reimbursement_batches WHERE status IN ('submitted', 'reviewing')`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
       FROM reimbursement_batches WHERE status = 'approved'`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
       FROM reimbursement_batches WHERE status = 'paid' AND paid_at >= ?`,
    ).bind(`${year}-01-01`),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
       FROM reimbursement_batches WHERE status = 'paid' AND paid_at >= ?`,
    ).bind(quarterStart),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cny_fen), 0) AS total_cny_fen
       FROM reimbursement_batches WHERE status = 'paid' AND paid_at >= ?`,
    ).bind(`${month}-01`),
  ]);

  return c.json({
    data: {
      as_of: today,
      pending_candidates: results[0]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      review_batches: results[1]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      approved_batches: results[2]?.results[0] ?? { count: 0, total_cny_fen: 0 },
      paid_year: { period: year, ...(results[3]?.results[0] ?? { count: 0, total_cny_fen: 0 }) },
      paid_quarter: { period: `${year}-Q${String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1)}`, ...(results[4]?.results[0] ?? { count: 0, total_cny_fen: 0 }) },
      paid_month: { period: month, ...(results[5]?.results[0] ?? { count: 0, total_cny_fen: 0 }) },
      monthly_paid: await fetchMonthlyPaidSeries(c.env),
    },
  });
});

app.get('/api/roles', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'auditor']);
  if (isResponse(auth)) return auth;
  const roles = await c.env.DB.prepare(`SELECT id, code, display_name FROM roles ORDER BY code`).all();
  return c.json({ data: roles.results });
});

app.get('/api/account-owners', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const owners = await c.env.DB.prepare(
    `SELECT user.id, user.display_name
     FROM users AS user
     ORDER BY user.display_name, user.id`,
  ).all<{ id: string; display_name: string }>();
  return c.json({ data: owners.results });
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

app.put('/api/users/:userId', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const userId = c.req.param('userId');
  const existing = await c.env.DB.prepare(
    `SELECT id, display_name, employment_status FROM users WHERE id = ?`,
  ).bind(userId).first<{ id: string; display_name: string; employment_status: string }>();
  if (!existing) return problem(c, 404, 'user_not_found', '用户不存在。');
  const displayName = body.display_name === undefined ? existing.display_name : requiredString(body, 'display_name', 80);
  const employmentStatus = body.employment_status === undefined
    ? existing.employment_status
    : enumValue(body, 'employment_status', ['active', 'inactive'] as const);
  await c.env.DB.prepare(
    `UPDATE users SET display_name = ?, employment_status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(displayName, employmentStatus, userId).run();
  await appendAudit(c.env, auth.userId, 'update_user', 'user', userId, { display_name: displayName, employment_status: employmentStatus });
  return c.json({ user_id: userId });
});

app.get('/api/login-whitelist', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  const rows = await c.env.DB.prepare(
    `SELECT whitelist.id, whitelist.kind, whitelist.value, whitelist.created_at,
            creator.display_name AS created_by_name
     FROM login_whitelist AS whitelist
     LEFT JOIN users AS creator ON creator.id = whitelist.created_by
     ORDER BY whitelist.kind, whitelist.value`,
  ).all();
  return c.json({ data: rows.results });
});

app.post('/api/login-whitelist', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const kind = enumValue(body, 'kind', ['email', 'domain'] as const);
  const rawValue = requiredString(body, 'value', 255);
  let value: string;
  if (kind === 'email') {
    const normalized = normalizeVerifiedEmail(rawValue);
    if (!normalized) throw new ApiProblem(400, 'invalid_field', 'value 必须是合法邮箱地址。');
    value = normalized;
  } else {
    value = rawValue.trim().toLowerCase().replace(/^@+/, '');
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
      throw new ApiProblem(400, 'invalid_field', 'value 必须是合法域名（不含 @）。');
    }
  }
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO login_whitelist (id, kind, value, created_by) VALUES (?, ?, ?, ?)`,
    ).bind(id, kind, value, auth.userId),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'add_login_whitelist_rule', 'login_whitelist', ?, ?)`,
    ).bind(crypto.randomUUID(), auth.userId, id, JSON.stringify({ kind, value })),
  ]);
  return c.json({ rule_id: id }, 201);
});

app.delete('/api/login-whitelist/:ruleId', async (c) => {
  const auth = requireRoles(c, ['system_admin']);
  if (isResponse(auth)) return auth;
  const ruleId = c.req.param('ruleId');
  const existing = await c.env.DB.prepare(
    `SELECT id FROM login_whitelist WHERE id = ?`,
  ).bind(ruleId).first<{ id: string }>();
  if (!existing) return problem(c, 404, 'whitelist_rule_not_found', '白名单规则不存在。');
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM login_whitelist`).first<{ count: number }>();
  if ((total?.count ?? 0) <= 1) {
    return problem(c, 409, 'whitelist_last_entry', '白名单至少需要保留一条规则，否则会锁死所有登录。');
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM login_whitelist WHERE id = ?`).bind(ruleId),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'remove_login_whitelist_rule', 'login_whitelist', ?, '{}')`,
    ).bind(crypto.randomUUID(), auth.userId, ruleId),
  ]);
  return c.json({ rule_id: ruleId, deleted: true });
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
  const ownerUserId = optionalString(body, 'owner_user_id', 80);
  let owner: { id: string; display_name: string } | null = null;
  if (ownerUserId) {
    owner = await c.env.DB.prepare(
      `SELECT id, display_name FROM users WHERE id = ? AND employment_status = 'active'`,
    ).bind(ownerUserId).first<{ id: string; display_name: string }>();
    if (!owner) return problem(c, 404, 'user_not_found', '付款者必须是账号状态正常的员工。');
  }
  const displayName = body.display_name === undefined || body.display_name === ''
    ? (owner ? owner.display_name : requiredString(body, 'display_name', 120))
    : requiredString(body, 'display_name', 120);
  const paymentMethodMasked = optionalString(body, 'payment_method_masked', 120);
  const activeFrom = body.active_from === undefined || body.active_from === ''
    ? shanghaiBusinessDate()
    : isoDate(requiredString(body, 'active_from', 10), 'active_from');
  const activeUntil = optionalIsoDate(optionalString(body, 'active_until', 10), 'active_until');
  if (activeUntil && activeUntil < activeFrom) throw new ApiProblem(400, 'invalid_date_range', 'active_until 不能早于 active_from。');
  await c.env.DB.prepare(
    `INSERT INTO payers (id, display_name, owner_user_id, payment_method_masked, active_from, active_until)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, displayName, ownerUserId, paymentMethodMasked, activeFrom, activeUntil).run();
  await appendAudit(c.env, auth.userId, 'create_payer', 'payer', id, { display_name: displayName });
  return c.json({ payer_id: id }, 201);
});

app.get('/api/subscriptions', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  // 清单优先展示「今天仍覆盖」的条款；若条款已截止但仍有历史版本，回退到最近一条，
  // 避免资产仍有效、价格已录入却因 effective_end 过期显示为空。业务日用上海时区，不用 UTC date('now')。
  const today = shanghaiBusinessDate();
  await lapseTerminalSubscriptions(c.env, today);
  let sql = `SELECT DISTINCT
      subscription.id, subscription.name, subscription.status, subscription.owner_user_id,
      subscription.auto_renew, subscription.payment_method_masked, subscription.notes,
      owner.display_name AS owner_name,
      term.id AS active_term_version_id, term.effective_start AS term_effective_start,
      term.effective_end AS term_effective_end, term.billing_cycle, term.settlement_mode,
      term.billing_anchor_date, term.original_currency, term.amount_minor,
      assignment.id AS active_payer_assignment_id, payer.id AS payer_id,
      payer.display_name AS payer_name, payer.owner_user_id AS payer_owner_user_id
    FROM subscriptions AS subscription
    LEFT JOIN users AS owner ON owner.id = subscription.owner_user_id
    LEFT JOIN subscription_term_versions AS term
      ON term.id = (
        SELECT candidate.id
        FROM subscription_term_versions AS candidate
        WHERE candidate.subscription_id = subscription.id
        ORDER BY
          CASE
            WHEN candidate.effective_start <= ?
              AND (candidate.effective_end IS NULL OR candidate.effective_end >= ?)
            THEN 0
            ELSE 1
          END,
          candidate.effective_start DESC
        LIMIT 1
      )
    LEFT JOIN payer_assignments AS assignment
      ON assignment.subscription_id = subscription.id AND assignment.effective_end IS NULL
    LEFT JOIN payers AS payer ON payer.id = assignment.payer_id`;
  let statement: D1PreparedStatement;
  if (isGlobalReader(auth)) {
    statement = c.env.DB.prepare(`${sql} ORDER BY subscription.name`).bind(today, today);
  } else {
    // 员工自助范围：归属自己使用的订阅，或付款者是自己的订阅。
    statement = c.env.DB.prepare(`${sql} WHERE (subscription.owner_user_id = ? OR payer.owner_user_id = ?) ORDER BY subscription.name`).bind(today, today, auth.userId, auth.userId);
  }
  const subscriptions = await statement.all();
  return c.json({ data: subscriptions.results });
});

type SubscriptionTermInput = {
  effectiveStart: string;
  effectiveEnd: string | null;
  billingCycle: typeof BILLING_CYCLES[number];
  originalCurrency: string;
  amountMinor: number;
};

/**
 * 付款者从在职员工中解析：已有活跃付款者记录则复用，否则按员工姓名创建。
 * 付款者不是独立维护的对象，只是员工在报销链路中的投影。
 */
async function findOrCreatePayerForUser(env: Env, userId: string): Promise<{ payerId: string } | null> {
  const user = await env.DB.prepare(
    `SELECT id, display_name FROM users WHERE id = ? AND employment_status = 'active'`,
  ).bind(userId).first<{ id: string; display_name: string }>();
  if (!user) return null;
  const existing = await env.DB.prepare(
    `SELECT id FROM payers WHERE owner_user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1`,
  ).bind(userId).first<{ id: string }>();
  if (existing) return { payerId: existing.id };
  const payerId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO payers (id, display_name, owner_user_id, active_from, status)
     VALUES (?, ?, ?, ?, 'active')`,
  ).bind(payerId, user.display_name, userId, shanghaiBusinessDate()).run();
  return { payerId };
}

/** 价格、币种、周期、开始/截止日期的统一校验；创建与编辑共用，任何地方都不接受浮点金额。 */
function parseTermInput(body: Record<string, unknown>): SubscriptionTermInput | null {
  if (body.term === undefined || body.term === null) return null;
  if (!isRecord(body.term)) throw new ApiProblem(400, 'invalid_field', 'term 必须是对象。');
  const effectiveStart = isoDate(requiredString(body.term, 'effective_start', 10), 'term.effective_start');
  const billingCycle = enumValue(body.term, 'billing_cycle', BILLING_CYCLES);
  const originalCurrency = requiredString(body.term, 'original_currency', 12).toUpperCase();
  if (!/^[A-Z]{3}$/.test(originalCurrency)) throw new ApiProblem(400, 'invalid_currency', 'term.original_currency 必须是三位 ISO 币种代码。');
  const amountMinor = integer(body.term, 'amount_minor', 0);
  const effectiveEnd = optionalIsoDate(optionalString(body.term, 'effective_end', 10), 'term.effective_end');
  if (effectiveEnd && effectiveEnd < effectiveStart) {
    throw new ApiProblem(400, 'invalid_date_range', 'term.effective_end 不能早于 effective_start。');
  }
  return { effectiveStart, effectiveEnd, billingCycle, originalCurrency, amountMinor };
}

app.post('/api/subscriptions', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const name = requiredString(body, 'name', 120);
  const ownerUserId = optionalString(body, 'owner_user_id', 80);
  const autoRenew = booleanFlag(body, 'auto_renew');
  const paymentMethodMasked = optionalString(body, 'payment_method_masked', 120);
  const notes = optionalString(body, 'notes', 2_000);
  const termInput = parseTermInput(body);
  let payerId: string | null = null;
  const payerUserId = optionalString(body, 'payer_user_id', 80);
  const legacyPayerId = optionalString(body, 'payer_id', 80);
  if (payerUserId) {
    const resolved = await findOrCreatePayerForUser(c.env, payerUserId);
    if (!resolved) return problem(c, 404, 'user_not_found', '付款者必须是在职员工。');
    payerId = resolved.payerId;
  } else if (legacyPayerId) {
    const payer = await c.env.DB.prepare(`SELECT id FROM payers WHERE id = ?`).bind(legacyPayerId).first<{ id: string }>();
    if (!payer) return problem(c, 404, 'payer_not_found', '付款者不存在。');
    payerId = legacyPayerId;
  }
  if (payerId && !termInput) throw new ApiProblem(400, 'invalid_field', '关联付款者需要同时填写订阅开始日期等条款信息。');
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO subscriptions (
         id, name, owner_user_id, auto_renew, payment_method_masked, notes
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, name, ownerUserId, autoRenew, paymentMethodMasked, notes),
  ];
  if (termInput) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO subscription_term_versions (
         id, subscription_id, effective_start, effective_end, billing_cycle,
         settlement_mode, billing_anchor_date, original_currency, amount_minor
       ) VALUES (?, ?, ?, ?, ?, 'actual_bill', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      termInput.effectiveStart,
      termInput.effectiveEnd,
      termInput.billingCycle,
      termInput.effectiveStart,
      termInput.originalCurrency,
      termInput.amountMinor,
    ));
    if (payerId) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start)
         VALUES (?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), id, payerId, termInput.effectiveStart));
    }
  }
  await c.env.DB.batch(statements);
  await appendAudit(c.env, auth.userId, 'create_subscription', 'subscription', id, { name });
  await continueAfterResponse(c, regenerateCandidatesForSubscription(c.env, id, fetcher));
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
  let ownerUserId: string | null | undefined;
  if (body.owner_user_id !== undefined) {
    ownerUserId = optionalString(body, 'owner_user_id', 80);
    if (ownerUserId !== null) {
      const owner = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(ownerUserId).first<{ id: string }>();
      if (!owner) return problem(c, 404, 'user_not_found', '要关联的系统用户不存在。');
    }
  }

  // 价格、币种、周期走条款版本：新条款生效时关闭当前条款；没有候选引用的
  // 初始条款允许原地更正；订阅截止日期（空=持续续费）可直接在当前条款上调整；
  // 任何情况下都不覆盖历史候选。
  const termInput = parseTermInput(body);
  const termEndProvided = body.term_effective_end !== undefined;
  const termEnd = termEndProvided ? optionalIsoDate(optionalString(body, 'term_effective_end', 10), 'term_effective_end') : undefined;
  let termChanged = false;
  const termStatements: D1PreparedStatement[] = [];
  // 付款者变更：关闭当前有效期，按生效日开启新付款者；显式传 null 表示解除付款者。
  let payerChanged = false;
  if (body.payer_user_id !== undefined) {
    const payerUserId = optionalString(body, 'payer_user_id', 80);
    const currentAssignment = await c.env.DB.prepare(
      `SELECT id, payer_id, effective_start FROM payer_assignments
       WHERE subscription_id = ? AND effective_end IS NULL
       ORDER BY effective_start DESC LIMIT 1`,
    ).bind(subscriptionId).first<{ id: string; payer_id: string; effective_start: string }>();
    let targetPayerId: string | null = null;
    if (payerUserId !== null) {
      const resolved = await findOrCreatePayerForUser(c.env, payerUserId);
      if (!resolved) return problem(c, 404, 'user_not_found', '付款者必须是在职员工。');
      targetPayerId = resolved.payerId;
    }
    if ((currentAssignment?.payer_id ?? null) !== targetPayerId) {
      const effectiveStart = isoDate(
        optionalString(body, 'payer_effective_start', 10) ?? shanghaiBusinessDate(),
        'payer_effective_start',
      );
      if (currentAssignment && targetPayerId !== null && effectiveStart <= currentAssignment.effective_start) {
        return problem(c, 400, 'invalid_payer_start', '付款者生效日期必须晚于当前有效期的开始日期。');
      }
      payerChanged = true;
      if (currentAssignment) {
        // 正常交接：旧有效期止于新开始日前一天；清除尚未生效的付款者则以开始日封存。
        const closeEnd = effectiveStart > currentAssignment.effective_start
          ? addDaysIso(effectiveStart, -1)
          : currentAssignment.effective_start;
        termStatements.push(c.env.DB.prepare(
          `UPDATE payer_assignments SET effective_end = ? WHERE id = ?`,
        ).bind(closeEnd, currentAssignment.id));
      }
      if (targetPayerId) {
        termStatements.push(c.env.DB.prepare(
          `INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start)
           VALUES (?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), subscriptionId, targetPayerId, effectiveStart));
      }
    }
  }
  if (termInput || termEndProvided) {
    const activeTerm = await c.env.DB.prepare(
      `SELECT id, effective_start, effective_end, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor
       FROM subscription_term_versions WHERE subscription_id = ?
       ORDER BY effective_start DESC LIMIT 1`,
    ).bind(subscriptionId).first<{
      id: string;
      effective_start: string;
      effective_end: string | null;
      billing_cycle: string;
      settlement_mode: string;
      billing_anchor_date: string;
      original_currency: string;
      amount_minor: number;
    }>();
    if (!activeTerm && !termInput) {
      return problem(c, 409, 'term_required', '该订阅还没有条款；请同时填写价格、币种、周期和生效开始日期。');
    }
    if (termEndProvided && termEnd && activeTerm && termEnd < activeTerm.effective_start) {
      throw new ApiProblem(400, 'invalid_term_end', '订阅截止日期不能早于当前条款的生效开始日期。');
    }
    const fieldsSame = !termInput || (activeTerm
      && activeTerm.effective_start === termInput.effectiveStart
      && activeTerm.billing_cycle === termInput.billingCycle
      && activeTerm.original_currency === termInput.originalCurrency
      && activeTerm.amount_minor === termInput.amountMinor);
    const endSame = !termEndProvided || (activeTerm && (activeTerm.effective_end ?? null) === (termEnd ?? null));
    if (!fieldsSame || !endSame) {
      termChanged = true;
      const settlementMode = 'actual_bill';
      if (!activeTerm) {
        termStatements.push(c.env.DB.prepare(
          `INSERT INTO subscription_term_versions
             (id, subscription_id, effective_start, effective_end, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), subscriptionId, termInput!.effectiveStart, termEnd ?? termInput!.effectiveEnd, termInput!.billingCycle, settlementMode, termInput!.effectiveStart, termInput!.originalCurrency, termInput!.amountMinor));
      } else if (fieldsSame) {
        termStatements.push(c.env.DB.prepare(
          `UPDATE subscription_term_versions SET effective_end = ? WHERE id = ?`,
        ).bind(termEnd ?? null, activeTerm.id));
      } else if (termInput!.effectiveStart === activeTerm.effective_start) {
        const candidateCount = await c.env.DB.prepare(
          `SELECT COUNT(*) AS count FROM reimbursement_candidates WHERE subscription_term_version_id = ?`,
        ).bind(activeTerm.id).first<{ count: number }>();
        if ((candidateCount?.count ?? 0) > 0) {
          return problem(c, 409, 'term_has_candidates', '该条款已产生报销候选，不能原地修改；请选择更晚的生效开始日期新建条款版本。');
        }
        termStatements.push(c.env.DB.prepare(
          `UPDATE subscription_term_versions
           SET billing_cycle = ?, original_currency = ?, amount_minor = ?, effective_end = ?
           WHERE id = ?`,
        ).bind(termInput!.billingCycle, termInput!.originalCurrency, termInput!.amountMinor, termEnd ?? activeTerm.effective_end, activeTerm.id));
      } else if (termInput!.effectiveStart > activeTerm.effective_start) {
        termStatements.push(
          c.env.DB.prepare(
            `UPDATE subscription_term_versions SET effective_end = ? WHERE id = ?`,
          ).bind(addDaysIso(termInput!.effectiveStart, -1), activeTerm.id),
          c.env.DB.prepare(
            `INSERT INTO subscription_term_versions
               (id, subscription_id, effective_start, effective_end, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(crypto.randomUUID(), subscriptionId, termInput!.effectiveStart, termEnd ?? termInput!.effectiveEnd, termInput!.billingCycle, settlementMode, termInput!.effectiveStart, termInput!.originalCurrency, termInput!.amountMinor),
        );
      } else {
        return problem(c, 400, 'invalid_term_start', '新条款的生效开始日期不能早于当前条款。');
      }
    }
  }

  if (ownerUserId !== undefined) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE subscriptions
         SET auto_renew = ?, payment_method_masked = ?, notes = ?, owner_user_id = ?,
             status = CASE WHEN ? THEN 'active' ELSE status END, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(autoRenew, paymentMethodMasked, notes, ownerUserId, termChanged ? 1 : 0, subscriptionId),
      ...termStatements,
    ]);
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE subscriptions
         SET auto_renew = ?, payment_method_masked = ?, notes = ?,
             status = CASE WHEN ? THEN 'active' ELSE status END, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(autoRenew, paymentMethodMasked, notes, termChanged ? 1 : 0, subscriptionId),
      ...termStatements,
    ]);
  }
  await appendAudit(c.env, auth.userId, 'update_subscription_operational_fields', 'subscription', subscriptionId, {
    auto_renew: autoRenew,
    ...(ownerUserId !== undefined ? { owner_user_id: ownerUserId } : {}),
    ...(termChanged ? { term_changed: true } : {}),
    ...(payerChanged ? { payer_changed: true } : {}),
  });
  await continueAfterResponse(c, regenerateCandidatesForSubscription(c.env, subscriptionId, fetcher));
  return c.json({ subscription_id: subscriptionId, auto_renew: autoRenew, term_changed: termChanged, payer_changed: payerChanged });
});

function addDaysIso(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

app.post('/api/subscriptions/:subscriptionId/term-versions', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const id = crypto.randomUUID();
  const effectiveStart = isoDate(requiredString(body, 'effective_start', 10), 'effective_start');
  const effectiveEnd = optionalIsoDate(optionalString(body, 'effective_end', 10), 'effective_end');
  if (effectiveEnd && effectiveEnd < effectiveStart) throw new ApiProblem(400, 'invalid_date_range', 'effective_end 不能早于 effective_start。');
  const billingCycle = enumValue(body, 'billing_cycle', BILLING_CYCLES);
  const billingAnchorDate = isoDate(requiredString(body, 'billing_anchor_date', 10), 'billing_anchor_date');
  const originalCurrency = requiredString(body, 'original_currency', 12).toUpperCase();
  const amountMinor = integer(body, 'amount_minor', 0);
  await c.env.DB.prepare(
    `INSERT INTO subscription_term_versions (
       id, subscription_id, effective_start, effective_end, billing_cycle,
       settlement_mode, billing_anchor_date, original_currency, amount_minor
     ) VALUES (?, ?, ?, ?, ?, 'actual_bill', ?, ?, ?)`,
  ).bind(
    id,
    c.req.param('subscriptionId'),
    effectiveStart,
    effectiveEnd,
    billingCycle,
    billingAnchorDate,
    originalCurrency,
    amountMinor,
  ).run();
  await appendAudit(c.env, auth.userId, 'create_subscription_term_version', 'subscription_term_version', id, {
    subscription_id: c.req.param('subscriptionId'),
    effective_start: effectiveStart,
  });
  await continueAfterResponse(c, regenerateCandidatesForSubscription(c.env, c.req.param('subscriptionId'), fetcher));
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
  await continueAfterResponse(c, regenerateCandidatesForSubscription(c.env, c.req.param('subscriptionId'), fetcher));
  return c.json({ payer_assignment_id: id }, 201);
});

app.get('/api/account-assets', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const accounts = isGlobalReader(auth)
    ? await c.env.DB.prepare(
      `SELECT account.*, user.display_name AS owner_name
       FROM account_assets AS account
       LEFT JOIN users AS user ON user.id = account.owner_user_id
       ORDER BY account.display_name`,
    ).all()
    : await c.env.DB.prepare(
      `SELECT account.*, user.display_name AS owner_name
       FROM account_assets AS account
       LEFT JOIN users AS user ON user.id = account.owner_user_id
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
  const assetIdentifier = requiredString(body, 'asset_identifier', 120);
  const accountIdentifierMasked = requiredString(body, 'account_identifier_masked', 160);
  const ownerUserId = optionalString(body, 'owner_user_id', 80);
  const vaultRef = optionalString(body, 'vault_ref', 255);
  const expiresOn = optionalIsoDate(optionalString(body, 'expires_on', 10), 'expires_on');
  await c.env.DB.prepare(
    `INSERT INTO account_assets (
       id, owner_user_id, account_identifier_masked, display_name, asset_identifier, vault_ref, expires_on
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, ownerUserId, accountIdentifierMasked, displayName, assetIdentifier, vaultRef, expiresOn).run();
  await appendAudit(c.env, auth.userId, 'create_account_asset', 'account_asset', id, { display_name: displayName, asset_identifier: assetIdentifier });
  return c.json({ account_asset_id: id }, 201);
});

const accountFieldsDeprecated = (c: AppContext) => problem(
  c,
  410,
  'account_fields_deprecated',
  '账号资产的追加字段功能已弃用。',
);

app.get('/api/account-field-definitions', accountFieldsDeprecated);
app.post('/api/account-field-definitions', accountFieldsDeprecated);

app.put('/api/account-assets/:accountId', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const accountId = c.req.param('accountId');
  const existing = await c.env.DB.prepare(
    `SELECT id, owner_user_id, account_identifier_masked, display_name, asset_identifier, vault_ref, status, expires_on
     FROM account_assets WHERE id = ?`,
  ).bind(accountId).first<{
    id: string;
    owner_user_id: string | null;
    account_identifier_masked: string;
    display_name: string;
    asset_identifier: string;
    vault_ref: string | null;
    status: string;
    expires_on: string | null;
  }>();
  if (!existing) return problem(c, 404, 'account_asset_not_found', '账号资产不存在。');
  const displayName = body.display_name === undefined ? existing.display_name : requiredString(body, 'display_name', 120);
  const accountIdentifier = body.account_identifier === undefined
    ? existing.account_identifier_masked
    : requiredString(body, 'account_identifier', 160);
  const assetIdentifier = body.asset_identifier === undefined
    ? existing.asset_identifier
    : requiredString(body, 'asset_identifier', 120);
  let ownerUserId = existing.owner_user_id;
  if (body.owner_user_id !== undefined) {
    ownerUserId = optionalString(body, 'owner_user_id', 80);
    if (ownerUserId !== null) {
      const owner = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(ownerUserId).first<{ id: string }>();
      if (!owner) return problem(c, 404, 'user_not_found', '要关联的系统用户不存在。');
    }
  }
  const vaultRef = body.vault_ref === undefined ? existing.vault_ref : optionalString(body, 'vault_ref', 255);
  const expiresOn = body.expires_on === undefined
    ? existing.expires_on
    : optionalIsoDate(optionalString(body, 'expires_on', 10), 'expires_on');
  const status = body.status === undefined
    ? existing.status
    : enumValue(body, 'status', ['active', 'inactive', 'retired'] as const);
  await c.env.DB.prepare(
    `UPDATE account_assets
     SET display_name = ?, asset_identifier = ?, account_identifier_masked = ?, owner_user_id = ?, vault_ref = ?, expires_on = ?, status = ?
     WHERE id = ?`,
  ).bind(displayName, assetIdentifier, accountIdentifier, ownerUserId, vaultRef, expiresOn, status, accountId).run();
  await appendAudit(c.env, auth.userId, 'update_account_asset', 'account_asset', accountId, { display_name: displayName, asset_identifier: assetIdentifier, status });
  return c.json({ account_asset_id: accountId });
});

app.delete('/api/account-assets/:accountId', async (c) => {
  const auth = requireRoles(c, DATA_ADMIN_ROLES);
  if (isResponse(auth)) return auth;
  const accountId = c.req.param('accountId');
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM account_field_values WHERE account_asset_id = ?',
    ).bind(accountId),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       SELECT ?, ?, ?, ?, id, json_object('display_name', display_name, 'asset_identifier', asset_identifier, 'status', status)
       FROM account_assets WHERE id = ?`,
    ).bind(
      crypto.randomUUID(),
      auth.userId,
      'delete_account_asset',
      'account_asset',
      accountId,
    ),
    c.env.DB.prepare(
      'DELETE FROM account_assets WHERE id = ?',
    ).bind(accountId),
  ]);
  const parentDelete = results[2];
  if (!parentDelete || parentDelete.meta.changes === 0) return problem(c, 404, 'account_asset_not_found', '账号资产不存在。');
  return c.json({ account_asset_id: accountId, deleted: true });
});

app.put('/api/account-assets/:accountId/field-values', accountFieldsDeprecated);

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
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
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
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const cutoffDate = resolveCutoffDate(body);
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

app.get('/api/reimbursements/reviewers', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT user.id, user.display_name
     FROM users AS user
     JOIN user_roles AS assignment ON assignment.user_id = user.id
     JOIN roles AS role ON role.id = assignment.role_id
     WHERE user.employment_status = 'active' AND role.code IN ('system_admin', 'finance_reviewer')
     ORDER BY user.display_name`,
  ).all();
  return c.json({ data: rows.results });
});

app.post('/api/reimbursements/create-batches', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const cutoffDate = resolveCutoffDate(body);
  const candidateIds = selectedCandidateIds(body);
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return problem(c, 400, 'idempotency_key_required', '创建报销批次必须提供长度不超过 200 的 Idempotency-Key。');
  }
  const canonicalRequest = fingerprintBatchRequest({ cutoffDate, candidateIds });
  // 提交报销必须指定审批人：具备财务审核权限的在职账号，后续审批/付款由其完成。
  const reviewerUserId = requiredString(body, 'reviewer_user_id', 80);
  const reviewer = await c.env.DB.prepare(
    `SELECT user.id, user.display_name
     FROM users AS user
     JOIN user_roles AS assignment ON assignment.user_id = user.id
     JOIN roles AS role ON role.id = assignment.role_id
     WHERE user.id = ? AND user.employment_status = 'active'
       AND role.code IN ('system_admin', 'finance_reviewer')
     LIMIT 1`,
  ).bind(reviewerUserId).first<{ id: string; display_name: string }>();
  if (!reviewer) return problem(c, 400, 'invalid_reviewer', '审批人必须是具备财务审核权限的在职账号。');
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
         id, submission_id, payer_id, reviewer_user_id, coverage_start, coverage_end, total_cny_fen, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`,
    ).bind(batchId, submissionId, batch.payerId, reviewer.id, batch.coverageStart, batch.coverageEnd, batch.totalCnyFen));
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
  // 记录“提交人 → 报销人”拆账：admin 一次提交多人时，每个报销人的金额都写入审计。
  const payerBreakdown = plan.batches.map((batch) => ({
    payer_name: candidates.find((candidate) => candidate.payerId === batch.payerId)?.payer_display_name ?? batch.payerId,
    total_cny_fen: batch.totalCnyFen,
    candidate_count: batch.candidateIds.length,
  }));
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, 'create_reimbursement_submission', 'reimbursement_submission', ?, ?)`,
    ).bind(crypto.randomUUID(), auth.userId, submissionId, JSON.stringify({
      batch_count: plan.batches.length,
      candidate_count: candidateIds.length,
      reviewer: reviewer.display_name,
      payers: payerBreakdown,
    })),
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
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'auditor', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const baseSql = `SELECT batch.id, batch.submission_id, batch.payer_id, payer.display_name AS payer_name,
      batch.reviewer_user_id, reviewer.display_name AS reviewer_name,
      batch.coverage_start, batch.coverage_end, batch.total_cny_fen, batch.status, batch.paid_at,
      submission.cutoff_date, submission.created_at, actor.display_name AS actor_name,
      COUNT(item.id) AS item_count
    FROM reimbursement_batches AS batch
    JOIN reimbursement_submissions AS submission ON submission.id = batch.submission_id
    JOIN payers AS payer ON payer.id = batch.payer_id
    LEFT JOIN users AS actor ON actor.id = submission.actor_id
    LEFT JOIN users AS reviewer ON reviewer.id = batch.reviewer_user_id
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
  assertBatchReviewer(auth, batch);
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
  assertBatchReviewer(auth, batch);
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

/** 订阅池变动后自动入池该订阅的候选；生成失败不阻断业务变更本身。 */
async function regenerateCandidatesForSubscription(env: Env, subscriptionId: string, fetcher: typeof fetch): Promise<void> {
  try {
    await generateReimbursementCandidates(env, { cutoffDate: shanghaiBusinessDate(), fetcher, subscriptionId });
  } catch {
    // 生成失败留给每日 Cron 兜底，不能让订阅变更请求失败。
  }
}

/** 生产用 waitUntil 避免创建/编辑被汇率抓取拖住；测试没有 ExecutionContext 时仍等待完成。 */
function continueAfterResponse(c: AppContext, work: Promise<unknown>): Promise<unknown> | void {
  try {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(work);
      return;
    }
  } catch {
    // Hono app.request 测试没有 ExecutionContext
  }
  return work;
}

app.post('/api/reimbursements/generate-candidates', async (c) => {
  const auth = requireRoles(c, ['system_admin', 'asset_admin', 'finance_reviewer', 'payer', 'employee']);
  if (isResponse(auth)) return auth;
  const body = await jsonBody(c);
  const cutoffDate = resolveCutoffDate(body);
  const subscriptionId = optionalString(body, 'subscription_id', 80);
  // 员工自助：只能为付款者是自己的订阅生成候选；财务与管理员可全量生成。
  const employeePayerScoped = !hasAnyRole(auth, ['system_admin', 'asset_admin', 'finance_reviewer']);
  const result = await generateReimbursementCandidates(c.env, {
    cutoffDate,
    fetcher,
    subscriptionId,
    payerOwnerUserId: employeePayerScoped ? auth.userId : null,
  });
  await appendAudit(c.env, auth.userId, 'generate_reimbursement_candidates', 'candidate_generation', cutoffDate, {
    source_count: result.source_count,
    drafted_count: result.drafted_count,
  });
  return c.json({
    generated: result.generated,
    skipped_existing: result.skipped_existing,
    source_count: result.source_count,
    cutoff_date: cutoffDate,
  }, 201);
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
  // 人工补录以“1 原币 = X 人民币”的十进制提交，服务端精确换算为最小单位有理数；
  // 也兼容旧的分子/分母表单。任何路径都不让浮点进入存储。
  const rateCnyPerUnit = optionalString(body, 'rate_cny_per_unit', 20);
  let rateNumerator: number;
  let rateDenominator: number;
  if (rateCnyPerUnit !== null) {
    let rational: { numerator: number; denominator: number };
    try {
      rational = rateToMinorUnitRational(rateCnyPerUnit, currencyMinorDigits(baseCurrency));
    } catch {
      throw new ApiProblem(400, 'invalid_rate', 'rate_cny_per_unit 必须是小数位数不超过 12 位的正十进制数。');
    }
    rateNumerator = rational.numerator;
    rateDenominator = rational.denominator;
  } else {
    rateNumerator = integer(body, 'rate_numerator', 1);
    rateDenominator = integer(body, 'rate_denominator', 1);
  }
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
  const principal = c.get('principal');
  if (!principal) return c.html(renderCorporateAccessRequiredUi(), 401);
  return c.html(renderAdminUi({
    page,
    principal: { displayName: principal.email, roles: principal.roles },
    trustedBody: options.trustedBody,
  }), options.status ?? 200);
}

app.get('/', (c) => renderUiRoute(c, 'dashboard'));

for (const route of ['/subscriptions', '/accounts', '/reimbursements', '/finance', '/rates', '/people', '/profile']) {
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
    ctx.waitUntil(Promise.all([syncConfiguredFxRates(env), scheduledCandidateGeneration(env)]));
  },
} satisfies ExportedHandler<Env>;
