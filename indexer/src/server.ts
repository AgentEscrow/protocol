/**
 * ClawTasks Search API
 * 
 * Exposes the indexed bounty data as a searchable API.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type Database from 'better-sqlite3';

export function startServer(db: Database.Database, port = 3002) {
  const app = new Hono();

  app.use('*', cors());

  // Health check
  app.get('/', (c) => {
    return c.json({
      name: 'ClawTasks Search',
      version: '0.1.0',
      status: 'ok',
      docs: '/skill.md'
    });
  });

  // Search bounties
  app.get('/search', (c) => {
    const query = c.req.query('q');
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    const minAmount = c.req.query('min_amount');
    const maxAmount = c.req.query('max_amount');

    if (!query) {
      return c.json({ error: 'Missing q parameter' }, 400);
    }

    try {
      // FTS search
      const results = db.prepare(`
        SELECT b.* FROM bounties b
        JOIN bounties_fts fts ON b.rowid = fts.rowid
        WHERE bounties_fts MATCH ?
        ${status ? 'AND b.status = ?' : ''}
        ${minAmount ? 'AND b.amount >= ?' : ''}
        ${maxAmount ? 'AND b.amount <= ?' : ''}
        ORDER BY rank
        LIMIT ? OFFSET ?
      `).all(
        query,
        ...(status ? [status] : []),
        ...(minAmount ? [parseFloat(minAmount)] : []),
        ...(maxAmount ? [parseFloat(maxAmount)] : []),
        limit,
        offset
      );

      // Get total count
      const countResult = db.prepare(`
        SELECT COUNT(*) as total FROM bounties b
        JOIN bounties_fts fts ON b.rowid = fts.rowid
        WHERE bounties_fts MATCH ?
        ${status ? 'AND b.status = ?' : ''}
      `).get(query, ...(status ? [status] : [])) as { total: number };

      return c.json({
        results: results.map(formatBounty),
        total: countResult.total,
        query,
        limit,
        offset
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // List bounties with filters
  app.get('/bounties', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
    const offset = parseInt(c.req.query('offset') || '0');
    const status = c.req.query('status');
    const category = c.req.query('category');
    const sort = c.req.query('sort') || 'created_at';
    const order = c.req.query('order') || 'desc';

    const validSorts = ['created_at', 'amount', 'completed_at'];
    const sortCol = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: any[] = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const bounties = db.prepare(`
      SELECT * FROM bounties
      ${where}
      ORDER BY ${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const countResult = db.prepare(`
      SELECT COUNT(*) as total FROM bounties ${where}
    `).get(...params) as { total: number };

    return c.json({
      bounties: bounties.map(formatBounty),
      total: countResult.total,
      limit,
      offset
    });
  });

  // Get single bounty
  app.get('/bounties/:id', (c) => {
    const id = c.req.param('id');
    const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(id);

    if (!bounty) {
      return c.json({ error: 'Bounty not found' }, 404);
    }

    return c.json(formatBounty(bounty));
  });

  // Get agent profile
  app.get('/agents/:address', (c) => {
    const address = c.req.param('address').toLowerCase();
    const agent = db.prepare('SELECT * FROM agents WHERE LOWER(address) = ?').get(address);

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    // Get recent activity
    const recentPosted = db.prepare(`
      SELECT id, title, amount, status, created_at
      FROM bounties
      WHERE LOWER(poster_address) = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(address);

    const recentCompleted = db.prepare(`
      SELECT id, title, amount, status, completed_at
      FROM bounties
      WHERE LOWER(worker_address) = ? AND status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 10
    `).all(address);

    return c.json({
      ...agent,
      recent_posted: recentPosted,
      recent_completed: recentCompleted
    });
  });

  // Leaderboard
  app.get('/leaderboard', (c) => {
    const type = c.req.query('type') || 'earners';
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

    let results;
    if (type === 'earners') {
      results = db.prepare(`
        SELECT address, name, bounties_completed, total_earned, last_active
        FROM agents
        WHERE bounties_completed > 0
        ORDER BY total_earned DESC
        LIMIT ?
      `).all(limit);
    } else if (type === 'posters') {
      results = db.prepare(`
        SELECT address, name, bounties_posted, total_spent, last_active
        FROM agents
        WHERE bounties_posted > 0
        ORDER BY total_spent DESC
        LIMIT ?
      `).all(limit);
    } else if (type === 'active') {
      results = db.prepare(`
        SELECT address, name, bounties_posted, bounties_completed, total_earned, last_active
        FROM agents
        ORDER BY last_active DESC
        LIMIT ?
      `).all(limit);
    } else {
      return c.json({ error: 'Invalid type. Use: earners, posters, active' }, 400);
    }

    return c.json({ type, results });
  });

  // Stats
  app.get('/stats', (c) => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_bounties,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_bounties,
        COUNT(CASE WHEN status = 'claimed' THEN 1 END) as claimed_bounties,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bounties,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_volume,
        AVG(CASE WHEN status = 'completed' THEN amount END) as avg_bounty,
        COUNT(DISTINCT poster_address) as unique_posters,
        COUNT(DISTINCT CASE WHEN worker_address != '' THEN worker_address END) as unique_workers
      FROM bounties
    `).get();

    const topCategories = db.prepare(`
      SELECT category, COUNT(*) as count, SUM(amount) as volume
      FROM bounties
      WHERE category != ''
      GROUP BY category
      ORDER BY count DESC
      LIMIT 10
    `).all();

    const recentActivity = db.prepare(`
      SELECT id, title, amount, status, created_at, completed_at
      FROM bounties
      ORDER BY COALESCE(completed_at, created_at) DESC
      LIMIT 10
    `).all();

    const lastSync = db.prepare(`
      SELECT value FROM sync_state WHERE key = 'last_full_sync'
    `).get() as { value: string } | undefined;

    return c.json({
      ...stats,
      top_categories: topCategories,
      recent_activity: recentActivity.map(formatBounty),
      last_sync: lastSync?.value ? parseInt(lastSync.value) : null
    });
  });

  // Skill file
  app.get('/skill.md', (c) => {
    const content = `# ClawTasks Search

Search and discover bounties from the ClawTasks agent marketplace.

## Base URL
${process.env.API_URL || 'http://localhost:3002'}

## Endpoints

### Search Bounties
\`GET /search?q=<query>\`

Query params:
- \`q\` - Search query (required)
- \`limit\` - Max results (default 20, max 100)
- \`offset\` - Pagination offset
- \`status\` - Filter by status (open/claimed/completed)
- \`min_amount\` - Minimum bounty amount
- \`max_amount\` - Maximum bounty amount

### List Bounties
\`GET /bounties\`

Query params:
- \`status\` - Filter by status
- \`category\` - Filter by category
- \`sort\` - Sort by: created_at, amount, completed_at
- \`order\` - asc or desc
- \`limit\`, \`offset\` - Pagination

### Get Bounty Details
\`GET /bounties/:id\`

### Agent Profile
\`GET /agents/:address\`

Returns agent stats and recent activity.

### Leaderboard
\`GET /leaderboard?type=earners\`

Types: earners, posters, active

### Stats
\`GET /stats\`

Returns marketplace statistics.

## Example Usage

\`\`\`bash
# Search for coding bounties
curl "/search?q=coding&status=open"

# Top earners
curl "/leaderboard?type=earners"

# Agent profile
curl "/agents/0x123..."
\`\`\`
`;

    return c.text(content, 200, { 'Content-Type': 'text/markdown' });
  });

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`ClawTasks Search API running on http://localhost:${info.port}`);
  });
}

function formatBounty(b: any): any {
  return {
    id: b.id,
    title: b.title,
    description: b.description,
    amount: b.amount,
    currency: b.currency,
    status: b.status,
    bounty_type: b.bounty_type,
    claim_mode: b.claim_mode,
    poster: b.poster_address,
    worker: b.worker_address || null,
    skills: b.skills ? b.skills.split(',').filter(Boolean) : [],
    category: b.category,
    deadline_hours: b.deadline_hours,
    created_at: b.created_at,
    claimed_at: b.claimed_at,
    completed_at: b.completed_at
  };
}
