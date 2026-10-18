// In-memory D1 (backed by Node's built-in SQLite) and KV fakes for route tests.
// The schema comes from the real migrations (src/lib/migrations.ts), so the
// tests exercise the routes against the same DDL that production applies.
import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from '../../src/lib/migrations.ts';

// ─── KV ──────────────────────────────────────────────────────────────────────

export class MemoryKV {
  private store = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();

  async get(key: string, type?: 'json'): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now() / 1000) {
      this.store.delete(key);
      return null;
    }
    if (type === 'json') {
      try {
        return JSON.parse(entry.value);
      } catch {
        return null;
      }
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl
        ? Math.floor(Date.now() / 1000) + opts.expirationTtl
        : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ─── D1 (SQLite-backed) ──────────────────────────────────────────────────────

interface D1Result {
  results: Record<string, unknown>[];
}

class D1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  first<T>(): T | null {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row ?? null) as T | null;
  }

  all<T>(): { results: T[] } {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows };
  }

  run(): { meta: { changes: number } } {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes) } };
  }
}

export class D1Mock {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    for (const migration of getMigrations('')) {
      this.db.exec(migration.sql);
    }
  }

  prepare(sql: string): D1Statement {
    return new D1Statement(this.db, sql);
  }

  batch(statements: D1Statement[]): D1Result[] {
    return statements.map((s) => s.all());
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}
