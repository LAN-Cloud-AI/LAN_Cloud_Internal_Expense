import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityStore } from '../src/lib/identity-store';
import type { AuthenticatedIdentity } from '../src/lib/auth';
import { sqliteD1, withD1StatementFailure } from './helpers/sqlite-d1';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const databases: Database.Database[] = [];
const corporateIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'corporate-subject',
  email: 'person@lancloudtech.com',
};
const externalIdentity: AuthenticatedIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'github-subject',
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
  return { database, store: new IdentityStore(sqliteD1(database)) };
}

/**
 * Holds the first two candidate-presentation batches at their mutation
 * boundary. Each caller reaches `batch()` only after its secret and identity
 * preflight reads, so releasing the pair exercises the real compare-and-set
 * race rather than a stale prepared-statement shim.
 */
function synchronizePresentationBatches(db: D1Database) {
  const statementQueries = new WeakMap<object, string>();
  let presentationBatchArrivals = 0;
  let releaseFirst: (() => void) | undefined;
  const database = {
    prepare(query: string) {
      const prepared = db.prepare(query);
      statementQueries.set(prepared as object, query);
      return prepared;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const isCandidatePresentation = statements.some((statement) => {
        const query = statementQueries.get(statement as object);
        return query !== undefined
          && query.includes('UPDATE identity_link_transactions')
          && query.includes('candidate_issuer = ?')
          && query.includes("status = 'candidate_presented'");
      });
      if (isCandidatePresentation) {
        presentationBatchArrivals += 1;
        if (presentationBatchArrivals === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        } else if (presentationBatchArrivals === 2) {
          releaseFirst?.();
        }
      }
      return db.batch<T>(statements);
    },
  } as D1Database;
  return {
    database,
    presentationBatchArrivals: () => presentationBatchArrivals,
  };
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

  it('requires an exact verified corporate email', async () => {
    const { store } = setup();
    await expect(store.ensureCorporatePrincipal(
      { ...corporateIdentity, email: 'x@lancloudtech.com.evil' },
      {},
    )).rejects.toMatchObject({ code: 'corporate_email_required' });
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

describe('IdentityStore external linking', () => {
  it('audits link initiation and candidate presentation without storing a raw code or external email in audit detail', async () => {
    const { database, store } = setup();
    const principal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const link = await store.beginLinkTransaction(principal, now);
    await store.presentExternalIdentity(externalIdentity, link.secret, 'github', now);

    const audits = database.prepare(
      `SELECT action, detail_json FROM audit_events
       WHERE action IN ('begin_linked_external_identity', 'present_linked_external_identity_candidate')
       ORDER BY action`,
    ).all() as Array<{ action: string; detail_json: string }>;

    expect(audits.map((audit) => audit.action)).toEqual([
      'begin_linked_external_identity',
      'present_linked_external_identity_candidate',
    ]);
    expect(JSON.stringify(audits)).not.toContain(link.secret);
    expect(JSON.stringify(audits)).not.toContain(externalIdentity.email!);
  });

  it('rolls a candidate presentation back when its audit write fails', async () => {
    const database = createDatabase();
    const store = new IdentityStore(withD1StatementFailure(
      sqliteD1(database),
      (query) => query.includes("'present_linked_external_identity_candidate'"),
    ));
    const principal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const link = await store.beginLinkTransaction(principal, now);

    await expect(store.presentExternalIdentity(externalIdentity, link.secret, 'github', now))
      .rejects.toMatchObject({ code: 'identity_store_unavailable' });

    expect(database.prepare(
      `SELECT status, candidate_issuer, candidate_subject, candidate_verified_email,
              candidate_provider_hint, consumed_at
       FROM identity_link_transactions WHERE id = ?`,
    ).get(link.id)).toEqual({
      status: 'pending',
      candidate_issuer: null,
      candidate_subject: null,
      candidate_verified_email: null,
      candidate_provider_hint: null,
      consumed_at: null,
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'present_linked_external_identity_candidate'",
    ).get()).toMatchObject({ count: 0 });
  });

  it('keeps a candidate identity in the transaction until its corporate owner confirms it', async () => {
    const { database, store } = setup();
    const corporatePrincipal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const link = await store.beginLinkTransaction(corporatePrincipal, now);
    await store.presentExternalIdentity(externalIdentity, link.secret, 'github', now);
    expect(database.prepare('SELECT count(*) AS count FROM user_access_identities').get())
      .toMatchObject({ count: 1 });
    await expect(store.confirmLinkTransaction(corporatePrincipal, link.id, now))
      .resolves.toMatchObject({ identityKind: 'linked_external' });
    await expect(store.presentExternalIdentity(
      { ...externalIdentity, subject: 'second-external-subject' },
      link.secret,
      'cloudflare',
      now,
    )).rejects.toMatchObject({ code: 'link_secret_consumed' });
  });

  it('does not allow an external or legacy principal to start a link transaction', async () => {
    const { store } = setup();
    const corporatePrincipal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    await expect(store.beginLinkTransaction(
      { ...corporatePrincipal, identityKind: 'linked_external' },
      new Date(),
    )).rejects.toMatchObject({ code: 'corporate_identity_required' });
  });

  it('returns only its corporate owner’s unexpired recovery-safe link summaries', async () => {
    const { store } = setup();
    const owner = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const other = await store.ensureCorporatePrincipal(
      { ...corporateIdentity, subject: 'other-corporate-subject', email: 'other@lancloudtech.com' },
      {},
    );
    const now = new Date('2026-07-22T00:00:00.000Z');
    await store.beginLinkTransaction(owner, new Date(now.getTime() - (20 * 60 * 1000)));
    const presented = await store.beginLinkTransaction(owner, now);
    await store.presentExternalIdentity(externalIdentity, presented.secret, 'github', now);

    const summaries = await store.listResumableLinkTransactions(owner, now);

    expect(summaries).toEqual([
      {
        id: presented.id,
        status: 'candidate_presented',
        expires_at: presented.expiresAt,
        provider_hint: 'github',
        email_masked: 'p******l@example.com',
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain(presented.secret);
    expect(JSON.stringify(summaries)).not.toContain(externalIdentity.subject);
    expect(JSON.stringify(summaries)).not.toContain(externalIdentity.email!);
    expect(await store.listResumableLinkTransactions(other, now)).toEqual([]);
  });

  it('cancels only one corporate user’s live pending and presented codes before issuing a replacement', async () => {
    const { database, store } = setup();
    const owner = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const other = await store.ensureCorporatePrincipal(
      { ...corporateIdentity, subject: 'other-corporate-subject', email: 'other@lancloudtech.com' },
      {},
    );
    const startedAt = new Date('2026-07-22T00:00:00.000Z');
    const pending = await store.beginLinkTransaction(owner, startedAt);
    const otherPending = await store.beginLinkTransaction(other, startedAt);
    const presented = await store.beginLinkTransaction(owner, new Date(startedAt.getTime() + 1000));

    await expect(store.presentExternalIdentity(externalIdentity, pending.secret, 'github', new Date(startedAt.getTime() + 1000)))
      .rejects.toMatchObject({ code: 'link_secret_consumed' });
    await store.presentExternalIdentity(externalIdentity, presented.secret, 'github', new Date(startedAt.getTime() + 1000));

    const replacementAt = new Date(startedAt.getTime() + 2000);
    const replacement = await store.beginLinkTransaction(owner, replacementAt);

    expect(database.prepare(
      `SELECT id, status, consumed_at FROM identity_link_transactions
       WHERE id IN (?, ?) ORDER BY id`,
    ).all(pending.id, presented.id)).toEqual(expect.arrayContaining([
      { id: pending.id, status: 'cancelled', consumed_at: '2026-07-22T00:00:01.000Z' },
      { id: presented.id, status: 'cancelled', consumed_at: '2026-07-22T00:00:02.000Z' },
    ]));
    expect(database.prepare(
      'SELECT status, consumed_at FROM identity_link_transactions WHERE id = ?',
    ).get(otherPending.id)).toEqual({ status: 'pending', consumed_at: null });
    await expect(store.confirmLinkTransaction(owner, presented.id, replacementAt))
      .rejects.toMatchObject({ code: 'link_secret_consumed' });
    await store.presentExternalIdentity(externalIdentity, replacement.secret, 'github', replacementAt);
    await expect(store.confirmLinkTransaction(owner, replacement.id, replacementAt))
      .resolves.toMatchObject({ identityKind: 'linked_external' });

    const rotationAudits = database.prepare(
      `SELECT action, detail_json FROM audit_events
       WHERE action = 'cancel_prior_live_identity_link_transactions' ORDER BY created_at, id`,
    ).all() as Array<{ action: string; detail_json: string }>;
    expect(rotationAudits).toHaveLength(2);
    expect(JSON.stringify(rotationAudits)).not.toContain(pending.secret);
    expect(JSON.stringify(rotationAudits)).not.toContain(presented.secret);
    expect(JSON.stringify(rotationAudits)).not.toContain(externalIdentity.subject);
    expect(JSON.stringify(rotationAudits)).not.toContain(externalIdentity.email!);
  });

  it('does not let an external principal read link recovery summaries', async () => {
    const { store } = setup();
    const corporatePrincipal = await store.ensureCorporatePrincipal(corporateIdentity, {});

    await expect(store.listResumableLinkTransactions(
      { ...corporatePrincipal, identityKind: 'linked_external' },
      new Date('2026-07-22T00:00:00.000Z'),
    )).rejects.toMatchObject({ code: 'corporate_identity_required' });
  });

  it('accepts only one concurrent presentation of the same code and identity', async () => {
    const database = createDatabase();
    const presentationBarrier = synchronizePresentationBatches(sqliteD1(database));
    const store = new IdentityStore(withUnreliableChangeMetadata(presentationBarrier.database));
    const corporatePrincipal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const link = await store.beginLinkTransaction(corporatePrincipal, now);

    const results = await Promise.allSettled([
      store.presentExternalIdentity(externalIdentity, link.secret, 'github', now),
      store.presentExternalIdentity(externalIdentity, link.secret, 'github', now),
    ]);
    const { fulfilled, rejected } = settledCounts(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'link_secret_consumed' });
    expect(database.prepare(
      "SELECT status, consumed_at FROM identity_link_transactions WHERE id = ?",
    ).get(link.id)).toEqual({ status: 'candidate_presented', consumed_at: null });
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'present_linked_external_identity_candidate'",
    ).get()).toMatchObject({ count: 1 });
    expect(presentationBarrier.presentationBatchArrivals()).toBe(2);
  });

  it('will not bind one issuer-subject to two different users', async () => {
    const { store } = setup();
    const first = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const second = await store.ensureCorporatePrincipal(
      { ...corporateIdentity, subject: 'corporate-subject-2', email: 'other@lancloudtech.com' },
      {},
    );
    const now = new Date('2026-07-22T00:00:00Z');
    const firstLink = await store.beginLinkTransaction(first, now);
    await store.presentExternalIdentity(externalIdentity, firstLink.secret, 'github', now);
    await store.confirmLinkTransaction(first, firstLink.id, now);

    const secondLink = await store.beginLinkTransaction(second, now);
    await expect(store.presentExternalIdentity(externalIdentity, secondLink.secret, 'github', now))
      .rejects.toMatchObject({ code: 'identity_already_bound' });
  });

  it('keeps a losing competing confirmation candidate-presented and unconsumed', async () => {
    const { database, store } = setup();
    const first = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const second = await store.ensureCorporatePrincipal(
      { ...corporateIdentity, subject: 'corporate-subject-2', email: 'other@lancloudtech.com' },
      {},
    );
    const now = new Date('2026-07-22T00:00:00Z');
    const firstLink = await store.beginLinkTransaction(first, now);
    const secondLink = await store.beginLinkTransaction(second, now);
    await store.presentExternalIdentity(externalIdentity, firstLink.secret, 'github', now);
    await store.presentExternalIdentity(externalIdentity, secondLink.secret, 'github', now);

    const results = await Promise.allSettled([
      store.confirmLinkTransaction(first, firstLink.id, now),
      store.confirmLinkTransaction(second, secondLink.id, now),
    ]);
    const { fulfilled, rejected } = settledCounts(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'identity_already_bound' });
    const transactions = database.prepare(
      `SELECT user_id, status, consumed_at FROM identity_link_transactions
       WHERE id IN (?, ?) ORDER BY user_id`,
    ).all(firstLink.id, secondLink.id) as Array<{ user_id: string; status: string; consumed_at: string | null }>;
    expect(transactions.filter((transaction) => transaction.status === 'confirmed')).toHaveLength(1);
    expect(transactions.filter((transaction) => (
      transaction.status === 'candidate_presented' && transaction.consumed_at === null
    ))).toHaveLength(1);
  });

  it('does not report a repeated same-owner confirmation as success when metadata lies', async () => {
    const database = createDatabase();
    const base = withUnreliableChangeMetadata(sqliteD1(database));
    const store = new IdentityStore(base);
    const principal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const link = await store.beginLinkTransaction(principal, now);
    await store.presentExternalIdentity(externalIdentity, link.secret, 'github', now);
    const racingStore = new IdentityStore(synchronizeNextBatches(base));

    const results = await Promise.allSettled([
      racingStore.confirmLinkTransaction(principal, link.id, now),
      racingStore.confirmLinkTransaction(principal, link.id, now),
    ]);
    const { fulfilled, rejected } = settledCounts(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'link_secret_consumed' });
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'confirm_linked_external_identity'",
    ).get()).toMatchObject({ count: 1 });
  });

  it('reactivates a revoked external identity only for its original corporate user', async () => {
    const { database, store } = setup();
    const original = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const other = await store.ensureCorporatePrincipal(
      { ...corporateIdentity, subject: 'corporate-subject-2', email: 'other@lancloudtech.com' },
      {},
    );
    const now = new Date('2026-07-22T00:00:00Z');
    const originalLink = await store.beginLinkTransaction(original, now);
    await store.presentExternalIdentity(externalIdentity, originalLink.secret, 'github', now);
    const linked = await store.confirmLinkTransaction(original, originalLink.id, now);
    await store.revokeLinkedIdentity(original, linked.identityId);

    const otherLink = await store.beginLinkTransaction(other, now);
    await expect(store.presentExternalIdentity(externalIdentity, otherLink.secret, 'github', now))
      .rejects.toMatchObject({ code: 'identity_already_bound' });

    const reactivationLink = await store.beginLinkTransaction(original, now);
    await store.presentExternalIdentity(externalIdentity, reactivationLink.secret, 'github', now);
    await expect(store.confirmLinkTransaction(original, reactivationLink.id, now))
      .resolves.toMatchObject({ identityId: linked.identityId, identityKind: 'linked_external' });
    expect(await store.resolve(externalIdentity, 'external')).toMatchObject({ userId: original.userId });
    expect(database.prepare(
      'SELECT count(*) AS count FROM user_access_identities WHERE issuer = ? AND subject = ?',
    ).get(externalIdentity.issuer, externalIdentity.subject)).toMatchObject({ count: 1 });
  });

  it('rotates a same-owner reactivation code before it can race a replacement', async () => {
    const database = createDatabase();
    const base = withUnreliableChangeMetadata(sqliteD1(database));
    const store = new IdentityStore(base);
    const principal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const initial = await store.beginLinkTransaction(principal, now);
    await store.presentExternalIdentity(externalIdentity, initial.secret, 'github', now);
    const linked = await store.confirmLinkTransaction(principal, initial.id, now);
    await store.revokeLinkedIdentity(principal, linked.identityId);

    const first = await store.beginLinkTransaction(principal, now);
    const replacementAt = new Date(now.getTime() + 1000);
    const second = await store.beginLinkTransaction(principal, replacementAt);
    await expect(store.presentExternalIdentity(externalIdentity, first.secret, 'github', replacementAt))
      .rejects.toMatchObject({ code: 'link_secret_consumed' });
    await store.presentExternalIdentity(externalIdentity, second.secret, 'github', replacementAt);
    await expect(store.confirmLinkTransaction(principal, second.id, replacementAt))
      .resolves.toMatchObject({ identityId: linked.identityId, identityKind: 'linked_external' });
    const transactions = database.prepare(
      'SELECT status, consumed_at FROM identity_link_transactions WHERE id IN (?, ?)',
    ).all(first.id, second.id) as Array<{ status: string; consumed_at: string | null }>;
    expect(transactions.filter((transaction) => transaction.status === 'confirmed')).toHaveLength(1);
    expect(transactions.filter((transaction) => transaction.status === 'cancelled')).toHaveLength(1);
  });

  it('resolves an external identity only after it was linked and immediately blocks it after revoke', async () => {
    const { store } = setup();
    const principal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const link = await store.beginLinkTransaction(principal, now);
    await store.presentExternalIdentity(externalIdentity, link.secret, null, now);
    const linked = await store.confirmLinkTransaction(principal, link.id, now);
    expect(await store.resolve(externalIdentity, 'external')).toMatchObject({ userId: principal.userId });
    await store.revokeLinkedIdentity(principal, linked.identityId);
    expect(await store.resolve(externalIdentity, 'external')).toBeNull();
  });

  it('resolves identity and roles at one SQL read linearization point', async () => {
    const database = createDatabase();
    const base = sqliteD1(database);
    const provisioningStore = new IdentityStore(base);
    await provisioningStore.ensureCorporatePrincipal(corporateIdentity, {});
    let preparedReads = 0;
    const countingDb = {
      prepare(query: string) {
        if (/^\s*SELECT/i.test(query)) preparedReads += 1;
        return base.prepare(query);
      },
      batch: base.batch.bind(base),
    } as D1Database;

    await expect(new IdentityStore(countingDb).resolve(corporateIdentity, 'corporate'))
      .resolves.toMatchObject({ roles: ['employee'] });
    expect(preparedReads).toBe(1);
  });

  it('allows only one concurrent revocation and writes one audit event', async () => {
    const database = createDatabase();
    const store = new IdentityStore(withUnreliableChangeMetadata(sqliteD1(database)));
    const principal = await store.ensureCorporatePrincipal(corporateIdentity, {});
    const now = new Date('2026-07-22T00:00:00Z');
    const link = await store.beginLinkTransaction(principal, now);
    await store.presentExternalIdentity(externalIdentity, link.secret, 'github', now);
    const linked = await store.confirmLinkTransaction(principal, link.id, now);

    const results = await Promise.allSettled([
      store.revokeLinkedIdentity(principal, linked.identityId),
      store.revokeLinkedIdentity(principal, linked.identityId),
    ]);
    const { fulfilled, rejected } = settledCounts(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'linked_identity_not_found' });
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'revoke_linked_external_identity'",
    ).get()).toMatchObject({ count: 1 });
  });
});
