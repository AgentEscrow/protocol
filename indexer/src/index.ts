/**
 * ClawTasks Indexer
 * 
 * Indexes all bounties from ClawTasks API into a searchable SQLite database.
 * Creates the search layer for the agent economy.
 */

import Database from 'better-sqlite3';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

const CLAWTASKS_API = 'https://clawtasks.com/api';
const CLAWTASKS_CONTRACT = '0x14095ac82280cf965cc63e396e8c4f449d77cb07';
const DB_PATH = process.env.DB_PATH || './data/clawtasks.db';

// Initialize database
function initDb(): Database.Database {
  const db = new Database(DB_PATH);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounties (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      amount REAL,
      currency TEXT DEFAULT 'USDC',
      status TEXT,
      bounty_type TEXT,
      claim_mode TEXT,
      poster_address TEXT,
      worker_address TEXT,
      skills TEXT,
      category TEXT,
      deadline_hours INTEGER,
      created_at INTEGER,
      claimed_at INTEGER,
      completed_at INTEGER,
      tx_hash TEXT,
      raw_data TEXT,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      address TEXT PRIMARY KEY,
      name TEXT,
      bounties_posted INTEGER DEFAULT 0,
      bounties_completed INTEGER DEFAULT 0,
      total_earned REAL DEFAULT 0,
      total_spent REAL DEFAULT 0,
      first_seen INTEGER,
      last_active INTEGER,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS bounties_fts USING fts5(
      id,
      title,
      description,
      skills,
      category,
      content='bounties',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS bounties_ai AFTER INSERT ON bounties BEGIN
      INSERT INTO bounties_fts(rowid, id, title, description, skills, category)
      VALUES (new.rowid, new.id, new.title, new.description, new.skills, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS bounties_ad AFTER DELETE ON bounties BEGIN
      INSERT INTO bounties_fts(bounties_fts, rowid, id, title, description, skills, category)
      VALUES ('delete', old.rowid, old.id, old.title, old.description, old.skills, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS bounties_au AFTER UPDATE ON bounties BEGIN
      INSERT INTO bounties_fts(bounties_fts, rowid, id, title, description, skills, category)
      VALUES ('delete', old.rowid, old.id, old.title, old.description, old.skills, old.category);
      INSERT INTO bounties_fts(rowid, id, title, description, skills, category)
      VALUES (new.rowid, new.id, new.title, new.description, new.skills, new.category);
    END;

    CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
    CREATE INDEX IF NOT EXISTS idx_bounties_poster ON bounties(poster_address);
    CREATE INDEX IF NOT EXISTS idx_bounties_worker ON bounties(worker_address);
    CREATE INDEX IF NOT EXISTS idx_bounties_created ON bounties(created_at);
    CREATE INDEX IF NOT EXISTS idx_bounties_amount ON bounties(amount);
  `);

  return db;
}

// Fetch bounties from ClawTasks API
async function fetchBounties(status?: string, limit = 100, offset = 0): Promise<any[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());

  const url = `${CLAWTASKS_API}/bounties?${params}`;
  console.log(`Fetching: ${url}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`API error: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.bounties || data || [];
  } catch (err) {
    console.error(`Fetch error:`, err);
    return [];
  }
}

// Upsert bounty into database
function upsertBounty(db: Database.Database, bounty: any): void {
  const stmt = db.prepare(`
    INSERT INTO bounties (
      id, title, description, amount, currency, status, bounty_type, claim_mode,
      poster_address, worker_address, skills, category, deadline_hours,
      created_at, claimed_at, completed_at, tx_hash, raw_data
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      worker_address = excluded.worker_address,
      claimed_at = excluded.claimed_at,
      completed_at = excluded.completed_at,
      indexed_at = strftime('%s', 'now')
  `);

  stmt.run(
    bounty.id,
    bounty.title || '',
    bounty.description || '',
    bounty.amount || 0,
    bounty.currency || 'USDC',
    bounty.status || 'unknown',
    bounty.bounty_type || 'standard',
    bounty.claim_mode || 'instant',
    bounty.poster_address || bounty.poster?.address || '',
    bounty.worker_address || bounty.worker?.address || '',
    Array.isArray(bounty.skills) ? bounty.skills.join(',') : (bounty.skills || ''),
    bounty.category || '',
    bounty.deadline_hours || 24,
    bounty.created_at ? new Date(bounty.created_at).getTime() / 1000 : null,
    bounty.claimed_at ? new Date(bounty.claimed_at).getTime() / 1000 : null,
    bounty.completed_at ? new Date(bounty.completed_at).getTime() / 1000 : null,
    bounty.tx_hash || '',
    JSON.stringify(bounty)
  );
}

// Update agent stats
function updateAgentStats(db: Database.Database): void {
  // Update poster stats
  db.exec(`
    INSERT OR REPLACE INTO agents (address, name, bounties_posted, total_spent, first_seen, last_active)
    SELECT 
      poster_address,
      '',
      COUNT(*),
      SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END),
      MIN(created_at),
      MAX(created_at)
    FROM bounties
    WHERE poster_address != ''
    GROUP BY poster_address
  `);

  // Update worker stats
  db.exec(`
    INSERT INTO agents (address, bounties_completed, total_earned, last_active)
    SELECT 
      worker_address,
      COUNT(*),
      SUM(CASE WHEN status = 'completed' THEN amount * 0.95 ELSE 0 END),
      MAX(completed_at)
    FROM bounties
    WHERE worker_address != '' AND status = 'completed'
    GROUP BY worker_address
    ON CONFLICT(address) DO UPDATE SET
      bounties_completed = excluded.bounties_completed,
      total_earned = excluded.total_earned,
      last_active = MAX(agents.last_active, excluded.last_active)
  `);
}

// Full sync - fetch all bounties
async function fullSync(db: Database.Database): Promise<void> {
  console.log('Starting full sync...');
  
  const statuses = ['open', 'claimed', 'submitted', 'completed', 'expired', 'cancelled'];
  let totalIndexed = 0;

  for (const status of statuses) {
    let offset = 0;
    const limit = 100;

    while (true) {
      const bounties = await fetchBounties(status, limit, offset);
      if (bounties.length === 0) break;

      for (const bounty of bounties) {
        upsertBounty(db, bounty);
        totalIndexed++;
      }

      console.log(`Indexed ${bounties.length} ${status} bounties (offset ${offset})`);
      offset += limit;

      // Rate limiting
      await new Promise(r => setTimeout(r, 200));
    }
  }

  updateAgentStats(db);
  
  // Save sync state
  db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_full_sync', ?)`).run(Date.now().toString());
  
  console.log(`Full sync complete. Total indexed: ${totalIndexed}`);
}

// Search bounties
function search(db: Database.Database, query: string, limit = 20): any[] {
  const stmt = db.prepare(`
    SELECT b.* FROM bounties b
    JOIN bounties_fts fts ON b.rowid = fts.rowid
    WHERE bounties_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, limit);
}

// Get stats
function getStats(db: Database.Database): any {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_bounties,
      COUNT(CASE WHEN status = 'open' THEN 1 END) as open_bounties,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bounties,
      SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_volume,
      AVG(CASE WHEN status = 'completed' THEN amount END) as avg_bounty,
      COUNT(DISTINCT poster_address) as unique_posters,
      COUNT(DISTINCT worker_address) as unique_workers
    FROM bounties
  `).get();

  const topCategories = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM bounties
    WHERE category != ''
    GROUP BY category
    ORDER BY count DESC
    LIMIT 10
  `).all();

  return { ...stats, topCategories };
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'sync';

  // Ensure data directory exists
  const fs = await import('fs');
  const path = await import('path');
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = initDb();

  switch (command) {
    case 'sync':
      await fullSync(db);
      break;

    case 'search':
      const query = args.slice(1).join(' ');
      if (!query) {
        console.log('Usage: search <query>');
        break;
      }
      const results = search(db, query);
      console.log(JSON.stringify(results, null, 2));
      break;

    case 'stats':
      const stats = getStats(db);
      console.log(JSON.stringify(stats, null, 2));
      break;

    case 'serve':
      console.log('Starting API server...');
      // Import and start the server
      const { startServer } = await import('./server.js');
      startServer(db);
      break;

    default:
      console.log(`
ClawTasks Indexer

Commands:
  sync     Full sync from ClawTasks API
  search   Search bounties: search <query>
  stats    Show index statistics
  serve    Start the search API server
      `);
  }
}

main().catch(console.error);

export { initDb, search, getStats, fullSync };
