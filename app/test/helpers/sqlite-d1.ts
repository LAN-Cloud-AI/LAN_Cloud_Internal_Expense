import type Database from 'better-sqlite3';

type Row = Record<string, unknown>;

interface SqlitePreparedStatement {
  bind(...values: unknown[]): SqlitePreparedStatement;
  first<T = Row>(columnName?: string): Promise<T | null>;
  all<T = Row>(): Promise<D1Result<T>>;
  run<T = Row>(): Promise<D1Result<T>>;
  executeRun<T = Row>(): D1Result<T>;
}

function result<T>(
  results: T[],
  runResult?: Database.RunResult,
): D1Result<T> {
  const changes = runResult?.changes ?? 0;
  const lastInsertRowid = runResult?.lastInsertRowid ?? 0;
  const meta: D1Meta & Record<string, unknown> = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: typeof lastInsertRowid === 'bigint' ? Number(lastInsertRowid) : lastInsertRowid,
    changed_db: changes > 0,
    changes,
  };
  return { success: true, results, meta };
}

/**
 * Minimal in-memory D1 adapter for identity-store tests. It deliberately exposes
 * only the D1 operations used by this project and always binds sqlite values.
 */
export function sqliteD1(database: Database.Database): D1Database {
  const prepare = (query: string): D1PreparedStatement => {
    let values: unknown[] = [];
    const statement: SqlitePreparedStatement = {
      bind(...boundValues: unknown[]) {
        values = boundValues;
        return statement;
      },
      async first<T = Row>(columnName?: string): Promise<T | null> {
        const row = database.prepare(query).get(...values) as Row | undefined;
        if (!row) return null;
        return (columnName ? row[columnName] : row) as T;
      },
      async all<T = Row>(): Promise<D1Result<T>> {
        return result(database.prepare(query).all(...values) as T[]);
      },
      async run<T = Row>(): Promise<D1Result<T>> {
        return statement.executeRun<T>();
      },
      executeRun<T = Row>(): D1Result<T> {
        const prepared = database.prepare(query);
        if (prepared.reader) {
          return result(prepared.all(...values) as T[]);
        }
        return result<T>([], prepared.run(...values));
      },
    };
    return statement as unknown as D1PreparedStatement;
  };

  return {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const execute = database.transaction((items: D1PreparedStatement[]) => items.map((item) => (
        (item as unknown as SqlitePreparedStatement).executeRun<T>()
      )));
      return execute(statements);
    },
  } as D1Database;
}

/**
 * Test-only fault injector. `sqliteD1().batch()` executes every statement in a
 * single better-sqlite3 transaction, so an injected `executeRun` failure
 * verifies that preceding mutations are rolled back rather than merely
 * skipped.
 */
export function withD1StatementFailure(
  db: D1Database,
  matches: (query: string) => boolean,
): D1Database {
  return {
    prepare(query: string) {
      const prepared = db.prepare(query);
      if (!matches(query)) return prepared;

      let bound = prepared;
      const wrapper = {
        bind(...values: unknown[]) {
          bound = prepared.bind(...values);
          return wrapper;
        },
        async first<T = Row>(columnName?: string): Promise<T | null> {
          return columnName === undefined ? bound.first<T>() : bound.first<T>(columnName);
        },
        async all<T = Row>(): Promise<D1Result<T>> {
          return bound.all<T>();
        },
        async run<T = Row>(): Promise<D1Result<T>> {
          throw new Error('injected D1 statement failure');
        },
        raw<T = unknown[]>(options?: { columnNames?: boolean }) {
          return options === undefined ? bound.raw<T>() : bound.raw<T>(options as { columnNames: true });
        },
        executeRun<T = Row>(): D1Result<T> {
          throw new Error('injected D1 statement failure');
        },
      };
      return wrapper as unknown as D1PreparedStatement;
    },
    batch: db.batch.bind(db),
  } as D1Database;
}
