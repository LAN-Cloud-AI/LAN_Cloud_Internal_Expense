import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import type { OnePassIdentity } from '../src/lib/onepass';
import type { Env } from '../src/lib/types';
import { sqliteD1 } from './helpers/sqlite-d1';

const expense = 'https://ie-oa.lancloudtech.com';
const center = 'https://onepass.example.test';
const delivery = new Uint8Array(32).fill(13);
const org = 'org_synthetic_expense';
const instance = crypto.randomUUID();
const membership = crypto.randomUUID();
const applicationUser = crypto.randomUUID();
const localUser = 'expense-local';
const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const encoder = new TextEncoder();
const path = '/api/internal/onepass/events';
const bytesHex = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('hex');
const testDatabases: Database.Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of testDatabases.splice(0)) db.close();
});

function setup() {
  const db = new Database(':memory:');
  testDatabases.push(db);
  db.pragma('foreign_keys = ON');
  for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrations, file), 'utf8'));
  }
  db.prepare("INSERT INTO users(id,display_name,employment_status) VALUES(?,'Expense fixture','active')").run(localUser);
  db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,'role-employee')").run(localUser);
  const env: Env = {
    DB: sqliteD1(db),
    ENVIRONMENT: 'test',
    ONEPASS_ENABLED: '1',
    ONEPASS_ORIGIN: center,
    ONEPASS_CLIENT_ID: 'expense-fixture',
    ONEPASS_CLIENT_SECRET: 'b'.repeat(43),
    ONEPASS_REDIRECT_URI: expense + '/auth/onepass/callback',
    ONEPASS_PRODUCT_CODE: 'expense-fixture',
    ONEPASS_ENVIRONMENT: 'test',
    ONEPASS_INSTANCE_ID: instance,
    ONEPASS_ORG_ID: org,
    ONEPASS_DELIVERY_KEY_ID: 'fixture-key',
    ONEPASS_DELIVERY_SECRET: Buffer.from(delivery).toString('base64'),
  };
  const identity: OnePassIdentity = {
    active: true,
    session_id: crypto.randomUUID(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    application_user_id: applicationUser,
    user: { id: crypto.randomUUID(), name: 'OnePass fixture' },
    membership: { id: membership, org_id: org, role: 'administrator' },
  };
  let revoked = false;
  vi.stubGlobal('fetch', async (input: URL, init: RequestInit) => {
    expect(input.origin).toBe(center);
    expect(new Headers(init.headers).has('authorization')).toBe(true);
    if (input.pathname.endsWith('/revoke')) {
      revoked = true;
      return Response.json({ ok: true });
    }
    if (input.pathname.endsWith('/exchange')) {
      const body = JSON.parse(String(init.body));
      expect(body.redirect_uri).toBe(env.ONEPASS_REDIRECT_URI);
      expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return Response.json(identity);
    }
    expect(input.pathname).toBe('/api/integrations/v1/session/check');
    return Response.json(revoked ? { active: false } : identity);
  });
  const app = createApp({ resolveIdentity: async () => { throw new Error('enabled mode must use OnePass'); } });
  const req = (pathname: string, init: RequestInit = {}) => app.request(expense + pathname, init, env);
  return { db, env, identity, req };
}

async function signedEvent(env: Env, event: object, entitlement = false): Promise<RequestInit> {
  const body = JSON.stringify(event);
  const hash = bytesHex(await crypto.subtle.digest('SHA-256', encoder.encode(body)));
  const ts = String(Math.floor(Date.now() / 1_000));
  const nonce = crypto.randomUUID();
  const prefix = entitlement ? 'x-lh-subscription-' : 'x-onepass-';
  const canonical = [entitlement ? 'LH-SUBSCRIPTION-SYNC-V1' : 'ONEPASS-INTEGRATION-V1',
    env.ONEPASS_DELIVERY_KEY_ID, ts, nonce, 'POST', path, hash].join('\n');
  const key = await crypto.subtle.importKey('raw', delivery, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = bytesHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));
  return { method: 'POST', body, headers: {
    [prefix + 'key-id']: env.ONEPASS_DELIVERY_KEY_ID!, [prefix + 'timestamp']: ts, [prefix + 'nonce']: nonce,
    [prefix + 'signature']: 'v1=' + signature, 'content-type': 'application/json',
  } };
}

it('stages the signed receiver while keeping corporate Access login and local authorization', async () => {
  const { db, env } = setup();
  env.ONEPASS_LOGIN_MODE = 'access';
  env.ACCESS_AUD_CORPORATE = 'fixture-corporate';
  const app = createApp({
    resolveIdentity: async (request) => request.headers.has('x-test-access')
      ? { issuer: 'https://fixture.cloudflareaccess.com', subject: 'access-fixture', email: 'fixture@lancloudtech.com' }
      : null,
  });
  const req = (pathname: string, init: RequestInit = {}) => app.request(expense + pathname, init, env);
  const event = { event_id: crypto.randomUUID(), type: 'probe', product_code: env.ONEPASS_PRODUCT_CODE,
    environment: env.ONEPASS_ENVIRONMENT, instance_id: env.ONEPASS_INSTANCE_ID, protocol_version: 1 };
  expect((await req(path, { method: 'POST', body: '{}' })).status).toBe(403);
  const delivery = await req(path, await signedEvent(env, event));
  expect(delivery.status).toBe(200);
  expect(await delivery.json()).toEqual({ event_id: event.event_id, result: 'applied' });
  const anonymous = await req('/');
  expect(anonymous.status).toBe(401);
  expect(await anonymous.text()).toContain('需要企业邮箱登录');
  const signedIn = { headers: { 'x-test-access': '1' } };
  expect((await req('/auth/onepass', signedIn)).status).toBe(404);
  const session = await req('/api/session', signedIn);
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ data: { roles: ['employee'] } });
  expect(db.prepare('SELECT count(*) AS count FROM onepass_local_accounts').get()).toEqual({ count: 0 });

  env.ONEPASS_LOGIN_MODE = 'onepass';
  expect((await req('/api/session', signedIn)).status).toBe(401);
  expect((await req('/auth/onepass')).status).toBe(303);
});

it('validates signed organization, entitlement and member events before linking an existing Expense account', async () => {
  const { db, env, req } = setup();
  expect(await (await req('/')).text()).toContain('使用 OnePass 登录');
  const scope = { product_code: env.ONEPASS_PRODUCT_CODE, org_id: org, environment: 'test', instance_id: instance, protocol_version: 1 };
  expect((await req(path, await signedEvent(env, { ...scope, type: 'organization.provision', event_id: crypto.randomUUID() }))).status).toBe(200);
  expect((await req(path, await signedEvent(env, { ...scope, type: 'membership.set', event_id: crypto.randomUUID(), org_id: 'org_other',
    membership_id: membership, application_user_id: applicationUser, role: 'administrator', enabled: true, version: 1 }))).status).toBe(403);
  const grant = { ...scope, type: 'membership.set', event_id: crypto.randomUUID(), membership_id: membership,
    application_user_id: applicationUser, role: 'administrator', enabled: true, version: 1 };
  expect((await req(path, await signedEvent(env, grant))).status).toBe(200);
  expect((await req(path, await signedEvent(env, grant))).status).toBe(200);
  expect((await req(path, await signedEvent(env, { product_code: env.ONEPASS_PRODUCT_CODE, event_id: crypto.randomUUID(), protocol_version: 2,
    source: { issuer: 'onepass-subscriptions', environment: 'test' }, audience: { environment: 'test', instance_id: instance },
    subject: { org_id: org }, entitlement_version: 1, status: 'active', period_end: new Date(Date.now() + 86_400_000).toISOString(),
  }, true))).status).toBe(200);
  const start = await req('/auth/onepass');
  expect(start.status).toBe(303);
  const auth = new URL(start.headers.get('location')!);
  expect(auth.origin).toBe(center);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  const transaction = start.headers.get('set-cookie')!.split(';', 1)[0]!;
  const callback = await req('/auth/onepass/callback?' + new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'a'.repeat(43) }), { headers: { cookie: transaction } });
  expect(callback.status).toBe(303);
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-onepass_session='))!.split(';', 1)[0]!;
  expect((await req('/api/session', { headers: { cookie } })).status).toBe(403);
  expect(db.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 });

  db.prepare('INSERT INTO onepass_local_accounts(org_id,membership_id,user_id) VALUES(?,?,?)').run(org, membership, localUser);
  const session = await req('/api/session', { headers: { cookie } });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ data: { user_id: localUser, roles: ['employee'] } });
  expect((await req('/api/finance/overview', { headers: { cookie } })).status).toBe(403);
  db.prepare('UPDATE onepass_local_accounts SET enabled=0 WHERE user_id=?').run(localUser);
  expect((await req('/api/session', { headers: { cookie } })).status).toBe(403);
  db.prepare('UPDATE onepass_local_accounts SET enabled=1 WHERE user_id=?').run(localUser);
  expect((await req('/auth/onepass/logout', { method: 'POST', headers: { cookie, origin: expense } })).status).toBe(303);
  expect((await req('/api/session', { headers: { cookie } })).status).toBe(401);
});

it('uses live OnePass unlimited mode without a billing entitlement while retaining organization and member checks', async () => {
  const { db, identity, req } = setup();
  db.prepare('INSERT INTO onepass_org(org_id) VALUES(?)').run(org);
  db.prepare('INSERT INTO onepass_grants(membership_id,org_id,application_user_id,role,enabled,version,event_id) VALUES(?,?,?,?,1,1,?)')
    .run(membership, org, applicationUser, 'administrator', crypto.randomUUID());
  db.prepare('INSERT INTO onepass_local_accounts(org_id,membership_id,user_id) VALUES(?,?,?)').run(org, membership, localUser);
  const headers = { cookie: '__Host-onepass_session=' + identity.session_id };
  expect((await req('/api/session', { headers })).status).toBe(401); // legacy response requires entitlement
  identity.access_model = 'unlimited';
  expect((await req('/api/session', { headers })).status).toBe(200);
  expect((await req('/api/finance/overview', { headers })).status).toBe(403); // local business roles remain independent
  db.prepare('UPDATE onepass_grants SET enabled=0 WHERE membership_id=?').run(membership);
  expect((await req('/api/session', { headers })).status).toBe(401);
  db.prepare('UPDATE onepass_grants SET enabled=1 WHERE membership_id=?').run(membership);
  identity.membership.org_id = 'other_org';
  expect((await req('/api/session', { headers })).status).toBe(401);
  identity.membership.org_id = org;
  (identity as unknown as { access_model: string }).access_model = 'invalid';
  expect((await req('/api/session', { headers })).status).toBe(401);
});
