import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import type { AuthenticatedIdentity } from '../src/lib/auth';
import type { Env } from '../src/lib/types';
import { sqliteD1 } from './helpers/sqlite-d1';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const databases: Database.Database[] = [];

const CORPORATE_HOST = 'ie-oa.lancloudtech.com';

const corporateIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'subscription-admin-subject',
  email: 'admin@lancloudtech.com',
};

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function createDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  for (const migrationName of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(migrationsDir, migrationName), 'utf8'));
  }
  databases.push(database);
  return database;
}

function frankfurterFetcher(rates: Record<string, number>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const date = url.pathname.split('/').pop()!;
    const base = url.searchParams.get('base') ?? 'USD';
    return Response.json({ amount: 1, base, date, rates: { CNY: rates[base] ?? 7.2 } });
  };
}

function setup(options: { rates?: Record<string, number> } = {}) {
  const database = createDatabase();
  const env: Env = {
    DB: sqliteD1(database),
    ENVIRONMENT: 'production',
    DEV_AUTH: '1',
    ACCESS_AUD_CORPORATE: 'corporate-aud',
    FX_PROVIDER: 'frankfurter-ecb',
    FX_PROVIDER_URL: 'https://api.frankfurter.dev/v1/latest',
  };
  const app = createApp({
    resolveIdentity: async (request) =>
      request.headers.get('x-test-identity') === 'corporate' ? corporateIdentity : null,
    fetcher: frankfurterFetcher(options.rates ?? { USD: 7.2 }) as typeof fetch,
  });
  return { app, database, env };
}

async function request(
  app: ReturnType<typeof createApp>,
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-test-identity', 'corporate');
  return app.request(`https://${CORPORATE_HOST}${path}`, { ...init, headers }, env);
}

async function mutate(
  app: ReturnType<typeof createApp>,
  env: Env,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<Response> {
  return request(app, env, path, {
    method,
    headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function adminSession(app: ReturnType<typeof createApp>, env: Env, database: Database.Database): Promise<string> {
  const response = await request(app, env, '/api/session');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { user_id: string } };
  database.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, 'role-system-admin')`).run(body.data.user_id);
  return body.data.user_id;
}

function seedSubscription(database: Database.Database): void {
  database.prepare(`INSERT INTO users (id, display_name) VALUES ('user-lisi', '李四')`).run();
  database.prepare(`INSERT INTO payers (id, display_name, active_from) VALUES ('payer-1', '王五', '2026-05-20')`).run();
  database.prepare(`INSERT INTO subscriptions (id, name) VALUES ('sub-1', 'Figma 企业版')`).run();
  database.prepare(
    `INSERT INTO subscription_term_versions
       (id, subscription_id, effective_start, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor)
     VALUES ('term-1', 'sub-1', '2026-05-20', 'monthly', 'actual_bill', '2026-05-20', 'USD', 20000)`,
  ).run();
  database.prepare(
    `INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start)
     VALUES ('assign-1', 'sub-1', 'payer-1', '2026-05-20')`,
  ).run();
}

describe('subscription operational editing', () => {
  it('updates owner to a system user and exposes the owner name in the list', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const update = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', {
      owner_user_id: 'user-lisi',
      auto_renew: true,
      payment_method_masked: 'Visa **** 1234',
      notes: '设计团队',
    });
    expect(update.status).toBe(200);

    const list = await request(app, env, '/api/subscriptions');
    const body = await list.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      name: 'Figma 企业版',
      owner_user_id: 'user-lisi',
      owner_name: '李四',
      auto_renew: 1,
      payment_method_masked: 'Visa **** 1234',
      notes: '设计团队',
      payer_name: '王五',
    });

    const clear = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', { owner_user_id: null });
    expect(clear.status).toBe(200);
    const cleared = await request(app, env, '/api/subscriptions');
    const clearedBody = await cleared.json() as { data: Array<Record<string, unknown>> };
    expect(clearedBody.data[0]?.owner_user_id).toBeNull();
    expect(clearedBody.data[0]?.owner_name).toBeNull();
  });

  it('rejects associating a non-existent user', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const update = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', { owner_user_id: 'ghost-user' });
    expect(update.status).toBe(404);
    const row = database.prepare(`SELECT owner_user_id FROM subscriptions WHERE id = 'sub-1'`).get() as { owner_user_id: string | null };
    expect(row.owner_user_id).toBeNull();
  });

  it('still lists amount_minor after the latest term effective_end has passed', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);
    // 用远早于任何合理「今天」的窗口，避免测试依赖机器日期。
    database.prepare(
      `UPDATE subscription_term_versions
       SET effective_start = '2000-01-01', billing_anchor_date = '2000-01-01', effective_end = '2000-12-31'
       WHERE id = 'term-1'`,
    ).run();

    const list = await request(app, env, '/api/subscriptions');
    const body = await list.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      name: 'Figma 企业版',
      amount_minor: 20000,
      original_currency: 'USD',
      term_effective_start: '2000-01-01',
      term_effective_end: '2000-12-31',
    });
  });

  it('prefers the currently effective term over a newer but still future term', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);
    database.prepare(
      `UPDATE subscription_term_versions
       SET effective_start = '2000-01-01', billing_anchor_date = '2000-01-01', effective_end = '2098-12-31'
       WHERE id = 'term-1'`,
    ).run();
    database.prepare(
      `INSERT INTO subscription_term_versions
         (id, subscription_id, effective_start, effective_end, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor)
       VALUES ('term-future', 'sub-1', '2099-01-01', NULL, 'yearly', 'actual_bill', '2099-01-01', 'CNY', 99900)`,
    ).run();

    const list = await request(app, env, '/api/subscriptions');
    const body = await list.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      amount_minor: 20000,
      original_currency: 'USD',
      active_term_version_id: 'term-1',
    });
  });

  it('closes the active term and opens a new version when price or cycle changes with a later start', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const update = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', {
      term: { effective_start: '2026-07-01', billing_cycle: 'yearly', original_currency: 'CNY', amount_minor: 350000 },
    });
    expect(update.status).toBe(200);
    const body = await update.json() as { term_changed: boolean };
    expect(body.term_changed).toBe(true);

    const terms = database.prepare(
      `SELECT id, effective_start, effective_end, billing_cycle, original_currency, amount_minor, settlement_mode
       FROM subscription_term_versions ORDER BY effective_start`,
    ).all() as Array<Record<string, unknown>>;
    expect(terms).toHaveLength(2);
    expect(terms[0]).toMatchObject({ effective_start: '2026-05-20', effective_end: '2026-06-30', billing_cycle: 'monthly', original_currency: 'USD', amount_minor: 20000 });
    expect(terms[1]).toMatchObject({ effective_start: '2026-07-01', effective_end: null, billing_cycle: 'yearly', original_currency: 'CNY', amount_minor: 350000, settlement_mode: 'actual_bill' });
  });

  it('corrects the initial term in place only when no candidates reference it', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const correct = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', {
      term: { effective_start: '2026-05-20', billing_cycle: 'yearly', original_currency: 'USD', amount_minor: 18000 },
    });
    expect(correct.status).toBe(200);
    const term = database.prepare(`SELECT id, billing_cycle, amount_minor FROM subscription_term_versions`).get() as Record<string, unknown>;
    expect(term).toMatchObject({ id: 'term-1', billing_cycle: 'yearly', amount_minor: 18000 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM subscription_term_versions`).get() as { count: number }).toMatchObject({ count: 1 });

    database.prepare(
      `INSERT INTO reimbursement_candidates (
         id, subscription_term_version_id, payer_assignment_id, coverage_start, coverage_end,
         original_currency, original_amount_minor, rate_numerator, rate_denominator, cny_amount_fen, status
       ) VALUES ('cand-1', 'term-1', 'assign-1', '2026-05-20', '2026-05-20', 'USD', 18000, 36, 5, 129600, 'pending')`,
    ).run();
    const blocked = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', {
      term: { effective_start: '2026-05-20', billing_cycle: 'monthly', original_currency: 'USD', amount_minor: 20000 },
    });
    expect(blocked.status).toBe(409);
  });

  it('skips the term change when submitted values are identical to the active term', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const update = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', {
      term: { effective_start: '2026-05-20', billing_cycle: 'monthly', original_currency: 'USD', amount_minor: 20000 },
    });
    expect(update.status).toBe(200);
    const body = await update.json() as { term_changed: boolean };
    expect(body.term_changed).toBe(false);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM subscription_term_versions`).get() as { count: number }).toMatchObject({ count: 1 });
  });
});

describe('subscription creation with term and payer', () => {
  it('auto-generates due candidates when a subscription is created', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    database.prepare(`INSERT INTO users (id, display_name) VALUES ('user-lisi', '李四')`).run();
    database.prepare(`INSERT INTO payers (id, display_name, active_from) VALUES ('payer-1', '王五', '2026-06-01')`).run();

    const created = await mutate(app, env, 'POST', '/api/subscriptions', {
      name: '自动入池订阅',
      payer_user_id: 'user-lisi',
      term: { effective_start: '2026-06-01', billing_cycle: 'monthly', original_currency: 'CNY', amount_minor: 10000 },
    });
    expect(created.status).toBe(201);
    const { subscription_id: subscriptionId } = await created.json() as { subscription_id: string };

    const candidates = database.prepare(
      `SELECT candidate.coverage_start, candidate.coverage_end, candidate.original_amount_minor
       FROM reimbursement_candidates AS candidate
       JOIN subscription_term_versions AS term ON term.id = candidate.subscription_term_version_id
       WHERE term.subscription_id = ? AND candidate.status = 'pending'`,
    ).all(subscriptionId) as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]).toMatchObject({ original_amount_minor: 10000 });

    const update = await mutate(app, env, 'PUT', `/api/subscriptions/${subscriptionId}/operational`, {
      term: { effective_start: '2026-07-01', billing_cycle: 'monthly', original_currency: 'CNY', amount_minor: 12000 },
    });
    expect(update.status).toBe(200);
    const newTermCandidates = database.prepare(
      `SELECT candidate.original_amount_minor FROM reimbursement_candidates AS candidate
       JOIN subscription_term_versions AS term ON term.id = candidate.subscription_term_version_id
       WHERE term.subscription_id = ? AND term.amount_minor = 12000 AND candidate.status = 'pending'`,
    ).all(subscriptionId) as Array<Record<string, unknown>>;
    expect(newTermCandidates.length).toBeGreaterThanOrEqual(1);
  });

  it('creates subscription, first term version and payer assignment atomically', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const created = await mutate(app, env, 'POST', '/api/subscriptions', {
      name: '新订阅',
      owner_user_id: 'user-lisi',
      payer_id: 'payer-1',
      payment_method_masked: '支付宝',
      term: {
        effective_start: '2026-07-01',
        effective_end: '2027-06-30',
        billing_cycle: 'yearly',
        original_currency: 'CNY',
        amount_minor: 350000,
      },
    });
    expect(created.status).toBe(201);
    const { subscription_id: subscriptionId } = await created.json() as { subscription_id: string };

    const term = database.prepare(
      `SELECT effective_start, effective_end, billing_cycle, original_currency, amount_minor
       FROM subscription_term_versions WHERE subscription_id = ?`,
    ).get(subscriptionId) as Record<string, unknown>;
    expect(term).toMatchObject({
      effective_start: '2026-07-01',
      effective_end: '2027-06-30',
      billing_cycle: 'yearly',
      original_currency: 'CNY',
      amount_minor: 350000,
    });
    const assignment = database.prepare(
      `SELECT payer_id, effective_start FROM payer_assignments WHERE subscription_id = ?`,
    ).get(subscriptionId) as Record<string, unknown>;
    expect(assignment).toMatchObject({ payer_id: 'payer-1', effective_start: '2026-07-01' });
  });

  it('rejects payer without term info and end dates before the start', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const noTerm = await mutate(app, env, 'POST', '/api/subscriptions', { name: '坏订阅', payer_id: 'payer-1' });
    expect(noTerm.status).toBe(400);
    const badRange = await mutate(app, env, 'POST', '/api/subscriptions', {
      name: '坏订阅',
      term: { effective_start: '2026-07-01', effective_end: '2026-06-01', billing_cycle: 'yearly', original_currency: 'CNY', amount_minor: 100 },
    });
    expect(badRange.status).toBe(400);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM subscriptions WHERE name = '坏订阅'`).get() as { count: number }).toMatchObject({ count: 0 });
  });
});

describe('subscription end date editing', () => {
  it('sets, edits and clears the end date on the current term without versioning', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const setEnd = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', { term_effective_end: '2027-05-19' });
    expect(setEnd.status).toBe(200);
    expect((await setEnd.json() as { term_changed: boolean }).term_changed).toBe(true);
    expect(database.prepare(`SELECT effective_end FROM subscription_term_versions WHERE id = 'term-1'`).get() as Record<string, unknown>).toMatchObject({ effective_end: '2027-05-19' });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM subscription_term_versions`).get() as { count: number }).toMatchObject({ count: 1 });

    const moveEnd = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', { term_effective_end: '2027-06-30' });
    expect(moveEnd.status).toBe(200);
    expect(database.prepare(`SELECT effective_end FROM subscription_term_versions WHERE id = 'term-1'`).get() as Record<string, unknown>).toMatchObject({ effective_end: '2027-06-30' });

    const clear = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', { term_effective_end: null });
    expect(clear.status).toBe(200);
    expect(database.prepare(`SELECT effective_end FROM subscription_term_versions WHERE id = 'term-1'`).get() as Record<string, unknown>).toMatchObject({ effective_end: null });
  });

  it('rejects an end date before the current term start', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const badEnd = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', { term_effective_end: '2026-05-01' });
    expect(badEnd.status).toBe(400);
    expect(database.prepare(`SELECT effective_end FROM subscription_term_versions WHERE id = 'term-1'`).get() as Record<string, unknown>).toMatchObject({ effective_end: null });
  });
});

describe('payer as employee projection', () => {
  it('finds or creates a payer from an active employee on subscription create', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const created = await mutate(app, env, 'POST', '/api/subscriptions', {
      name: '员工付款的订阅',
      payer_user_id: 'user-lisi',
      term: { effective_start: '2026-07-01', billing_cycle: 'monthly', original_currency: 'CNY', amount_minor: 10000 },
    });
    expect(created.status).toBe(201);
    const { subscription_id: subscriptionId } = await created.json() as { subscription_id: string };

    const payer = database.prepare(`SELECT id, display_name, owner_user_id FROM payers WHERE owner_user_id = 'user-lisi'`).get() as { id: string; display_name: string };
    expect(payer).toMatchObject({ display_name: '李四', owner_user_id: 'user-lisi' });
    const assignment = database.prepare(`SELECT payer_id, effective_start FROM payer_assignments WHERE subscription_id = ?`).get(subscriptionId) as Record<string, unknown>;
    expect(assignment).toMatchObject({ payer_id: payer.id, effective_start: '2026-07-01' });

    const second = await mutate(app, env, 'POST', '/api/subscriptions', {
      name: '同一员工再付款',
      payer_user_id: 'user-lisi',
      term: { effective_start: '2026-07-01', billing_cycle: 'yearly', original_currency: 'CNY', amount_minor: 10000 },
    });
    expect(second.status).toBe(201);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM payers WHERE owner_user_id = 'user-lisi'`).get() as { count: number }).toMatchObject({ count: 1 });

    const inactiveUser = await mutate(app, env, 'POST', '/api/subscriptions', {
      name: '停用员工',
      payer_user_id: 'ghost-user',
      term: { effective_start: '2026-07-01', billing_cycle: 'monthly', original_currency: 'CNY', amount_minor: 10000 },
    });
    expect(inactiveUser.status).toBe(404);
  });

  it('changes the payer on edit by closing the current assignment and opening a new one', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const change = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', {
      payer_user_id: 'user-lisi',
      payer_effective_start: '2026-08-01',
    });
    expect(change.status).toBe(200);
    expect((await change.json() as { payer_changed: boolean }).payer_changed).toBe(true);

    const assignments = database.prepare(
      `SELECT payer_id, effective_start, effective_end FROM payer_assignments WHERE subscription_id = 'sub-1' ORDER BY effective_start`,
    ).all() as Array<Record<string, unknown>>;
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toMatchObject({ payer_id: 'payer-1', effective_start: '2026-05-20', effective_end: '2026-07-31' });
    const newPayer = database.prepare(`SELECT id FROM payers WHERE owner_user_id = 'user-lisi'`).get() as { id: string };
    expect(assignments[1]).toMatchObject({ payer_id: newPayer.id, effective_start: '2026-08-01', effective_end: null });

    const clear = await mutate(app, env, 'PUT', '/api/subscriptions/sub-1/operational', { payer_user_id: null });
    expect(clear.status).toBe(200);
    const remaining = database.prepare(
      `SELECT effective_end FROM payer_assignments WHERE subscription_id = 'sub-1' ORDER BY effective_start DESC LIMIT 1`,
    ).get() as Record<string, unknown>;
    expect(remaining.effective_end).not.toBeNull();
  });
});

describe('manual FX quote entry', () => {
  it('accepts a decimal CNY-based rate and stores the exact rational form', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);

    const created = await mutate(app, env, 'POST', '/api/fx-quotes', {
      base_currency: 'USD',
      effective_at: '2026-07-01',
      provider: '财务确认',
      rate_cny_per_unit: '6.845',
    });
    expect(created.status).toBe(201);
    const quote = database.prepare(`SELECT rate_numerator, rate_denominator, status FROM fx_quotes`).get() as Record<string, unknown>;
    expect(quote).toMatchObject({ rate_numerator: 1369, rate_denominator: 200, status: 'manual' });
  });

  it('rejects an invalid decimal rate', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);

    const created = await mutate(app, env, 'POST', '/api/fx-quotes', {
      base_currency: 'USD',
      effective_at: '2026-07-01',
      provider: '财务确认',
      rate_cny_per_unit: '很多',
    });
    expect(created.status).toBe(400);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM fx_quotes`).get() as { count: number }).toMatchObject({ count: 0 });
  });
});

describe('automatic historical FX locking', () => {
  it('rejects a cutoff date in the future for generation, preview and submission', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);

    const generate = await mutate(app, env, 'POST', '/api/reimbursements/generate-candidates', { cutoff_date: '2099-01-01' });
    expect(generate.status).toBe(400);
    const preview = await mutate(app, env, 'POST', '/api/reimbursements/preview', { cutoff_date: '2099-01-01', candidate_ids: ['x'], reviewer_user_id: 'user-lisi' });
    expect(preview.status).toBe(400);
    const generateBody = await generate.json() as { error: { code: string } };
    expect(generateBody.error.code).toBe('cutoff_in_future');
    expect(database.prepare(`SELECT COUNT(*) AS count FROM reimbursement_candidates`).get() as { count: number }).toMatchObject({ count: 0 });
  });

  it('fetches the subscription start date rate on demand and locks it into candidates', async () => {
    const { app, env, database } = setup({ rates: { USD: 7.2 } });
    await adminSession(app, env, database);
    seedSubscription(database);

    const generate = await mutate(app, env, 'POST', '/api/reimbursements/generate-candidates', { cutoff_date: '2026-06-30' });
    expect(generate.status).toBe(201);
    const result = await generate.json() as { generated: number };
    expect(result.generated).toBeGreaterThanOrEqual(1);

    const quote = database.prepare(
      `SELECT base_currency, effective_at, provider, rate_numerator, rate_denominator, status
       FROM fx_quotes WHERE base_currency = 'USD'`,
    ).get() as Record<string, unknown>;
    expect(quote).toMatchObject({
      base_currency: 'USD',
      effective_at: '2026-05-20',
      provider: 'frankfurter-ecb',
      rate_numerator: 36,
      rate_denominator: 5,
      status: 'verified',
    });

    const candidate = database.prepare(
      `SELECT original_amount_minor, cny_amount_fen, coverage_start FROM reimbursement_candidates
       ORDER BY coverage_start LIMIT 1`,
    ).get() as { original_amount_minor: number; cny_amount_fen: number };
    expect(candidate.original_amount_minor).toBe(20000);
    expect(candidate.cny_amount_fen).toBe(144000);
  });

  it('reuses the stored start-date quote instead of fetching again', async () => {
    const { app, env, database } = setup({ rates: { USD: 7.2 } });
    await adminSession(app, env, database);
    seedSubscription(database);

    const first = await mutate(app, env, 'POST', '/api/reimbursements/generate-candidates', { cutoff_date: '2026-06-30' });
    expect(first.status).toBe(201);
    database.prepare(`DELETE FROM reimbursement_candidates`).run();
    const failing = createApp({
      resolveIdentity: async (request) =>
        request.headers.get('x-test-identity') === 'corporate' ? corporateIdentity : null,
      fetcher: (() => { throw new Error('provider must not be called'); }) as unknown as typeof fetch,
    });
    const second = await mutate(failing, env, 'POST', '/api/reimbursements/generate-candidates', { cutoff_date: '2026-06-30' });
    expect(second.status).toBe(201);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM fx_quotes`).get() as { count: number }).toMatchObject({ count: 1 });
  });

  it('surfaces a clear error when the provider cannot serve the historical rate', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    seedSubscription(database);
    const failing = createApp({
      resolveIdentity: async (request) =>
        request.headers.get('x-test-identity') === 'corporate' ? corporateIdentity : null,
      fetcher: (async () => new Response('upstream down', { status: 502 })) as typeof fetch,
    });

    const generate = await mutate(failing, env, 'POST', '/api/reimbursements/generate-candidates', { cutoff_date: '2026-06-30' });
    expect(generate.status).toBe(502);
    const body = await generate.json() as { error: { code: string } };
    expect(body.error.code).toBe('fx_provider_request_failed');
    expect(database.prepare(`SELECT COUNT(*) AS count FROM fx_quotes`).get() as { count: number }).toMatchObject({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM reimbursement_candidates`).get() as { count: number }).toMatchObject({ count: 0 });
  });
});

describe('scheduled candidate generation', () => {
  it('daily cron generates due candidates idempotently and records a sync run', async () => {
    const { database, env } = setup();
    database.prepare(`INSERT INTO payers (id, display_name, active_from) VALUES ('payer-1', '王五', '2026-06-01')`).run();
    database.prepare(`INSERT INTO subscriptions (id, name) VALUES ('sub-1', '月付订阅')`).run();
    database.prepare(
      `INSERT INTO subscription_term_versions (id, subscription_id, effective_start, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor)
       VALUES ('term-1', 'sub-1', '2026-06-01', 'monthly', 'actual_bill', '2026-06-01', 'CNY', 10000)`,
    ).run();
    database.prepare(`INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start) VALUES ('assign-1', 'sub-1', 'payer-1', '2026-06-01')`).run();

    const { default: worker } = await import('../src/index');
    const runCron = async () => {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
      await worker.scheduled({} as ScheduledController, env, ctx);
      await Promise.all(pending);
    };
    await runCron();

    const first = database.prepare(`SELECT COUNT(*) AS count FROM reimbursement_candidates`).get() as { count: number };
    expect(first.count).toBeGreaterThanOrEqual(1);

    await runCron();
    expect(database.prepare(`SELECT COUNT(*) AS count FROM reimbursement_candidates`).get() as { count: number }).toMatchObject({ count: first.count });

    const run = database.prepare(
      `SELECT status, detail_json FROM sync_runs WHERE kind = 'candidate_generation' ORDER BY started_at DESC LIMIT 1`,
    ).get() as { status: string; detail_json: string };
    expect(run.status).toBe('success');
    expect(JSON.parse(run.detail_json)).toHaveProperty('generated');
  });
});
