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
const EXTERNAL_HOST = 'external-ie-oa.lancloudtech.com';
const LEGACY_HOST = 'ie_oa.lancloudtech.com';

const corporateIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'corporate-subject',
  email: 'employee@lancloudtech.com',
};
const externalIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'external-subject',
  email: 'personal@example.com',
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
    ACCESS_AUD_EXTERNAL: 'external-aud',
  };
  const app = createApp({
    resolveIdentity: async (request) => {
      switch (request.headers.get('x-test-identity')) {
        case 'corporate':
          return corporateIdentity;
        case 'external':
          return externalIdentity;
        case 'external-bound':
          return { ...externalIdentity, subject: 'external-bound-subject' };
        default:
          return null;
      }
    },
    now: () => new Date('2026-07-22T12:00:00.000Z'),
  });
  return { app, database, env };
}

async function request(
  app: ReturnType<typeof createApp>,
  env: Env,
  host: string,
  path: string,
  identity: 'corporate' | 'external' | 'external-bound' | null,
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

describe('Worker dual-entry Access boundary', () => {
  it('renders only the data-free binding page for an unbound external identity', async () => {
    const { app, env } = setup();

    const [home, unknown] = await Promise.all([
      request(app, env, EXTERNAL_HOST, '/', 'external'),
      request(app, env, EXTERNAL_HOST, '/not-a-business-page', 'external'),
    ]);
    const html = await home.text();

    expect(home.status).toBe(200);
    expect(unknown.status).toBe(200);
    await expect(unknown.text()).resolves.toContain('输入绑定码');
    expect(html).toContain('输入绑定码');
    expect(html).not.toContain('订阅资产');
    expect(html).not.toContain('报销中心');
    expect(html).not.toContain('bootstrap-admin');
  });

  it('renders a data-free external Access-login-required page when no external identity is signed', async () => {
    const { app, env } = setup();

    const [home, unknown] = await Promise.all([
      request(app, env, EXTERNAL_HOST, '/', null),
      request(app, env, EXTERNAL_HOST, '/not-a-business-page', null),
    ]);
    const html = await home.text();

    expect(home.status).toBe(401);
    expect(unknown.status).toBe(401);
    await expect(unknown.text()).resolves.toContain('需要外部 Access 登录');
    expect(html).toContain('需要外部 Access 登录');
    expect(html).not.toContain('external-binding-form');
    expect(html).not.toContain('输入绑定码');
    expect(html).not.toContain('/api/external/identity-presentations');
    expect(html).not.toContain('订阅资产');
  });

  it('renders the corporate profile only with a resolved corporate principal', async () => {
    const { app, env } = setup();

    const response = await request(app, env, CORPORATE_HOST, '/profile', 'corporate');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('登录身份');
    expect(html).toContain('企业主身份（不可解绑）');
    expect(html).not.toContain('bootstrap-admin');
  });

  it('keeps external profile access on the corporate entry and gives a corporate anonymous visit a controlled explanation', async () => {
    const { app, env } = setup();

    const externalProfile = await request(
      app,
      env,
      EXTERNAL_HOST,
      '/profile',
      'external',
      { redirect: 'manual' },
    );
    const corporateAnonymous = await request(app, env, CORPORATE_HOST, '/', null);

    expect(externalProfile.status).toBe(302);
    expect(externalProfile.headers.get('Location')).toBe(`https://${CORPORATE_HOST}/profile`);
    expect(corporateAnonymous.status).toBe(401);
    await expect(corporateAnonymous.text()).resolves.toContain('需要企业邮箱登录');
  });

  it('allows an already linked external identity to render regular business UI without a profile page', async () => {
    const { app, database, env } = setup();
    const session = await corporateSession(app, env);
    database.prepare(
      `INSERT INTO user_access_identities
        (id, user_id, issuer, subject, verified_email, identity_kind, provider_hint)
       VALUES ('linked-external-ui', ?, ?, 'external-bound-subject', 'personal@example.com', 'linked_external', 'github')`,
    ).run(session.userId, externalIdentity.issuer);

    const response = await request(app, env, EXTERNAL_HOST, '/accounts', 'external-bound');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('账号资产');
    expect(html).not.toContain('输入绑定码');
  });

  it('auto-provisions a corporate Access identity with employee on its first session request', async () => {
    const { app, database, env } = setup();

    const session = await corporateSession(app, env);

    expect(session.roles).toEqual(['employee']);
    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 1 });
    expect(database.prepare(
      `SELECT identity_kind FROM user_access_identities WHERE user_id = ?`,
    ).get(session.userId)).toMatchObject({ identity_kind: 'corporate_primary' });
  });

  it('does not grant an unbound external identity a business principal', async () => {
    const { app, env } = setup();

    const response = await request(app, env, EXTERNAL_HOST, '/api/dashboard', 'external');

    expect(response.status).toBe(401);
  });

  it('allows an unbound external identity to reach only the opaque presentation API', async () => {
    const { app, env } = setup();

    const response = await request(app, env, EXTERNAL_HOST, '/api/not-a-binding-api', 'external');

    expect(response.status).toBe(401);
  });

  it('does not treat a corporate primary identity as an external linked identity', async () => {
    const { app, env } = setup();
    await corporateSession(app, env);

    const response = await request(app, env, EXTERNAL_HOST, '/api/dashboard', 'corporate');

    expect(response.status).toBe(401);
  });

  it('does not let a linked external identity call corporate personal-identity APIs', async () => {
    const { app, database, env } = setup();
    const session = await corporateSession(app, env);
    database.prepare(
      `INSERT INTO user_access_identities
        (id, user_id, issuer, subject, verified_email, identity_kind, provider_hint)
       VALUES ('linked-external', ?, ?, 'external-bound-subject', 'personal@example.com', 'linked_external', 'github')`,
    ).run(session.userId, externalIdentity.issuer);

    const [response, recovery] = await Promise.all([
      request(app, env, EXTERNAL_HOST, '/api/me/identities', 'external-bound'),
      request(app, env, EXTERNAL_HOST, '/api/me/identities/link-transactions/recovery', 'external-bound'),
    ]);

    expect(response.status).toBe(401);
    expect(recovery.status).toBe(401);
  });

  it('returns only employee-owned counts and fixed zero global dashboard categories', async () => {
    const { app, database, env } = setup();
    const session = await corporateSession(app, env);
    database.prepare(`INSERT INTO vendors (id, name) VALUES ('vendor-owned', 'Owned Vendor')`).run();
    database.prepare(
      `INSERT INTO subscriptions (id, name, vendor_id, owner_user_id)
       VALUES ('subscription-owned', 'Owned subscription', 'vendor-owned', ?)`,
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
        import_exceptions: { count: 0 },
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

  it('requires the exact corporate entry Origin for identity-link writes', async () => {
    const { app, env } = setup();
    await corporateSession(app, env);

    const allowed = await request(
      app,
      env,
      CORPORATE_HOST,
      '/api/me/identities/link-transactions',
      'corporate',
      { method: 'POST', headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(allowed.status).toBe(201);
    await expect(allowed.json()).resolves.toMatchObject({
      data: { external_url: `https://${EXTERNAL_HOST}/` },
    });

    const attacker = await request(
      app,
      env,
      CORPORATE_HOST,
      '/api/me/identities/link-transactions',
      'corporate',
      { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(attacker.status).toBe(403);
  });

  it('recovers only the corporate caller’s safe unexpired link transactions and confirms a presented candidate', async () => {
    const { app, env } = setup();
    await corporateSession(app, env);
    const begin = await request(
      app,
      env,
      CORPORATE_HOST,
      '/api/me/identities/link-transactions',
      'corporate',
      { method: 'POST', headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    const beginBody = await begin.json() as { data: { id: string; code: string } };
    const presentation = await request(
      app,
      env,
      EXTERNAL_HOST,
      '/api/external/identity-presentations',
      'external',
      {
        method: 'POST',
        headers: { Origin: `https://${EXTERNAL_HOST}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: beginBody.data.code }),
      },
    );
    expect(presentation.status).toBe(204);

    const recovery = await request(
      app,
      env,
      CORPORATE_HOST,
      '/api/me/identities/link-transactions/recovery',
      'corporate',
    );
    const recoveryBody = await recovery.json() as {
      data: {
        transactions: Array<{
          id: string;
          status: string;
          provider_hint: string | null;
          email_masked: string | null;
        }>;
      };
    };

    expect(recovery.status).toBe(200);
    expect(recoveryBody.data.transactions).toContainEqual({
      id: beginBody.data.id,
      status: 'candidate_presented',
      expires_at: '2026-07-22T12:10:00.000Z',
      provider_hint: null,
      email_masked: 'p******l@example.com',
    });
    expect(JSON.stringify(recoveryBody)).not.toContain(beginBody.data.code);
    expect(JSON.stringify(recoveryBody)).not.toContain(externalIdentity.subject);
    expect(JSON.stringify(recoveryBody)).not.toContain(externalIdentity.email!);

    const confirm = await request(
      app,
      env,
      CORPORATE_HOST,
      `/api/me/identities/link-transactions/${encodeURIComponent(recoveryBody.data.transactions[0]!.id)}/confirm`,
      'corporate',
      { method: 'POST', headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(confirm.status).toBe(200);
  });

  it('does not expose link recovery to an unbound external-only principal', async () => {
    const { app, env } = setup();

    const response = await request(
      app,
      env,
      EXTERNAL_HOST,
      '/api/me/identities/link-transactions/recovery',
      'external',
    );

    expect(response.status).toBe(401);
  });

  it('uses only the verified external identity and gives the presentation endpoint no account data to reveal', async () => {
    const { app, database, env } = setup();
    await corporateSession(app, env);
    const begin = await request(
      app,
      env,
      CORPORATE_HOST,
      '/api/me/identities/link-transactions',
      'corporate',
      { method: 'POST', headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    const beginBody = await begin.json() as { data: { code: string } };

    const crossEntryOrigin = await request(
      app,
      env,
      EXTERNAL_HOST,
      '/api/external/identity-presentations',
      'external',
      {
        method: 'POST',
        headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: beginBody.data.code }),
      },
    );
    expect(crossEntryOrigin.status).toBe(403);

    const presentation = await request(
      app,
      env,
      EXTERNAL_HOST,
      '/api/external/identity-presentations',
      'external',
      {
        method: 'POST',
        headers: { Origin: `https://${EXTERNAL_HOST}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: beginBody.data.code,
          provider: 'github',
          issuer: 'attacker-controlled',
          subject: 'attacker-controlled',
          email: 'attacker@example.com',
        }),
      },
    );

    expect(presentation.status).toBe(204);
    await expect(presentation.text()).resolves.toBe('');
    expect(database.prepare(
      `SELECT candidate_issuer, candidate_subject, candidate_verified_email, candidate_provider_hint
       FROM identity_link_transactions`,
    ).get()).toMatchObject({
      candidate_issuer: externalIdentity.issuer,
      candidate_subject: externalIdentity.subject,
      candidate_verified_email: externalIdentity.email,
      candidate_provider_hint: null,
    });
  });

  it('returns an opaque rejection and leaves the code pending when candidate audit storage fails', async () => {
    const { app, database, env } = setup();
    env.DB = withD1StatementFailure(
      env.DB,
      (query) => query.includes("'present_linked_external_identity_candidate'"),
    );
    await corporateSession(app, env);
    const begin = await request(
      app,
      env,
      CORPORATE_HOST,
      '/api/me/identities/link-transactions',
      'corporate',
      { method: 'POST', headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    const beginBody = await begin.json() as { data: { id: string; code: string } };

    const presentation = await request(
      app,
      env,
      EXTERNAL_HOST,
      '/api/external/identity-presentations',
      'external',
      {
        method: 'POST',
        headers: { Origin: `https://${EXTERNAL_HOST}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: beginBody.data.code }),
      },
    );

    expect(presentation.status).toBe(400);
    await expect(presentation.json()).resolves.toEqual({
      error: { code: 'identity_presentation_rejected', message: '绑定请求未被接受。' },
    });
    expect(database.prepare(
      `SELECT status, candidate_issuer, candidate_subject, candidate_verified_email,
              candidate_provider_hint, consumed_at
       FROM identity_link_transactions WHERE id = ?`,
    ).get(beginBody.data.id)).toEqual({
      status: 'pending',
      candidate_issuer: null,
      candidate_subject: null,
      candidate_verified_email: null,
      candidate_provider_hint: null,
      consumed_at: null,
    });
  });

  it('returns only the caller identities with masked external email after corporate confirmation and revocation', async () => {
    const { app, env } = setup();
    await corporateSession(app, env);
    const begin = await request(
      app,
      env,
      CORPORATE_HOST,
      '/api/me/identities/link-transactions',
      'corporate',
      { method: 'POST', headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    const beginBody = await begin.json() as { data: { id: string; code: string } };
    await request(
      app,
      env,
      EXTERNAL_HOST,
      '/api/external/identity-presentations',
      'external',
      {
        method: 'POST',
        headers: { Origin: `https://${EXTERNAL_HOST}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: beginBody.data.code }),
      },
    );

    const confirmed = await request(
      app,
      env,
      CORPORATE_HOST,
      `/api/me/identities/link-transactions/${beginBody.data.id}/confirm`,
      'corporate',
      { method: 'POST', headers: { Origin: `https://${CORPORATE_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(confirmed.status).toBe(200);
    const confirmBody = await confirmed.json() as { data: { identities: Array<{ id: string; email_masked: string | null }> } };
    expect(JSON.stringify(confirmBody)).not.toContain(externalIdentity.email!);
    const linked = confirmBody.data.identities.find((identity) => identity.email_masked?.endsWith('@example.com'));
    expect(linked).toMatchObject({ email_masked: 'p******l@example.com' });

    const revoked = await request(
      app,
      env,
      CORPORATE_HOST,
      `/api/me/identities/${linked?.id}`,
      'corporate',
      { method: 'DELETE', headers: { Origin: `https://${CORPORATE_HOST}` } },
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      data: { identities: expect.arrayContaining([expect.objectContaining({ id: linked?.id, email_masked: 'p******l@example.com' })]) },
    });
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
      '/api/me/identities/link-transactions',
      'corporate',
      { method: 'POST', headers: { Origin: `https://${LEGACY_HOST}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(legacyWrite.status).toBe(410);
    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 0 });
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
      EXTERNAL_HOST,
      '/api/session',
      'corporate',
      { headers: { Host: CORPORATE_HOST } },
    );

    expect(response.status).toBe(401);
  });
});
