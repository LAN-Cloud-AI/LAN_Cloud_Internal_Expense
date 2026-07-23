import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityStore } from '../src/lib/identity-store';
import type { AuthenticatedIdentity } from '../src/lib/auth';
import { sqliteD1 } from './helpers/sqlite-d1';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const databases: Database.Database[] = [];
const corporateIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'corporate-subject',
  email: 'person@lancloudtech.com',
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
  return { database, store: new IdentityStore(sqliteD1(database)) };
}

/** Ensures two callers have both completed their preflight reads before either batch mutates state. */
function synchronizeNextBatches(db: D1Database): D1Database {
  let matchingBatches = 0;
  let releaseFirst: (() => void) | undefined;
  return {
    prepare: db.prepare.bind(db),
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      matchingBatches += 1;
      if (matchingBatches === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      } else {
        releaseFirst?.();
      }
      return db.batch<T>(statements);
    },
  } as D1Database;
}

/**
 * Cloudflare documents D1 metadata changes as a rough indication, not an
 * authorization primitive. This adapter deliberately lies to ensure callers
 * prove mutations from result rows rather than `meta.changes`.
 */
function withUnreliableChangeMetadata(db: D1Database): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const forge = <T>(result: D1Result<T>): D1Result<T> => ({
    ...result,
    meta: {
      ...result.meta,
      changes: 1,
      rows_written: 1,
      changed_db: true,
    },
  });

  const wrap = (prepared: D1PreparedStatement): D1PreparedStatement => {
    let bound = prepared;
    const wrapper = {
      bind(...values: unknown[]) {
        bound = prepared.bind(...values);
        originals.set(wrapper, bound);
        return wrapper;
      },
      async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
        return columnName === undefined ? bound.first<T>() : bound.first<T>(columnName);
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return forge(await bound.all<T>());
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return forge(await bound.run<T>());
      },
      raw<T = unknown[]>(options?: { columnNames?: boolean }) {
        return options === undefined ? bound.raw<T>() : bound.raw<T>(options as { columnNames: true });
      },
    };
    originals.set(wrapper, prepared);
    return wrapper as unknown as D1PreparedStatement;
  };

  return {
    prepare(query: string) {
      return wrap(db.prepare(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const underlying = statements.map((statement) => originals.get(statement as object) ?? statement);
      return (await db.batch<T>(underlying)).map(forge);
    },
  } as D1Database;
}

function settledCounts(results: PromiseSettledResult<unknown>[]) {
  return {
    fulfilled: results.filter((result) => result.status === 'fulfilled'),
    rejected: results.filter((result) => result.status === 'rejected'),
  };
}

function roleCodesFor(database: Database.Database, userId: string): string[] {
  return (database.prepare(
    `SELECT r.code FROM user_roles AS ur JOIN roles AS r ON r.id = ur.role_id
     WHERE ur.user_id = ? ORDER BY r.code`,
  ).all(userId) as Array<{ code: string }>).map((row) => row.code);
}

describe('IdentityStore corporate provisioning', () => {
  it('provisions a corporate principal idempotently with the employee role', async () => {
    const { database, store } = setup();
    await store.ensureCorporatePrincipal(corporateIdentity, { migrationAdminEmail: undefined });
    await store.ensureCorporatePrincipal(corporateIdentity, { migrationAdminEmail: undefined });

    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 1 });
    const user = database.prepare('SELECT id FROM users').get() as { id: string };
    expect(roleCodesFor(database, user.id)).toEqual(['employee']);
  });

  it('requires a well-formed verified email and a login-whitelist match', async () => {
    const { store, database } = setup();
    await expect(store.ensureCorporatePrincipal(
      { ...corporateIdentity, email: 'not-an-email' },
      {},
    )).rejects.toMatchObject({ code: 'corporate_email_required' });
    // 域名不在白名单中的合法邮箱：不允许自动开户。
    await expect(store.ensureCorporatePrincipal(
      { ...corporateIdentity, email: 'x@example.com' },
      {},
    )).rejects.toMatchObject({ code: 'email_not_whitelisted' });
    // 精确邮箱加入白名单后即可开户。
    database.prepare(`INSERT INTO login_whitelist (id, kind, value) VALUES ('wl-x', 'email', 'x@example.com')`).run();
    const principal = await store.ensureCorporatePrincipal({ ...corporateIdentity, email: 'x@example.com' }, {});
    expect(principal.identityKind).toBe('corporate_primary');
  });

  it('stores the verified OTP email on the user row and identity when auto-provisioning', async () => {
    const { store, database } = setup();

    const principal = await store.ensureCorporatePrincipal(
      { issuer: 'https://team.cloudflareaccess.com', subject: 'new-subject', email: 'newbie@lancloudtech.com' },
      {},
    );

    expect(database.prepare(`SELECT email FROM users WHERE id = ?`).get(principal.userId)).toMatchObject({ email: 'newbie@lancloudtech.com' });
    expect(database.prepare(
      `SELECT verified_email FROM user_access_identities WHERE user_id = ?`,
    ).get(principal.userId)).toMatchObject({ verified_email: 'newbie@lancloudtech.com' });
  });

  it('keeps the email column empty when it is already taken instead of merging accounts', async () => {
    const { store, database } = setup();
    database.prepare(
      `INSERT INTO users (id, email, display_name) VALUES ('taken-user', 'taken@lancloudtech.com', '在先用户')`,
    ).run();
    database.prepare(
      `INSERT INTO user_access_identities (id, user_id, issuer, subject, identity_kind)
       VALUES ('taken-identity', 'taken-user', 'https://team.cloudflareaccess.com', 'taken-subject', 'corporate_primary')`,
    ).run();

    const principal = await store.ensureCorporatePrincipal(
      { issuer: 'https://team.cloudflareaccess.com', subject: 'different-subject', email: 'taken@lancloudtech.com' },
      {},
    );

    expect(principal.userId).not.toBe('taken-user');
    expect(database.prepare(`SELECT email FROM users WHERE id = ?`).get(principal.userId)).toMatchObject({ email: null });
    expect(database.prepare(`SELECT verified_email FROM user_access_identities WHERE user_id = ?`).get(principal.userId))
      .toMatchObject({ verified_email: 'taken@lancloudtech.com' });
  });

  it('adopts an admin-provisioned user row on first OTP login instead of duplicating the account', async () => {
    const { store, database } = setup();
    database.prepare(
      `INSERT INTO users (id, email, display_name) VALUES ('provisioned-lance', 'lance@lancloudtech.com', 'Lance')`,
    ).run();

    const principal = await store.ensureCorporatePrincipal(
      { issuer: 'https://team.cloudflareaccess.com', subject: 'lance-subject', email: 'lance@lancloudtech.com' },
      {},
    );

    expect(principal.userId).toBe('provisioned-lance');
    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 1 });
    expect(database.prepare(
      `SELECT identity_kind FROM user_access_identities WHERE user_id = 'provisioned-lance' AND subject = 'lance-subject'`,
    ).get()).toMatchObject({ identity_kind: 'corporate_primary' });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'adopt_provisioned_user'`,
    ).get()).toMatchObject({ count: 1 });

    const again = await store.ensureCorporatePrincipal(
      { issuer: 'https://team.cloudflareaccess.com', subject: 'lance-subject', email: 'lance@lancloudtech.com' },
      {},
    );
    expect(again.userId).toBe('provisioned-lance');
    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 1 });
  });

  it('does not join a different subject merely because its email matches', async () => {
    const { store } = setup();
    const principal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    expect(await store.resolve(
      { ...corporateIdentity, subject: 'different-subject' },
      'corporate',
    )).toBeNull();
    expect(principal.userId).toBeTruthy();
  });

  it('upgrades only a legacy record with the same subject after corporate validation', async () => {
    const { database, store } = setup();
    database.prepare(
      `INSERT INTO users (id, external_subject, display_name) VALUES ('legacy-user', 'legacy-subject', 'Legacy')`,
    ).run();
    database.prepare(
      `INSERT INTO user_access_identities (id, user_id, issuer, subject, identity_kind)
       VALUES ('legacy-identity', 'legacy-user', 'legacy://users.external_subject', 'legacy-subject', 'legacy_primary')`,
    ).run();

    const upgraded = await store.ensureCorporatePrincipal(
      { ...corporateIdentity, subject: 'legacy-subject' },
      {},
    );
    expect(upgraded).toMatchObject({ userId: 'legacy-user', identityKind: 'corporate_primary' });
    expect(database.prepare('SELECT count(*) AS count FROM users').get()).toMatchObject({ count: 1 });
  });

  it('returns only the signed winner when concurrent issuers race to upgrade one legacy subject', async () => {
    const database = createDatabase();
    const store = new IdentityStore(withUnreliableChangeMetadata(sqliteD1(database)));
    database.prepare(
      `INSERT INTO users (id, external_subject, display_name) VALUES ('legacy-user', 'legacy-subject', 'Legacy')`,
    ).run();
    database.prepare(
      `INSERT INTO user_access_identities (id, user_id, issuer, subject, identity_kind)
       VALUES ('legacy-identity', 'legacy-user', 'legacy://users.external_subject', 'legacy-subject', 'legacy_primary')`,
    ).run();

    const firstIdentity = {
      ...corporateIdentity,
      issuer: 'https://first.cloudflareaccess.com',
      subject: 'legacy-subject',
    };
    const secondIdentity = {
      ...corporateIdentity,
      issuer: 'https://second.cloudflareaccess.com',
      subject: 'legacy-subject',
    };
    const results = await Promise.allSettled([
      store.ensureCorporatePrincipal(firstIdentity, {}),
      store.ensureCorporatePrincipal(secondIdentity, {}),
    ]);
    const { fulfilled, rejected } = settledCounts(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.ensureCorporatePrincipal>>>).value;
    expect([firstIdentity.issuer, secondIdentity.issuer]).toContain(winner.issuer);
    expect(winner.subject).toBe('legacy-subject');
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'identity_kind_conflict' });
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'upgrade_legacy_corporate_identity'",
    ).get()).toMatchObject({ count: 1 });
  });

  it('runs the migration administrator grant once globally and audits it', async () => {
    const { database, store } = setup();
    const first = await store.ensureCorporatePrincipal(corporateIdentity, {
      migrationAdminEmail: 'PERSON@LANCLOUDTECH.COM',
    });
    const second = await store.ensureCorporatePrincipal(
      { ...corporateIdentity, subject: 'another-corporate-subject', email: 'person@lancloudtech.com' },
      { migrationAdminEmail: 'person@lancloudtech.com' },
    );

    expect(roleCodesFor(database, first.userId)).toEqual(['employee', 'system_admin']);
    expect(roleCodesFor(database, second.userId)).toEqual(['employee']);
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'migrate_system_administrator'",
    ).get()).toMatchObject({ count: 1 });
  });
});
