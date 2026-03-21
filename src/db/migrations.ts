import type { Database } from "bun:sqlite";

export function runDatabaseMigrations(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  database.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_domain_key
    ON memory(domain, key)
    WHERE domain IS NOT NULL
  `);

  database.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_null_domain_key
    ON memory(key)
    WHERE domain IS NULL
  `);

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_memory_domain
    ON memory(domain)
    WHERE domain IS NOT NULL
  `);

  database.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      key,
      value,
      content='memory',
      content_rowid='id',
      tokenize='porter unicode61'
    )
  `);

  database.run(`
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, key, value)
      VALUES (new.id, new.key, new.value);
    END
  `);

  database.run(`
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value)
      VALUES ('delete', old.id, old.key, old.value);
      INSERT INTO memory_fts(rowid, key, value)
      VALUES (new.id, new.key, new.value);
    END
  `);

  database.run(`
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value)
      VALUES ('delete', old.id, old.key, old.value);
    END
  `);

  database.run(`INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')`);
}
