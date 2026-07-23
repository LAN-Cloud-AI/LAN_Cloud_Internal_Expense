import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import type { AuthenticatedIdentity } from '../src/lib/auth';
import type { Env } from '../src/lib/types';
import { sqliteD1, withD1StatementFailure } from './helpers/sqlite-d1';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const databases: Database.Database[] = [];

const CORPORATE_HOST = 'ie-oa.lancloudtech.com';
const LEGACY_HOST = 'ie_oa.lancloudtech.com';
const RETIRED_EXTERNAL_HOST = 'external-ie-oa.lancloudtech.com';

const corporateIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'corporate-subject',
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
    ENVIRONMENT: 'production',
    DEV_AUTH: '1',
    ACCESS_AUD_CORPORATE: 'corporate-aud',
  };
  const app = createApp({
    resolveIdentity: async (request) =>
      request.headers.get('x-test-identity') === 'corporate' ? corporateIdentity : null,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
  });
  return { app, database, env };
}

async function request(
  app: ReturnType<typeof createApp>,
  env: Env,
  host: string,
  path: string,
  identity: 'corporate' | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (identity) headers.set('x-test-identity', identity);
  return app.request(`https://${host}${path}`, { ...init, headers }, env);
}

async function corporateSession(
  app: ReturnType<typeof createApp>,
  env: Env,
): Promise<{ userId: string; roles: string[] }> {
  const response = await request(app, env, CORPORATE_HOST, '/api/session', 'corporate');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { user_id: string; roles: string[] } };
  return { userId: body.data.user_id, roles: body.data.roles };
}

describe('Worker corporate Access boundary', () => {
  it('auto-provisions a corporate Access identity with employee on its first session request', async () => {
    const { app, database, env } = setup();

    const session = await corporateSession(app, env);

    expect(session.roles).toEqual(['employee']);
    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 1 });
    expect(database.prepare(
      `SELECT identity_kind FROM user_access_identities WHERE user_id = ?`,
    ).get(session.userId)).toMatchObject({ identity_kind: 'corporate_primary' });
  });

  it('renders the corporate profile with the OTP identity page', async () => {
    const { app, env } = setup();

    const response = await request(app, env, CORPORATE_HOST, '/profile', 'corporate');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('登录身份');
    expect(html).toContain('企业主身份');
    expect(html).toContain('OTP');
    expect(html).not.toContain('绑定 GitHub');
    expect(html).not.toContain('绑定 Cloudflare');
  });

  it('gives a corporate anonymous visit a controlled explanation', async () => {
    const { app, env } = setup();

    const response = await request(app, env, CORPORATE_HOST, '/', null);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain('需要企业邮箱登录');
  });

  it('returns only employee-owned counts and fixed zero global dashboard categories', async () => {
    const { app, database, env } = setup();
    const session = await corporateSession(app, env);
    database.prepare(
      `INSERT INTO subscriptions (id, name, owner_user_id)
       VALUES ('subscription-owned', 'Owned subscription', ?)`,
    ).run(session.userId);
    database.prepare(
      `INSERT INTO account_assets (id, owner_user_id, account_identifier_masked, display_name)
       VALUES ('account-owned', ?, 'account **** 1234', 'Owned account')`,
    ).run(session.userId);

    const response = await request(app, env, CORPORATE_HOST, '/api/dashboard', 'corporate');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        pending_candidates: { count: 0, total_cny_fen: 0 },
        review_batches: { count: 0 },
        fx_exceptions: { count: 0 },
        owned_subscriptions: { count: 1 },
        owned_account_assets: { count: 1 },
      },
    });
  });

  it('denies employee access to payer data', async () => {
    const { app, env } = setup();
    await corporateSession(app, env);

    const response = await request(app, env, CORPORATE_HOST, '/api/payers', 'corporate');

    expect(response.status).toBe(403);
  });

  it('keeps all legacy requests out of the provisioning flow and redirects only safe methods', async () => {
    const { app, database, env } = setup();

    const legacyRead = await request(
      app,
      env,
      LEGACY_HOST,
      '/api/session?next=profile',
      null,
      { redirect: 'manual' },
    );
    expect(legacyRead.status).toBe(308);
    expect(legacyRead.headers.get('Location')).toBe(`https://${CORPORATE_HOST}/api/session?next=profile`);

    const legacyWrite = await request(
      app,
      env,
      LEGACY_HOST,
      '/api/subscriptions',
      'corporate',
      { method: 'POST', headers: { Origin: `https://${LEGACY_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(legacyWrite.status).toBe(410);
    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 0 });
  });

  it('retires the external entry host as unknown', async () => {
    const { app, env } = setup();

    const response = await request(app, env, RETIRED_EXTERNAL_HOST, '/api/session', 'corporate');

    expect(response.status).toBe(404);
  });

  it('rejects an unknown host before it can reach an API or bootstrap fallback', async () => {
    const { app, env } = setup();

    const unknown = await request(app, env, 'unexpected.lancloudtech.com', '/api/session', 'corporate');
    const bootstrap = await request(app, env, CORPORATE_HOST, '/api/bootstrap', 'corporate', {
      method: 'POST',
      headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(unknown.status).toBe(404);
    expect(bootstrap.status).toBe(404);
  });

  it('chooses the entry from the request URL rather than a spoofed Host header', async () => {
    const { app, env } = setup();

    const response = await request(
      app,
      env,
      'unexpected.lancloudtech.com',
      '/api/session',
      'corporate',
      { headers: { Host: CORPORATE_HOST } },
    );

    expect(response.status).toBe(404);
  });

  it('treats a dropped identity store as unavailable instead of downgrading authorization', async () => {
    const { app, database, env } = setup();
    env.DB = withD1StatementFailure(sqliteD1(database), (query) => query.includes('user_access_identities'));

    const response = await request(app, env, CORPORATE_HOST, '/api/session', 'corporate');

    expect(response.status).toBe(503);
  });
});
