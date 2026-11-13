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
    user: { id: crypto.randomUUID(), name: 'OnePass fixture', email: 'fixture@lancloudtech.com', email_verified: true },
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
      expect(body.require_email).toBe(true);
      return Response.json(identity);
    }
    expect(input.pathname).toBe('/api/integrations/v1/session/check');
    expect(JSON.parse(String(init.body)).require_email).toBe(true);
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
  const { db, env, identity, req } = setup();
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
  identity.access_model = 'unlimited';
  identity.user.email_verified = false;
  expect((await req('/api/session', { headers })).status).toBe(401);
  identity.user.email_verified = true;
  identity.user.email = undefined;
  expect((await req('/api/session', { headers })).status).toBe(401);
  identity.user.email = 'member@external.example';
  expect((await req('/api/session', { headers })).status).toBe(200);
  env.ONEPASS_REQUIRED_EMAIL_DOMAIN = 'lancloudtech.com';
  expect((await req('/api/session', { headers })).status).toBe(401);
  identity.user.email = 'fixture@lancloudtech.com';
  expect((await req('/api/session', { headers })).status).toBe(200);
});

it('rejects non-corporate emails in production mode and uses OnePass email when local user email is null', async () => {
  const { db, env, identity, req } = setup();
  identity.access_model = 'unlimited';
  db.prepare('INSERT INTO onepass_org(org_id) VALUES(?)').run(org);
  db.prepare('INSERT INTO onepass_grants(membership_id,org_id,application_user_id,role,enabled,version,event_id) VALUES(?,?,?,?,1,1,?)')
    .run(membership, org, applicationUser, 'administrator', crypto.randomUUID());
  db.prepare('INSERT INTO onepass_local_accounts(org_id,membership_id,user_id) VALUES(?,?,?)').run(org, membership, localUser);
  const headers = { cookie: '__Host-onepass_session=' + identity.session_id };
  const session = await req('/api/session', { headers });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ data: { email: 'fixture@lancloudtech.com' } });

  env.ENVIRONMENT = 'production';
  env.ONEPASS_ENVIRONMENT = 'production';
  identity.user.email = 'member@external.example';
  expect((await req('/api/session', { headers })).status).toBe(401);
  identity.user.email = 'member@lancloudtech.com';
  expect((await req('/api/session', { headers })).status).toBe(200);
});

it('provisions only new verified members and never claims an existing Expense account', async () => {
  const { db, env, req } = setup();
  const scope = { product_code: env.ONEPASS_PRODUCT_CODE, org_id: org, environment: 'test', instance_id: instance };
  expect((await req(path, await signedEvent(env, { ...scope, protocol_version: 1, type: 'organization.provision', event_id: crypto.randomUUID() }))).status).toBe(200);
  const member = crypto.randomUUID(), appUser = crypto.randomUUID();
  const grant = { ...scope, protocol_version: 2, type: 'membership.set', event_id: crypto.randomUUID(),
    membership_id: member, application_user_id: appUser, role: 'member', enabled: true, version: 1,
    provisioning: { mode: 'new', verified_email: 'new@lancloudtech.com', name: 'New fixture' } };
  let response = await req(path, await signedEvent(env, grant));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: 'applied', local_account_ready: true });
  const mapping = db.prepare('SELECT user_id FROM onepass_local_accounts WHERE org_id=? AND membership_id=?').get(org, member) as { user_id: string };
  expect(db.prepare('SELECT email,display_name FROM users WHERE id=?').get(mapping.user_id)).toEqual({ email: 'new@lancloudtech.com', display_name: 'New fixture' });
  expect(db.prepare('SELECT role_id FROM user_roles WHERE user_id=?').all(mapping.user_id)).toEqual([{ role_id: 'role-employee' }]);
  expect((await req(path, await signedEvent(env, grant))).status).toBe(200);
  expect(db.prepare('SELECT count(*) AS count FROM users WHERE email=?').get('new@lancloudtech.com')).toEqual({ count: 1 });
  expect(db.prepare("SELECT count(*) AS count FROM audit_events WHERE action='onepass_create_user' AND entity_id=?").get(mapping.user_id)).toEqual({ count: 1 });

  db.prepare("INSERT INTO users(id,email,display_name) VALUES('existing','existing@lancloudtech.com','Existing')").run();
  const conflict = { ...grant, event_id: crypto.randomUUID(), membership_id: crypto.randomUUID(), application_user_id: crypto.randomUUID(),
    provisioning: { mode: 'new', verified_email: 'existing@lancloudtech.com', name: 'Conflict' } };
  response = await req(path, await signedEvent(env, conflict));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: 'ACCOUNT_LINK_REQUIRED' } });
  expect(db.prepare('SELECT count(*) AS count FROM onepass_local_accounts WHERE membership_id=?').get(conflict.membership_id)).toEqual({ count: 0 });
  expect(db.prepare('SELECT count(*) AS count FROM onepass_grants WHERE membership_id=?').get(conflict.membership_id)).toEqual({ count: 0 });
  const initialAdmin = { ...conflict, event_id: crypto.randomUUID(), role: 'administrator',
    provisioning: { mode: 'new', verified_email: 'admin@lancloudtech.com', name: 'Admin' } };
  expect((await req(path, await signedEvent(env, initialAdmin))).status).toBe(200);
  const adminMapping = db.prepare('SELECT user_id FROM onepass_local_accounts WHERE org_id=? AND membership_id=?').get(org,initialAdmin.membership_id) as { user_id: string };
  expect(db.prepare('SELECT role_id FROM user_roles WHERE user_id=?').all(adminMapping.user_id)).toEqual([{ role_id: 'role-employee' }]);
  expect((await req(path, await signedEvent(env, { ...grant, event_id: crypto.randomUUID(), version: 2, enabled: false, provisioning: undefined }))).status).toBe(200);
  expect(db.prepare('SELECT enabled FROM onepass_grants WHERE membership_id=?').get(member)).toEqual({ enabled: 0 });
  expect(db.prepare('SELECT employment_status FROM users WHERE id=?').get(mapping.user_id)).toEqual({ employment_status: 'active' });
});

it('rejects stale v2 provisioning and rolls back a failed local account transaction', async () => {
  const { db, env, req } = setup();
  const scope = { product_code: env.ONEPASS_PRODUCT_CODE, org_id: org, environment: 'test', instance_id: instance };
  expect((await req(path, await signedEvent(env, { ...scope, protocol_version: 1, type: 'organization.provision', event_id: crypto.randomUUID() }))).status).toBe(200);
  const member = crypto.randomUUID(), appUser = crypto.randomUUID();
  db.prepare("INSERT INTO onepass_grants(membership_id,org_id,application_user_id,role,enabled,version,event_id) VALUES(?,?,?,'member',0,5,?)").run(member, org, appUser, crypto.randomUUID());
  const event = { ...scope, protocol_version: 2, type: 'membership.set', event_id: crypto.randomUUID(),
    membership_id: member, application_user_id: appUser, role: 'member', enabled: true, version: 4,
    provisioning: { mode: 'new', verified_email: 'stale@lancloudtech.com', name: 'Fixture' } };
  expect((await req(path, await signedEvent(env, event))).status).toBe(403);
  expect(db.prepare('SELECT count(*) AS count FROM users WHERE email=?').get('stale@lancloudtech.com')).toEqual({ count: 0 });
  db.exec("CREATE TRIGGER fixture_fail_role BEFORE INSERT ON user_roles BEGIN SELECT RAISE(ABORT,'injected'); END");
  const failed = { ...event, membership_id: crypto.randomUUID(), application_user_id: crypto.randomUUID(), event_id: crypto.randomUUID(),
    provisioning: { mode: 'new', verified_email: 'failure@lancloudtech.com', name: 'Fixture' } };
  expect((await req(path, await signedEvent(env, failed))).status).toBe(503);
  expect(db.prepare('SELECT count(*) AS count FROM users WHERE email=?').get('failure@lancloudtech.com')).toEqual({ count: 0 });
  expect(db.prepare('SELECT count(*) AS count FROM onepass_receipts WHERE event_id=?').get(failed.event_id)).toEqual({ count: 0 });
});

it('never accepts Cloudflare identity as a production login, even with stale or missing OnePass settings', async () => {
  const {db, env, identity} = setup();
  env.ENVIRONMENT = 'production';
  env.ONEPASS_LOGIN_MODE = 'access';
  env.ACCESS_AUD_CORPORATE = 'fixture-access-audience';
  const cloudflareResolver = vi.fn(async () => ({issuer:'https://fixture.cloudflareaccess.com', subject:'fixture-access', email:'fixture@lancloudtech.com'}));
  const app = createApp({resolveIdentity: cloudflareResolver});
  const spoofed = {headers:{'Cf-Access-Jwt-Assertion':'forged-token','x-dev-subject':'fixture-access'}};
  expect((await app.request(expense+'/api/session',spoofed,env)).status).toBe(401);
  expect((await app.request(expense+'/',spoofed,env)).status).toBe(401);
  expect(await (await app.request(expense+'/',spoofed,env)).text()).toContain('使用 OnePass 登录');
  expect(cloudflareResolver).not.toHaveBeenCalled();
  env.ONEPASS_ENABLED = '0';
  expect((await app.request(expense+'/api/session',spoofed,env)).status).toBe(401);
  expect(cloudflareResolver).not.toHaveBeenCalled();
  env.ONEPASS_ENABLED = '1';
  identity.access_model = 'unlimited';
  db.prepare('INSERT INTO onepass_org(org_id) VALUES(?)').run(org);
  db.prepare('INSERT INTO onepass_grants(membership_id,org_id,application_user_id,role,enabled,version,event_id) VALUES(?,?,?,?,1,1,?)')
    .run(membership,org,applicationUser,'administrator',crypto.randomUUID());
  db.prepare('INSERT INTO onepass_local_accounts(org_id,membership_id,user_id) VALUES(?,?,?)').run(org,membership,localUser);
  const validOnePass = {headers:{cookie:'__Host-onepass_session='+identity.session_id, 'Cf-Access-Jwt-Assertion':'forged-token'}};
  expect((await app.request(expense+'/api/session',validOnePass,env)).status).toBe(200);
  expect(cloudflareResolver).not.toHaveBeenCalled();
  expect((await app.request(expense+path,{method:'POST',body:'{}'},env)).status).toBe(403);
});

it('keeps the legacy host as a safe redirect without requiring Cloudflare settings', async () => {
  const {env} = setup();
  env.ENVIRONMENT = 'production';
  env.ONEPASS_ENABLED = '0';
  env.ONEPASS_LOGIN_MODE = 'access';
  env.ACCESS_AUD_CORPORATE = undefined;
  const app = createApp();
  const oldHost = 'https://ie_oa.lancloudtech.com';
  const redirect = await app.request(oldHost+'/profile', {redirect:'manual'}, env);
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get('location')).toBe(expense+'/profile');
  expect((await app.request(oldHost+'/api/session',{method:'POST'},env)).status).toBe(410);
  expect((await app.request(expense+'/logout',{redirect:'manual'},env)).headers.get('location')).toBe('/profile');
});

it('does not enable Cloudflare or dev-header login in the deployed app even if marked as test', async () => {
  const {env} = setup();
  env.ENVIRONMENT = 'test';
  env.ONEPASS_LOGIN_MODE = 'access';
  env.ONEPASS_ENABLED = '0';
  env.DEV_AUTH = '1';
  env.ACCESS_AUD_CORPORATE = 'fixture-audience';
  const app = createApp();
  expect((await app.request(expense+'/api/session',{headers:{'x-dev-subject':'fixture','x-dev-email':'fixture@lancloudtech.com','Cf-Access-Jwt-Assertion':'forged'}},env)).status).toBe(401);
});


it('retires obsolete Access whitelist endpoints in OnePass mode without altering stored rules', async () => {
  const {db, env, identity, req} = setup();
  identity.access_model='unlimited';
  db.prepare('INSERT INTO onepass_org(org_id) VALUES(?)').run(org);
  db.prepare('INSERT INTO onepass_grants(membership_id,org_id,application_user_id,role,enabled,version,event_id) VALUES(?,?,?,?,1,1,?)')
    .run(membership,org,applicationUser,'administrator',crypto.randomUUID());
  db.prepare('INSERT INTO onepass_local_accounts(org_id,membership_id,user_id) VALUES(?,?,?)').run(org,membership,localUser);
  db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,'role-system-admin')").run(localUser);
  const headers={cookie:'__Host-onepass_session='+identity.session_id,origin:expense,'content-type':'application/json'};
  const before=db.prepare('SELECT count(*) AS count FROM login_whitelist').get();
  expect((await req('/api/login-whitelist',{headers})).status).toBe(410);
  expect((await req('/api/login-whitelist',{method:'POST',headers,body:JSON.stringify({kind:'domain',value:'sample.test'})})).status).toBe(410);
  expect((await req('/api/login-whitelist/fixture',{method:'DELETE',headers})).status).toBe(410);
  expect(db.prepare('SELECT count(*) AS count FROM login_whitelist').get()).toEqual(before);
});

it('freezes local member management during migration and enforces signed roles after cutover', async () => {
  const { db, env, identity, req } = setup();
  identity.access_model = 'unlimited';
  const scope = { product_code: env.ONEPASS_PRODUCT_CODE, org_id: org, environment: 'test', instance_id: instance, protocol_version: 1 };
  const grant = { ...scope, type: 'membership.set', membership_id: membership, application_user_id: applicationUser,
    role: 'administrator', enabled: true, version: 1, event_id: crypto.randomUUID() };
  const deliver = async (event: object) => req(path, await signedEvent(env, event));
  const headers = { cookie: '__Host-onepass_session=' + identity.session_id, origin: expense };
  expect((await deliver({ ...scope, type: 'organization.provision', event_id: crypto.randomUUID() })).status).toBe(200);
  expect((await deliver(grant)).status).toBe(200);
  db.prepare('INSERT INTO onepass_local_accounts(org_id,membership_id,user_id) VALUES(?,?,?)').run(org, membership, localUser);
  db.prepare("INSERT INTO user_roles(user_id,role_id) VALUES(?,'role-system-admin')").run(localUser);
  db.prepare("INSERT INTO users(id,display_name,employment_status) VALUES('historical','Historical','inactive')").run();

  env.ONEPASS_MANAGED_MEMBER_ROLES = 'staging';
  expect((await req('/api/finance/overview', { headers })).status).toBe(200);
  expect(await (await req('/profile', { headers })).text()).not.toContain('前往 OnePass 管理成员');
  for (const [method, api] of [
    ['GET', '/api/users'], ['POST', '/api/users'], ['PUT', '/api/users/expense-local'],
    ['PUT', '/api/users/expense-local/roles'], ['GET', '/api/roles'], ['POST', '/api/login-whitelist'],
  ]) expect((await req(api!, { method, headers })).status).toBe(410);
  const people = await req('/people', { headers, redirect: 'manual' });
  expect(people.status).toBe(303);
  expect(people.headers.get('location')).toBe(`${center}/products/expense-fixture/environments/test/members?org=${org}`);
  expect(await (await req('/api/account-owners?active=1', { headers })).json()).toEqual({
    data: [{ id: localUser, display_name: 'Expense fixture' }],
  });

  env.ONEPASS_MANAGED_MEMBER_ROLES = '1';
  expect((await req('/api/session', { headers })).status).toBe(401);
  identity.membership.application_roles = ['finance_reviewer', 'employee'];
  expect((await req('/api/session', { headers })).status).toBe(401);
  const imported = { ...grant, version: 2, event_id: crypto.randomUUID(), application_roles: ['employee', 'finance_reviewer'] };
  const receipt = await deliver(imported);
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toMatchObject({ application_roles: imported.application_roles });
  expect((await deliver(imported)).status).toBe(200);
  expect((await req('/api/finance/overview', { headers })).status).toBe(200);
  expect(await (await req('/api/session', { headers })).json()).toMatchObject({
    data: { user_id: localUser, roles: ['employee', 'finance_reviewer'] },
  });
  expect(await (await req('/api/reimbursements/reviewers', { headers })).json()).toMatchObject({ data: [{ id: localUser }] });

  const revoked = { ...imported, version: 3, event_id: crypto.randomUUID(), application_roles: ['employee'] };
  expect((await deliver({ ...revoked, application_roles: ['unknown'] })).status).toBe(403);
  expect((await deliver({ ...revoked, application_roles: ['employee', 'employee'] })).status).toBe(403);
  expect((await deliver({ ...revoked, application_roles: undefined })).status).toBe(403);
  expect((await deliver(revoked)).status).toBe(200);
  expect((await deliver(imported)).status).toBe(403);
  expect((await req('/api/session', { headers })).status).toBe(401);
  identity.membership.application_roles = ['employee'];
  identity.membership.org_role = 'org_admin';
  expect((await req('/api/finance/overview', { headers })).status).toBe(403);
  expect(await (await req('/profile', { headers })).text()).toContain('前往 OnePass 管理成员');
  expect(await (await req('/api/reimbursements/reviewers', { headers })).json()).toEqual({ data: [] });
  expect(db.prepare("SELECT role_id FROM user_roles WHERE user_id=? AND role_id='role-system-admin'").get(localUser)).toBeTruthy();

  const empty = await deliver({ ...revoked, event_id: crypto.randomUUID(), version: 4, application_roles: [] });
  expect(await empty.json()).toMatchObject({ application_roles: [] });
  identity.membership.application_roles = [];
  expect(await (await req('/api/session', { headers })).json()).toMatchObject({ data: { roles: [] } });
  expect((await req('/api/dashboard', { headers })).status).toBe(403);
});

it('accepts central v2 roles for new accounts and requires an explicit mapping for existing accounts', async () => {
  const { db, env, req } = setup();
  env.ONEPASS_MANAGED_MEMBER_ROLES = '1';
  const scope = { product_code: env.ONEPASS_PRODUCT_CODE, org_id: org, environment: 'test', instance_id: instance };
  const deliver = async (event: object) => req(path, await signedEvent(env, event));
  expect((await deliver({ ...scope, type: 'organization.provision', protocol_version: 1, event_id: crypto.randomUUID() })).status).toBe(200);
  const grant = { ...scope, type: 'membership.set', membership_id: membership, application_user_id: applicationUser,
    role: 'member', enabled: true, version: 1, event_id: crypto.randomUUID(), application_roles: ['employee'] };
  const noMapping = await deliver({ ...grant, protocol_version: 1 });
  expect(noMapping.status).toBe(409);
  expect(await noMapping.json()).toMatchObject({ error: { code: 'ACCOUNT_LINK_REQUIRED' } });
  const provisioned = await deliver({ ...grant, event_id: crypto.randomUUID(), protocol_version: 2,
    provisioning: { mode: 'new', verified_email: 'managed@lancloudtech.com', name: 'Managed fixture' } });
  expect(provisioned.status).toBe(200);
  expect(await provisioned.json()).toMatchObject({ local_account_ready: true, application_roles: ['employee'] });
  expect(db.prepare('SELECT application_roles_json FROM onepass_grants WHERE membership_id=?').get(membership))
    .toEqual({ application_roles_json: '["employee"]' });
  expect(db.prepare(`SELECT count(*) AS count FROM user_roles r JOIN onepass_local_accounts a ON a.user_id=r.user_id`).get())
    .toEqual({ count: 0 });
});
