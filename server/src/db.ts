import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dev, docker, and local dist layouts
const MIGRATIONS_CANDIDATES = [
  join(__dirname, '..', 'migrations'),
  join(__dirname, '..', '..', 'migrations'),
  join(__dirname, 'migrations'),
];
export const DEFAULT_DATABASE_PATH = '/var/lib/dragonchess/dragonchess.sqlite';

export function databasePath(): string {
  return process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
}

function migrationsDir(): string | null {
  for (const d of MIGRATIONS_CANDIDATES) if (existsSync(d)) return d;
  return null;
}

export function openDb(path: string = databasePath()): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(db: DB): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((r: any) => r.name),
  );
  const dir = migrationsDir();
  const files = dir
    ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    : [];
  const justApplied: string[] = [];
  const insertMigration = db.prepare('INSERT OR IGNORE INTO migrations(name, applied_at) VALUES (?, ?)');
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir!, f), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(f, Date.now());
    });
    tx();
    justApplied.push(f);
  }
  return { applied: justApplied };
}

export function inMemoryDb(): DB {
  return openDb(':memory:');
}