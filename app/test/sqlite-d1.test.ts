import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';

const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('sqliteD1 local adapter behavior', () => {
  it('exposes local change counts for diagnostics, without making them a production guarantee', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    database.exec('CREATE TABLE values_table (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const db = sqliteD1(database);

    const inserted = await db.prepare(
      'INSERT INTO values_table (id, value) VALUES (?, ?)',
    ).bind('one', 'first').run();
    const ignored = await db.prepare(
      'INSERT OR IGNORE INTO values_table (id, value) VALUES (?, ?)',
    ).bind('one', 'ignored').run();
    const batch = await db.batch([
      db.prepare('UPDATE values_table SET value = ? WHERE id = ?').bind('updated', 'one'),
      db.prepare('UPDATE values_table SET value = ? WHERE id = ?').bind('missing', 'missing'),
    ]);

    expect(inserted.meta.changes).toBe(1);
    expect(ignored.meta.changes).toBe(0);
    expect(batch.map((item) => item.meta.changes)).toEqual([1, 0]);
  });

  it('returns SQLite RETURNING rows from direct statements and batch items', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    database.exec('CREATE TABLE values_table (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const db = sqliteD1(database);

    const direct = await db.prepare(
      'INSERT INTO values_table (id, value) VALUES (?, ?) RETURNING id',
    ).bind('one', 'first').all<{ id: string }>();
    const batch = await db.batch<{ id: string }>([
      db.prepare('UPDATE values_table SET value = ? WHERE id = ? RETURNING id').bind('updated', 'one'),
      db.prepare('UPDATE values_table SET value = ? WHERE id = ? RETURNING id').bind('missing', 'missing'),
    ]);

    expect(direct.results).toEqual([{ id: 'one' }]);
    expect(batch.map((item) => item.results)).toEqual([[{ id: 'one' }], []]);
  });
});
