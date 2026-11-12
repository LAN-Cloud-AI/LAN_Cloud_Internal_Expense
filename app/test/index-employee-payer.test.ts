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

const employeeIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'employee-subject',
  email: 'employee@lancloudtech.com',
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
    ENVIRONMENT: 'test',
    ONEPASS_LOGIN_MODE: 'access',
    DEV_AUTH: '1',
    ACCESS_AUD_CORPORATE: 'corporate-aud',
    FX_PROVIDER: 'frankfurter-ecb',
    FX_PROVIDER_URL: 'https://api.frankfurter.dev/v1/latest',
  };
  const app = createApp({
    resolveIdentity: async (request) =>
      request.headers.get('x-test-identity') === 'employee' ? employeeIdentity : null,
    fetcher: (async () => Response.json({ date: '2026-06-01', rates: { CNY: 7.2 } })) as typeof fetch,
  });
  return { app, database, env };
}

async function call(
  app: ReturnType<typeof createApp>,
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { 'x-test-identity': 'employee' };
  if (method === 'POST') {
    headers.Origin = `https://${CORPORATE_HOST}`;
    headers['Content-Type'] = 'application/json';
  }
  return app.request(`https://${CORPORATE_HOST}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

async function employeeUserId(app: ReturnType<typeof createApp>, env: Env): Promise<string> {
  const response = await call(app, env, 'GET', '/api/session');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { user_id: string; roles: string[] } };
  expect(body.data.roles).toEqual(['employee']);
  return body.data.user_id;
}

function seed(database: Database.Database, employeeUser: string): void {
  database.prepare(`INSERT INTO payers (id, display_name, owner_user_id, active_from) VALUES ('payer-me', '我自己', ?, '2026-06-01'), ('payer-other', '别人', NULL, '2026-06-01')`).run(employeeUser);
  database.prepare(`INSERT INTO users (id, display_name) VALUES ('user-reviewer', '财务审核'), ('user-finance2', '财务乙')`).run();
  database.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('user-reviewer', 'role-finance-reviewer'), ('user-finance2', 'role-finance-reviewer')`).run();
  database.prepare(`INSERT INTO subscriptions (id, name, owner_user_id) VALUES ('sub-mine', '我的订阅', NULL), ('sub-other', '别人的订阅', NULL)`).run();
  database.prepare(
    `INSERT INTO subscription_term_versions (id, subscription_id, effective_start, billing_cycle, settlement_mode, billing_anchor_date, original_currency, amount_minor)
     VALUES ('term-mine', 'sub-mine', '2026-06-01', 'monthly', 'actual_bill', '2026-06-01', 'CNY', 10000),
            ('term-other', 'sub-other', '2026-06-01', 'monthly', 'actual_bill', '2026-06-01', 'CNY', 20000)`,
  ).run();
  database.prepare(
    `INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start)
     VALUES ('assign-mine', 'sub-mine', 'payer-me', '2026-06-01'),
            ('assign-other', 'sub-other', 'payer-other', '2026-06-01')`,
  ).run();
  database.prepare(
    `INSERT INTO reimbursement_candidates (
       id, subscription_term_version_id, payer_assignment_id, coverage_start, coverage_end,
       original_currency, original_amount_minor, rate_numerator, rate_denominator, cny_amount_fen, status
     ) VALUES
       ('cand-mine', 'term-mine', 'assign-mine', '2026-06-01', '2026-06-30', 'CNY', 10000, 1, 1, 10000, 'pending'),
       ('cand-other', 'term-other', 'assign-other', '2026-06-01', '2026-06-30', 'CNY', 20000, 1, 1, 20000, 'pending')`,
  ).run();
}

describe('employee payer self-service', () => {
  it('sees only subscriptions used or paid by themselves', async () => {
    const { app, env, database } = setup();
    const userId = await employeeUserId(app, env);
    seed(database, userId);

    const list = await call(app, env, 'GET', '/api/subscriptions');
    expect(list.status).toBe(200);
    const rows = (await list.json() as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: '我的订阅', payer_name: '我自己' });
  });

  it('lists, previews and submits only own-payer candidates', async () => {
    const { app, env, database } = setup();
    const userId = await employeeUserId(app, env);
    seed(database, userId);

    const candidates = await call(app, env, 'GET', '/api/reimbursements/candidates');
    expect(candidates.status).toBe(200);
    const rows = (await candidates.json() as { data: Array<Record<string, unknown>> }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'cand-mine', subscription_name: '我的订阅', payer_name: '我自己' });

    const preview = await call(app, env, 'POST', '/api/reimbursements/preview', { cutoff_date: '2026-06-30', candidate_ids: ['cand-mine'], reviewer_user_id: 'user-reviewer' });
    expect(preview.status).toBe(200);

    const missingReviewer = await call(app, env, 'POST', '/api/reimbursements/create-batches', { cutoff_date: '2026-06-30', candidate_ids: ['cand-mine'] });
    expect(missingReviewer.status).toBe(400);

    const create = await app.request(`https://${CORPORATE_HOST}/api/reimbursements/create-batches`, {
      method: 'POST',
      headers: {
        'x-test-identity': 'employee',
        Origin: `https://${CORPORATE_HOST}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'employee-batch-1',
      },
      body: JSON.stringify({ cutoff_date: '2026-06-30', candidate_ids: ['cand-mine'], reviewer_user_id: 'user-reviewer' }),
    }, env);
    expect(create.status).toBe(201);

    const denied = await app.request(`https://${CORPORATE_HOST}/api/reimbursements/create-batches`, {
      method: 'POST',
      headers: {
        'x-test-identity': 'employee',
        Origin: `https://${CORPORATE_HOST}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'employee-batch-2',
      },
      body: JSON.stringify({ cutoff_date: '2026-06-30', candidate_ids: ['cand-other'], reviewer_user_id: 'user-reviewer' }),
    }, env);
    expect(denied.status).toBe(403);

    const batches = await call(app, env, 'GET', '/api/reimbursements/batches');
    expect(batches.status).toBe(200);
    const batchRows = (await batches.json() as { data: Array<Record<string, unknown>> }).data;
    expect(batchRows).toHaveLength(1);
    expect(batchRows[0]).toMatchObject({ payer_name: '我自己', total_cny_fen: 10000 });

    // 记录“提交人 → 报销人”：批次列表带提交人姓名，审计 detail 按报销人拆账。
    const employeeName = (database.prepare(`SELECT display_name FROM users WHERE id = ?`).get(userId) as { display_name: string }).display_name;
    expect(batchRows[0]?.actor_name).toBe(employeeName);
    expect(batchRows[0]?.reviewer_name).toBe('财务审核');
    const audit = database.prepare(
      `SELECT detail_json FROM audit_events WHERE action = 'create_reimbursement_submission' ORDER BY created_at DESC LIMIT 1`,
    ).get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      batch_count: 1,
      reviewer: '财务审核',
      payers: [{ payer_name: '我自己', total_cny_fen: 10000, candidate_count: 1 }],
    });
  });

  it('generates candidates only for own-payer subscriptions', async () => {
    const { app, env, database } = setup();
    const userId = await employeeUserId(app, env);
    seed(database, userId);
    database.prepare(`DELETE FROM reimbursement_candidates`).run();

    const generate = await call(app, env, 'POST', '/api/reimbursements/generate-candidates', { cutoff_date: '2026-06-30' });
    expect(generate.status).toBe(201);
    const result = await generate.json() as { generated: number; source_count: number };
    expect(result.source_count).toBe(1);
    expect(result.generated).toBeGreaterThanOrEqual(1);

    const subs = database.prepare(
      `SELECT DISTINCT term.subscription_id FROM reimbursement_candidates candidate
       JOIN subscription_term_versions term ON term.id = candidate.subscription_term_version_id`,
    ).all() as Array<{ subscription_id: string }>;
    expect(subs).toEqual([{ subscription_id: 'sub-mine' }]);
  });

  it('reports personal reimbursement metrics on the dashboard', async () => {
    const { app, env, database } = setup();
    const userId = await employeeUserId(app, env);
    seed(database, userId);
    database.prepare(
      `INSERT INTO idempotency_requests (id, actor_id, action, idempotency_key, request_hash)
       VALUES ('idem-1', ?, 'create_reimbursement_batches', 'k1', 'h1'), ('idem-2', ?, 'create_reimbursement_batches', 'k2', 'h2')`,
    ).run(userId, userId);
    database.prepare(
      `INSERT INTO reimbursement_submissions (id, actor_id, cutoff_date, idempotency_request_id, status)
       VALUES ('subm-1', ?, '2026-06-30', 'idem-1', 'submitted'), ('subm-2', ?, '2026-06-30', 'idem-2', 'completed')`,
    ).run(userId, userId);
    database.prepare(
      `INSERT INTO reimbursement_batches (id, submission_id, payer_id, coverage_start, coverage_end, total_cny_fen, status)
       VALUES
         ('batch-inflight', 'subm-1', 'payer-me', '2026-06-01', '2026-06-30', 10000, 'submitted'),
         ('batch-paid', 'subm-2', 'payer-me', '2026-05-01', '2026-05-31', 8000, 'paid'),
         ('batch-other', 'subm-2', 'payer-other', '2026-05-01', '2026-05-31', 99900, 'paid')`,
    ).run();

    const dashboard = await call(app, env, 'GET', '/api/dashboard');
    expect(dashboard.status).toBe(200);
    const data = (await dashboard.json() as { data: Record<string, { count: number; total_cny_fen: number }> }).data;
    expect(data.my_pending_candidates).toMatchObject({ count: 1, total_cny_fen: 10000 });
    expect(data.my_inflight_batches).toMatchObject({ count: 1, total_cny_fen: 10000 });
    expect(data.my_paid_batches).toMatchObject({ count: 1, total_cny_fen: 8000 });
  });

  it('restricts approval to the assigned reviewer and allows system_admin override', async () => {
    const { app, env, database } = setup();
    const userId = await employeeUserId(app, env);
    seed(database, userId);

    const reviewersList = await call(app, env, 'GET', '/api/reimbursements/reviewers');
    expect(reviewersList.status).toBe(200);
    const reviewers = (await reviewersList.json() as { data: Array<Record<string, unknown>> }).data;
    expect(reviewers.map((row) => row.id).sort()).toEqual(['user-finance2', 'user-reviewer']);

    const create = await app.request(`https://${CORPORATE_HOST}/api/reimbursements/create-batches`, {
      method: 'POST',
      headers: {
        'x-test-identity': 'employee',
        Origin: `https://${CORPORATE_HOST}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'employee-batch-3',
      },
      body: JSON.stringify({ cutoff_date: '2026-06-30', candidate_ids: ['cand-mine'], reviewer_user_id: 'user-reviewer' }),
    }, env);
    expect(create.status).toBe(201);
    const batchId = (database.prepare(`SELECT id FROM reimbursement_batches`).get() as { id: string }).id;
    expect(database.prepare(`SELECT reviewer_user_id FROM reimbursement_batches WHERE id = ?`).get(batchId)).toMatchObject({ reviewer_user_id: 'user-reviewer' });

    const approveAs = async (subject: string, email: string, grantRole: string) => {
      const appFor = createApp({
        resolveIdentity: async (request) =>
          request.headers.get('x-test-identity') === 'reviewer'
            ? { issuer: 'https://team.cloudflareaccess.com', subject, email }
            : null,
      });
      const session = await appFor.request(`https://${CORPORATE_HOST}/api/session`, { headers: { 'x-test-identity': 'reviewer' } }, env);
      const body = await session.json() as { data: { user_id: string } };
      database.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(body.data.user_id, grantRole);
      return { appFor, userId: body.data.user_id };
    };
    const approve = (appFor: ReturnType<typeof createApp>, path: string) => appFor.request(`https://${CORPORATE_HOST}${path}`, {
      method: 'POST',
      headers: { 'x-test-identity': 'reviewer', Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' },
      body: path.endsWith('mark-paid') ? JSON.stringify({ paid_at: '2026-07-01' }) : '{}',
    }, env);

    // 被指派审批人用自己的真实用户行替换指派（模拟其首次登录后成为审批人）。
    const reviewerA = await approveAs('finance-subject', 'finance@lancloudtech.com', 'role-finance-reviewer');
    database.prepare(`UPDATE reimbursement_batches SET reviewer_user_id = ? WHERE id = ?`).run(reviewerA.userId, batchId);

    const wrongReviewer = await approveAs('finance2-subject', 'finance2@lancloudtech.com', 'role-finance-reviewer');
    expect((await approve(wrongReviewer.appFor, `/api/reimbursements/${batchId}/approve`)).status).toBe(403);

    expect((await approve(reviewerA.appFor, `/api/reimbursements/${batchId}/approve`)).status).toBe(200);
    expect((await approve(reviewerA.appFor, `/api/reimbursements/${batchId}/mark-paid`)).status).toBe(200);

    database.prepare(
      `INSERT INTO reimbursement_candidates (
         id, subscription_term_version_id, payer_assignment_id, coverage_start, coverage_end,
         original_currency, original_amount_minor, rate_numerator, rate_denominator, cny_amount_fen, status
       ) VALUES ('cand-mine2', 'term-mine', 'assign-mine', '2026-07-01', '2026-07-23', 'CNY', 10000, 1, 1, 10000, 'pending')`,
    ).run();
    const second = await app.request(`https://${CORPORATE_HOST}/api/reimbursements/create-batches`, {
      method: 'POST',
      headers: {
        'x-test-identity': 'employee',
        Origin: `https://${CORPORATE_HOST}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'employee-batch-4',
      },
      body: JSON.stringify({ cutoff_date: '2026-07-23', candidate_ids: ['cand-mine2'], reviewer_user_id: 'user-finance2' }),
    }, env);
    expect(second.status).toBe(201);
    const secondBatchId = (database.prepare(`SELECT id FROM reimbursement_batches WHERE status = 'submitted'`).get() as { id: string }).id;
    const adminA = await approveAs('admin-subject', 'boss@lancloudtech.com', 'role-system-admin');
    expect((await approve(adminA.appFor, `/api/reimbursements/${secondBatchId}/approve`)).status).toBe(200);
  });
});
