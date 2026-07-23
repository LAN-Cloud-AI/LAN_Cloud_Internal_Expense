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

const adminIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'finance-admin-subject',
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

function setup() {
  const database = createDatabase();
  const env: Env = {
    DB: sqliteD1(database),
    ENVIRONMENT: 'production',
    DEV_AUTH: '1',
    ACCESS_AUD_CORPORATE: 'corporate-aud',
  };
  const app = createApp({
    resolveIdentity: async (request) =>
      request.headers.get('x-test-identity') === 'admin' ? adminIdentity : null,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
  });
  return { app, database, env };
}

async function call(app: ReturnType<typeof createApp>, env: Env, path: string): Promise<Response> {
  return app.request(`https://${CORPORATE_HOST}${path}`, { headers: { 'x-test-identity': 'admin' } }, env);
}

async function adminSession(app: ReturnType<typeof createApp>, env: Env, database: Database.Database, roles: string[] = ['role-system-admin']): Promise<string> {
  const response = await call(app, env, '/api/session');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { user_id: string } };
  for (const role of roles) {
    database.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(body.data.user_id, role);
  }
  return body.data.user_id;
}

function seedFinance(database: Database.Database, userId: string): void {
  database.prepare(`INSERT INTO payers (id, display_name, active_from) VALUES ('payer-1', '付款者', '2026-01-01')`).run();
  database.prepare(`INSERT INTO subscriptions (id, name) VALUES ('sub-1', '订阅')`).run();
  database.prepare(
    `INSERT INTO subscription_term_versions (id, subscription_id, effective_start, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor)
     VALUES ('term-1', 'sub-1', '2026-01-01', 'monthly', 'actual_bill', '2026-01-01', 'CNY', 10000)`,
  ).run();
  database.prepare(`INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start) VALUES ('assign-1', 'sub-1', 'payer-1', '2026-01-01')`).run();
  database.prepare(
    `INSERT INTO reimbursement_candidates (
       id, subscription_term_version_id, payer_assignment_id, coverage_start, coverage_end,
       original_currency, original_amount_minor, rate_numerator, rate_denominator, cny_amount_fen, status
     ) VALUES ('cand-1', 'term-1', 'assign-1', '2026-07-01', '2026-07-31', 'CNY', 7000, 1, 1, 7000, 'pending')`,
  ).run();
  database.prepare(
    `INSERT INTO idempotency_requests (id, actor_id, action, idempotency_key, request_hash)
     VALUES ('idem-1', ?, 'a', 'k1', 'h1'), ('idem-2', ?, 'a', 'k2', 'h2'), ('idem-3', ?, 'a', 'k3', 'h3'), ('idem-4', ?, 'a', 'k4', 'h4')`,
  ).run(userId, userId, userId, userId);
  database.prepare(
    `INSERT INTO reimbursement_submissions (id, actor_id, cutoff_date, idempotency_request_id, status)
     VALUES ('subm-1', ?, '2026-07-22', 'idem-1', 'submitted'), ('subm-2', ?, '2026-07-22', 'idem-2', 'completed'),
            ('subm-3', ?, '2026-07-22', 'idem-3', 'completed'), ('subm-4', ?, '2026-07-22', 'idem-4', 'completed')`,
  ).run(userId, userId, userId, userId);
  database.prepare(
    `INSERT INTO reimbursement_batches (id, submission_id, payer_id, coverage_start, coverage_end, total_cny_fen, status, paid_at)
     VALUES
       ('batch-review', 'subm-1', 'payer-1', '2026-07-01', '2026-07-31', 5000, 'submitted', NULL),
       ('batch-approved', 'subm-2', 'payer-1', '2026-07-01', '2026-07-31', 6000, 'approved', NULL),
       ('batch-paid-jul', 'subm-3', 'payer-1', '2026-07-01', '2026-07-31', 8000, 'paid', '2026-07-15'),
       ('batch-paid-feb', 'subm-4', 'payer-1', '2026-02-01', '2026-02-28', 3000, 'paid', '2026-02-10')`,
  ).run();
}

describe('finance overview', () => {
  it('aggregates pipeline, fiscal periods and monthly paid series', async () => {
    const { app, env, database } = setup();
    const userId = await adminSession(app, env, database);
    seedFinance(database, userId);

    const response = await call(app, env, '/api/finance/overview');
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: Record<string, unknown> };

    expect(data.pending_candidates).toMatchObject({ count: 1, total_cny_fen: 7000 });
    expect(data.review_batches).toMatchObject({ count: 1, total_cny_fen: 5000 });
    expect(data.approved_batches).toMatchObject({ count: 1, total_cny_fen: 6000 });
    expect(data.paid_year).toMatchObject({ period: '2026', count: 2, total_cny_fen: 11000 });
    expect(data.paid_quarter).toMatchObject({ period: '2026-Q3', count: 1, total_cny_fen: 8000 });
    expect(data.paid_month).toMatchObject({ period: '2026-07', count: 1, total_cny_fen: 8000 });

    const monthly = data.monthly_paid as Array<{ month: string; total_cny_fen: number }>;
    expect(monthly).toHaveLength(12);
    expect(monthly[0]?.month).toBe('2025-08');
    expect(monthly.at(-1)?.month).toBe('2026-07');
    const byMonth = new Map(monthly.map((point) => [point.month, point.total_cny_fen]));
    expect(byMonth.get('2026-02')).toBe(3000);
    expect(byMonth.get('2026-07')).toBe(8000);
  });

  it('requires finance roles', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database, []);

    const response = await call(app, env, '/api/finance/overview');
    expect(response.status).toBe(403);
  });
});
