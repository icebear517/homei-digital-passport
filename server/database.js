import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

const postgresSql = sql => {
  let number = 0;
  return sql.replace(/\?/g, () => `$${++number}`);
};

const schema = `
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    subject TEXT NOT NULL,
    expires BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stamps (
    campaign TEXT NOT NULL,
    user_id TEXT NOT NULL,
    merchant TEXT NOT NULL,
    created BIGINT NOT NULL,
    PRIMARY KEY (campaign, user_id, merchant)
  );
  CREATE TABLE IF NOT EXISTS draw_entries (
    campaign TEXT NOT NULL,
    user_id TEXT NOT NULL,
    coupon TEXT NOT NULL UNIQUE,
    created BIGINT NOT NULL,
    PRIMARY KEY (campaign, user_id, coupon)
  );
  CREATE TABLE IF NOT EXISTS coupons (
    token TEXT PRIMARY KEY,
    campaign TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prize TEXT NOT NULL,
    expires BIGINT,
    created BIGINT NOT NULL,
    used_by TEXT,
    used_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS coupons_campaign_prize_idx ON coupons (campaign, prize);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires);
`;

class SqliteDatabase {
  constructor(path) { this.db = new DatabaseSync(path); }
  async initialize() { this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; ${schema}`); }
  async run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  async get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  async all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  async transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = await action(this); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async close() { this.db.close(); }
}

class PostgresDatabase {
  constructor(url) { this.pool = new Pool({ connectionString: url, max: 8, idleTimeoutMillis: 20_000 }); }
  async initialize() { await this.pool.query(schema); }
  async run(sql, ...params) { return this.pool.query(postgresSql(sql), params); }
  async get(sql, ...params) { return (await this.pool.query(postgresSql(sql), params)).rows[0]; }
  async all(sql, ...params) { return (await this.pool.query(postgresSql(sql), params)).rows; }
  async transaction(action) {
    const client = await this.pool.connect();
    const tx = {
      run: async (sql, ...params) => client.query(postgresSql(sql), params),
      get: async (sql, ...params) => (await client.query(postgresSql(sql), params)).rows[0],
      all: async (sql, ...params) => (await client.query(postgresSql(sql), params)).rows,
    };
    try { await client.query('BEGIN'); const value = await action(tx); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}

export async function openDatabase({ databaseUrl = '', dbPath = ':memory:' } = {}) {
  const database = databaseUrl ? new PostgresDatabase(databaseUrl) : new SqliteDatabase(dbPath);
  await database.initialize();
  return database;
}
