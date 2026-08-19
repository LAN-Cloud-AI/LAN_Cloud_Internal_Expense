import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

function createDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');

  for (const migrationName of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    if (migrationName === '0006_access_identities.sql') {
      seedLedger(database);
    }
    database.exec(readFileSync(join(migrationsDir, migrationName), 'utf8'));
  }

  databases.push(database);
  return database;
}

function createDatabaseBeforeAccountIdentifierMigration(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');

  for (const migrationName of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name < '0015_account_asset_identifier.sql')
    .sort()) {
    if (migrationName === '0006_access_identities.sql') {
      seedLedger(database);
    }
    database.exec(readFileSync(join(migrationsDir, migrationName), 'utf8'));
  }

  databases.push(database);
  return database;
}

function seedLedger(database: Database.Database): void {
  database.exec(`
    INSERT INTO users (id, external_subject, display_name)
      VALUES ('user-1', 'access-subject-1', '财务管理员');
    INSERT INTO users (id, display_name)
      VALUES ('user-2', '普通员工');
    INSERT INTO users (id, external_subject, display_name)
      VALUES
        ('a-b', 'c', '历史用户 A'),
        ('a', 'b-c', '历史用户 B');
    INSERT INTO payers (id, display_name, active_from) VALUES
      ('payer-a', '付款者 A', '2026-01-01'),
      ('payer-b', '付款者 B', '2026-01-01');
    INSERT INTO subscriptions (id, name, owner_user_id)
      VALUES ('subscription-1', '订阅 1', 'user-1');
    INSERT INTO subscription_term_versions (
      id, subscription_id, effective_start, billing_cycle, settlement_mode,
      billing_anchor_date, original_currency, amount_minor
    ) VALUES (
      'term-1', 'subscription-1', '2026-01-01', 'monthly', 'accrual',
      '2026-01-01', 'CNY', 1000
    );
    INSERT INTO payer_assignments (id, subscription_id, payer_id, effective_start)
      VALUES ('assignment-a', 'subscription-1', 'payer-a', '2026-01-01');
    INSERT INTO reimbursement_candidates (
      id, subscription_term_version_id, payer_assignment_id, source_charge_id,
      coverage_start, coverage_end, original_currency, original_amount_minor,
      rate_numerator, rate_denominator, cny_amount_fen, status
    ) VALUES (
      'candidate-a', 'term-1', 'assignment-a', 'charge-a',
      '2026-01-01', '2026-01-31', 'CNY', 1000, 1, 1, 1000, 'pending'
    );
    INSERT INTO idempotency_requests (id, actor_id, action, idempotency_key, request_hash)
      VALUES
        ('idem-a', 'user-1', 'create_reimbursement', 'key-a', 'hash-a'),
        ('idem-b', 'user-1', 'create_reimbursement', 'key-b', 'hash-b');
    INSERT INTO reimbursement_submissions (id, actor_id, cutoff_date, idempotency_request_id)
      VALUES
        ('submission-a', 'user-1', '2026-01-31', 'idem-a'),
        ('submission-b', 'user-1', '2026-01-31', 'idem-b');
    INSERT INTO reimbursement_batches (
      id, submission_id, payer_id, coverage_start, coverage_end, total_cny_fen
    ) VALUES
      ('batch-a', 'submission-a', 'payer-a', '2026-01-01', '2026-01-31', 1000),
      ('batch-b', 'submission-b', 'payer-b', '2026-01-01', '2026-01-31', 1000);
  `);
}

function insertItem(
  database: Database.Database,
  values: { id: string; batchId: string; candidateId: string; payerId: string },
): void {
  database
    .prepare(
      `INSERT INTO reimbursement_items (
        id, batch_id, candidate_id, payer_id, coverage_start, coverage_end,
        original_currency, original_amount_minor, rate_numerator,
        rate_denominator, cny_amount_fen
      ) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-31', 'CNY', 1000, 1, 1, 1000)`,
    )
    .run(values.id, values.batchId, values.candidateId, values.payerId);
}

describe('报销账本完整性约束', () => {
  it('订阅周期允许半年付，且月付季付半年付年付均按整期入账约束', () => {
    const database = createDatabase();
    database.prepare(
      `UPDATE subscription_term_versions SET billing_cycle = 'semi_annual' WHERE id = 'term-1'`,
    ).run();
    expect(database.prepare(`SELECT billing_cycle FROM subscription_term_versions WHERE id = 'term-1'`).get()).toMatchObject({
      billing_cycle: 'semi_annual',
    });
    expect(() =>
      database.prepare("UPDATE subscription_term_versions SET billing_cycle = 'weekly' WHERE id = 'term-1'").run(),
    ).toThrow();
  });

  it('订阅的自动续费标记只能是布尔值，付款方式与备注属于可变主数据', () => {
    const database = createDatabase();
    database.prepare(
      `UPDATE subscriptions
       SET auto_renew = 1, payment_method_masked = 'Visa **** 1234', notes = '财务已确认'
       WHERE id = 'subscription-1'`,
    ).run();

    expect(() =>
      database.prepare("UPDATE subscriptions SET auto_renew = 2 WHERE id = 'subscription-1'").run(),
    ).toThrow();
  });

  it('没有实际账单来源 ID 的自动候选也不能按同一账期重复生成', () => {
    const database = createDatabase();
    const insertAutomaticCandidate = (id: string) => database.prepare(
      `INSERT INTO reimbursement_candidates (
        id, subscription_term_version_id, payer_assignment_id,
        coverage_start, coverage_end, original_currency, original_amount_minor,
        rate_numerator, rate_denominator, cny_amount_fen, status
      ) VALUES (?, 'term-1', 'assignment-a', '2026-02-01', '2026-02-28', 'CNY', 1000, 1, 1, 1000, 'pending')`,
    ).run(id);

    insertAutomaticCandidate('candidate-auto-1');
    expect(() => insertAutomaticCandidate('candidate-auto-2')).toThrow();
  });

  it('只有 pending 候选才能加入报销明细', () => {
    const database = createDatabase();
    database.prepare("UPDATE reimbursement_candidates SET status = 'selected' WHERE id = 'candidate-a'").run();

    expect(() =>
      insertItem(database, {
        id: 'item-selected-candidate',
        batchId: 'batch-a',
        candidateId: 'candidate-a',
        payerId: 'payer-a',
      }),
    ).toThrow(/candidate must be pending/);
  });

  it('报销明细的付款者必须与所属批次匹配', () => {
    const database = createDatabase();

    expect(() =>
      insertItem(database, {
        id: 'item-batch-mismatch',
        batchId: 'batch-b',
        candidateId: 'candidate-a',
        payerId: 'payer-a',
      }),
    ).toThrow(/item payer does not match batch payer/);
  });

  it('报销明细的付款者必须与候选的付款者版本匹配', () => {
    const database = createDatabase();

    expect(() =>
      insertItem(database, {
        id: 'item-candidate-mismatch',
        batchId: 'batch-b',
        candidateId: 'candidate-a',
        payerId: 'payer-b',
      }),
    ).toThrow(/item payer does not match candidate payer/);
  });

  it('已付款明细不可修改，避免历史账本被静默篡改', () => {
    const database = createDatabase();
    insertItem(database, {
      id: 'item-paid',
      batchId: 'batch-a',
      candidateId: 'candidate-a',
      payerId: 'payer-a',
    });
    database.prepare("UPDATE reimbursement_items SET status = 'paid' WHERE id = 'item-paid'").run();

    expect(() =>
      database
        .prepare("UPDATE reimbursement_items SET cny_amount_fen = 1 WHERE id = 'item-paid'")
        .run(),
    ).toThrow(/paid reimbursement item is immutable/);
  });
});

describe('访问身份与绑定事务完整性约束', () => {
  it('以 issuer 和 subject 作为身份主键，并且每个用户只能有一个有效企业主身份', () => {
    const database = createDatabase();
    const insertIdentity = (id: string, userId: string, issuer: string, subject: string) => database.prepare(
      `INSERT INTO user_access_identities (
        id, user_id, issuer, subject, identity_kind, provider_hint
      ) VALUES (?, ?, ?, ?, 'corporate_primary', 'cloudflare')`,
    ).run(id, userId, issuer, subject);

    insertIdentity('identity-a', 'user-1', 'https://issuer', 'same-subject');

    expect(() => insertIdentity('identity-b', 'user-2', 'https://issuer', 'same-subject')).toThrow();
    expect(() => insertIdentity('identity-c', 'user-1', 'https://issuer', 'different-subject')).toThrow();
  });

  it('为历史 external_subject 回填独立的 legacy 身份', () => {
    const database = createDatabase();
    const legacyIdentity = database.prepare(
      `SELECT user_id, issuer, subject, identity_kind
       FROM user_access_identities
       WHERE user_id = 'user-1'`,
    ).get();
    expect(legacyIdentity).toMatchObject({
      user_id: 'user-1',
      issuer: 'legacy://users.external_subject',
      subject: 'access-subject-1',
      identity_kind: 'legacy_primary',
    });

    const ambiguousLegacyPairs = database.prepare(
      `SELECT id, user_id, subject
       FROM user_access_identities
       WHERE user_id IN ('a-b', 'a')
       ORDER BY user_id`,
    ).all() as Array<{ id: string; user_id: string; subject: string }>;
    expect(ambiguousLegacyPairs).toEqual([
      { id: 'legacy-61-622D63', user_id: 'a', subject: 'b-c' },
      { id: 'legacy-612D62-63', user_id: 'a-b', subject: 'c' },
    ]);
    expect(new Set(ambiguousLegacyPairs.map((identity) => identity.id)).size).toBe(2);
  });

  it('允许不同用户的不同身份使用相同已验证邮箱', () => {
    const database = createDatabase();
    const insertCorporateIdentity = (id: string, userId: string, issuer: string, subject: string) => database.prepare(
      `INSERT INTO user_access_identities (
        id, user_id, issuer, subject, verified_email, identity_kind, provider_hint
      ) VALUES (?, ?, ?, ?, 'shared@lancloudtech.com', 'corporate_primary', 'cloudflare')`,
    ).run(id, userId, issuer, subject);

    insertCorporateIdentity('identity-email-a', 'user-1', 'https://github.com', 'github-user-a');
    expect(() => insertCorporateIdentity('identity-email-b', 'user-2', 'https://github.com', 'github-user-b')).not.toThrow();
  });
});

describe('账号资产标识迁移', () => {
  it('按显示名称回填服务或平台标识，并保留未匹配历史资产为未分类', () => {
    const database = createDatabaseBeforeAccountIdentifierMigration();
    database.exec(
      "INSERT INTO account_assets (id, display_name, account_identifier_masked) VALUES " +
        "('asset-obs', '示例成员的OBS', 'example-obs')," +
        "('asset-github-id', '示例成员 · GitHub ID', 'example-github-id')," +
        "('asset-github-email', '示例成员 · GitHub 邮箱', 'example-github-email')," +
        "('asset-leadshunter', '示例成员 · LeadsHunter 用户名', 'example-leadshunter')," +
        "('asset-obsidian', '示例成员 · Obsidian', 'example-obsidian')," +
        "('asset-domain-mail', '示例成员 · 兰芯域名邮箱', 'example-domain-mail')," +
        "('asset-unmatched', '未匹配的旧资产', 'example-unmatched')",
    );
    database.exec(readFileSync(join(migrationsDir, '0015_account_asset_identifier.sql'), 'utf8'));

    expect(
      database.prepare(
        'SELECT id, asset_identifier FROM account_assets ORDER BY id',
      ).all(),
    ).toEqual([
      { id: 'asset-domain-mail', asset_identifier: '兰芯域名邮箱' },
      { id: 'asset-github-email', asset_identifier: 'GitHub' },
      { id: 'asset-github-id', asset_identifier: 'GitHub' },
      { id: 'asset-leadshunter', asset_identifier: 'LeadsHunter' },
      { id: 'asset-obs', asset_identifier: 'OBS' },
      { id: 'asset-obsidian', asset_identifier: 'Obsidian' },
      { id: 'asset-unmatched', asset_identifier: '未分类' },
    ]);
  });
});
