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
  subject: 'admin-subject',
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
    resolveIdentity: async (request) => {
      const kind = request.headers.get('x-test-identity');
      if (kind === 'admin') return adminIdentity;
      if (kind === 'guest') {
        return { issuer: 'https://team.cloudflareaccess.com', subject: 'guest-subject', email: 'guest@example.com' };
      }
      return null;
    },
  });
  return { app, database, env };
}

async function request(
  app: ReturnType<typeof createApp>,
  env: Env,
  path: string,
  identity: 'admin' | 'guest' | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (identity) headers.set('x-test-identity', identity);
  return app.request(`https://${CORPORATE_HOST}${path}`, { ...init, headers }, env);
}

async function mutate(
  app: ReturnType<typeof createApp>,
  env: Env,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return request(app, env, path, 'admin', {
    method,
    headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function adminSession(app: ReturnType<typeof createApp>, env: Env, database: Database.Database): Promise<string> {
  const response = await request(app, env, '/api/session', 'admin');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { user_id: string } };
  database.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, 'role-system-admin')`).run(body.data.user_id);
  return body.data.user_id;
}

describe('login whitelist', () => {
  it('seeds the corporate domain and manages rules with validation', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);

    const list = await request(app, env, '/api/login-whitelist', 'admin');
    const rules = (await list.json() as { data: Array<Record<string, unknown>> }).data;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: 'domain', value: 'lancloudtech.com' });

    const badEmail = await mutate(app, env, 'POST', '/api/login-whitelist', { kind: 'email', value: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    const badDomain = await mutate(app, env, 'POST', '/api/login-whitelist', { kind: 'domain', value: 'user@example.com' });
    expect(badDomain.status).toBe(400);

    const addEmail = await mutate(app, env, 'POST', '/api/login-whitelist', { kind: 'email', value: ' Guest@Example.com ' });
    expect(addEmail.status).toBe(201);
    const addDomain = await mutate(app, env, 'POST', '/api/login-whitelist', { kind: 'domain', value: 'Contractor.dev' });
    expect(addDomain.status).toBe(201);
    const after = (await (await request(app, env, '/api/login-whitelist', 'admin')).json() as { data: Array<Record<string, unknown>> }).data;
    expect(after.map((rule) => rule.value).sort()).toEqual(['contractor.dev', 'guest@example.com', 'lancloudtech.com']);
  });

  it('refuses to delete the last remaining rule', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);

    const blocked = await mutate(app, env, 'DELETE', '/api/login-whitelist/wl-domain-lancloudtech');
    expect(blocked.status).toBe(409);

    await mutate(app, env, 'POST', '/api/login-whitelist', { kind: 'domain', value: 'example.com' });
    const removed = await mutate(app, env, 'DELETE', '/api/login-whitelist/wl-domain-lancloudtech');
    expect(removed.status).toBe(200);
    // 删除自己命中的规则后，管理员自身也不再命中白名单（系统按预期拒绝）；
    // 直接核对库内剩余规则。
    const rules = database.prepare(`SELECT kind, value FROM login_whitelist`).all() as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: 'domain', value: 'example.com' });
  });

  it('auto-provisions whitelisted logins as employee and rejects non-whitelisted ones', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);

    const denied = await request(app, env, '/api/session', 'guest');
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json() as { error: { code: string } };
    expect(deniedBody.error.code).toBe('email_not_whitelisted');

    await mutate(app, env, 'POST', '/api/login-whitelist', { kind: 'email', value: 'guest@example.com' });
    const allowed = await request(app, env, '/api/session', 'guest');
    expect(allowed.status).toBe(200);
    const session = await allowed.json() as { data: { roles: string[] } };
    expect(session.data.roles).toEqual(['employee']);
  });
});

describe('payer creation from active employees', () => {
  it('creates a payer from an active employee, defaulting name and start date', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    database.prepare(`INSERT INTO users (id, display_name, employment_status) VALUES ('user-active', '在职员工', 'active'), ('user-inactive', '离职员工', 'inactive')`).run();

    const created = await mutate(app, env, 'POST', '/api/payers', { owner_user_id: 'user-active', payment_method_masked: '支付宝' });
    expect(created.status).toBe(201);
    const payer = database.prepare(`SELECT display_name, owner_user_id, payment_method_masked, active_from, status FROM payers`).get() as Record<string, unknown>;
    expect(payer).toMatchObject({ display_name: '在职员工', owner_user_id: 'user-active', payment_method_masked: '支付宝', status: 'active' });
    expect(typeof payer.active_from).toBe('string');

    const inactive = await mutate(app, env, 'POST', '/api/payers', { owner_user_id: 'user-inactive' });
    expect(inactive.status).toBe(404);
    const ghost = await mutate(app, env, 'POST', '/api/payers', { owner_user_id: 'ghost-user' });
    expect(ghost.status).toBe(404);
  });
});

describe('account asset editing', () => {
  it('updates name, identifier, owner, expiry and status', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);
    database.prepare(`INSERT INTO users (id, display_name) VALUES ('user-owner', '资产归属')`).run();
    database.prepare(
      `INSERT INTO account_assets (id, owner_user_id, account_identifier_masked, display_name, status)
       VALUES ('acc-1', NULL, 'old@example.com', '旧账号', 'active')`,
    ).run();

    const update = await mutate(app, env, 'PUT', '/api/account-assets/acc-1', {
      display_name: '新账号',
      asset_identifier: '更新后服务',
      account_identifier: 'new@example.com',
      owner_user_id: 'user-owner',
      expires_on: '2027-01-01',
      status: 'inactive',
    });
    expect(update.status).toBe(200);
    const row = database.prepare(`SELECT display_name, asset_identifier, account_identifier_masked, owner_user_id, expires_on, status FROM account_assets WHERE id = 'acc-1'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      display_name: '新账号',
      asset_identifier: '更新后服务',
      account_identifier_masked: 'new@example.com',
      owner_user_id: 'user-owner',
      expires_on: '2027-01-01',
      status: 'inactive',
    });
    const updatedAudit = database.prepare(
      "SELECT detail_json FROM audit_events WHERE action = 'update_account_asset' AND entity_id = 'acc-1'",
    ).get() as { detail_json: string };
    expect(JSON.parse(updatedAudit.detail_json)).toMatchObject({
      display_name: '新账号',
      asset_identifier: '更新后服务',
      status: 'inactive',
    });

    const ghost = await mutate(app, env, 'PUT', '/api/account-assets/ghost', { display_name: '不存在' });
    expect(ghost.status).toBe(404);
    const badOwner = await mutate(app, env, 'PUT', '/api/account-assets/acc-1', { owner_user_id: 'ghost-user' });
    expect(badOwner.status).toBe(404);
  });

  it('creates and lists asset identifiers, and rejects retired dynamic fields', async () => {
    const { app, env, database } = setup();
    await adminSession(app, env, database);

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
    const createdAudit = database.prepare(
      "SELECT detail_json FROM audit_events WHERE action = 'create_account_asset'",
    ).get() as { detail_json: string };
    expect(JSON.parse(createdAudit.detail_json)).toMatchObject({
      display_name: '演示 OBS 账号',
      asset_identifier: 'OBS',
    });

    const list = await request(app, env, '/api/account-assets', 'admin');
    expect(list.status).toBe(200);
    const listBody = await list.json() as { data: Array<Record<string, unknown>> };
    expect(listBody.data).toContainEqual(expect.objectContaining({
      display_name: '演示 OBS 账号',
      asset_identifier: 'OBS',
    }));

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

    const createdField = await mutate(app, env, 'POST', '/api/account-field-definitions', {
      field_key: 'legacy_field',
      label: '旧字段',
      field_type: 'text',
    });
    expect(createdField.status).toBe(410);
    const createdFieldBody = await createdField.json() as { error: { code: string } };
    expect(createdFieldBody.error.code).toBe('account_fields_deprecated');

    const values = await mutate(app, env, 'PUT', '/api/account-assets/missing/field-values', { values: [] });
    expect(values.status).toBe(410);
    const valuesBody = await values.json() as { error: { code: string } };
    expect(valuesBody.error.code).toBe('account_fields_deprecated');
  });
});

describe('user editing', () => {
  it('serves pages and API responses with no-store so deploys are visible immediately', async () => {
    const database = createDatabase();
    const env: Env = {
      DB: sqliteD1(database),
      ENVIRONMENT: 'production',
      DEV_AUTH: '1',
      ACCESS_AUD_CORPORATE: 'corporate-aud',
    };
    const app = createApp({ resolveIdentity: async () => null });

    const page = await app.request('https://ie-oa.lancloudtech.com/', {}, env);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const api = await app.request('https://ie-oa.lancloudtech.com/api/health', {}, env);
    expect(api.headers.get('cache-control')).toBe('no-store');
    const missing = await app.request('https://ie-oa.lancloudtech.com/api/nope', {}, env);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });

  it('redirects /logout to the team-domain global logout so all entries sign out', async () => {
    const database = createDatabase();
    const env: Env = {
      DB: sqliteD1(database),
      ENVIRONMENT: 'production',
      ACCESS_AUD_CORPORATE: 'corporate-aud',
      ACCESS_ISSUER: 'https://long-sky-131d.cloudflareaccess.com',
    };
    const app = createApp({ resolveIdentity: async () => null });

    const response = await app.request('https://ie-oa.lancloudtech.com/logout', { redirect: 'manual' }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://long-sky-131d.cloudflareaccess.com/cdn-cgi/access/logout');

    const fallbackEnv: Env = { ...env, ACCESS_ISSUER: undefined };
    const fallback = await app.request('https://ie-oa.lancloudtech.com/logout', { redirect: 'manual' }, fallbackEnv);
    expect(fallback.headers.get('location')).toBe('/cdn-cgi/access/logout');
  });

  it('updates display name and employment status', async () => {
    const { app, env, database } = setup();
    const adminId = await adminSession(app, env, database);
    database.prepare(`INSERT INTO users (id, display_name) VALUES ('user-target', '旧名字')`).run();

    const update = await mutate(app, env, 'PUT', '/api/users/user-target', { display_name: '新名字', employment_status: 'inactive' });
    expect(update.status).toBe(200);
    const row = database.prepare(`SELECT display_name, employment_status FROM users WHERE id = 'user-target'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ display_name: '新名字', employment_status: 'inactive' });

    const partial = await mutate(app, env, 'PUT', '/api/users/user-target', { employment_status: 'active' });
    expect(partial.status).toBe(200);
    expect(database.prepare(`SELECT display_name FROM users WHERE id = 'user-target'`).get() as Record<string, unknown>).toMatchObject({ display_name: '新名字' });

    const missing = await mutate(app, env, 'PUT', '/api/users/ghost-user', { display_name: '不存在' });
    expect(missing.status).toBe(404);
    const audit = database.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE action = 'update_user'`).get() as { count: number };
    expect(audit.count).toBeGreaterThanOrEqual(2);
    expect(adminId).toBeTruthy();
  });
});
