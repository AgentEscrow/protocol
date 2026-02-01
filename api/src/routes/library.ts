/**
 * Public Deliverables Library
 * 
 * FREE to browse and search.
 * Completed work becomes discoverable by all agents.
 */

import { Hono } from 'hono';
import {
  getDb,
  createCitation,
  getCitationsForItem,
  getOrCreateReputation,
  getTopContributors,
  createLibraryItem,
  getLibraryItem,
  searchLibraryItems,
  getLibraryItems,
  getLibraryItemsByContributor,
  incrementLibraryAccess,
  getLibraryStats,
  updateReputation,
  type LibraryItemRow
} from '../services/db.js';
import { uploadToIPFS, fetchFromIPFS, hashContent } from '../services/ipfs.js';

export const libraryRoutes = new Hono();

// ============================================================
// DIRECT PUBLISH (no bounty required)
// ============================================================

/**
 * Publish work directly to the library
 * This is the main endpoint for agents to share their work
 */
libraryRoutes.post('/publish', async (c) => {
  const body = await c.req.json();
  const { from, title, description, deliverable, skills, category, license, source, source_id, source_url } = body;

  // Validate required fields
  if (!from) {
    return c.json({ error: 'Missing from address' }, 400);
  }
  if (!title || title.trim().length < 3) {
    return c.json({ error: 'Title required (min 3 characters)' }, 400);
  }

  // Validate license if provided
  const validLicenses = ['public-domain', 'attribution', 'non-commercial'];
  if (license && !validLicenses.includes(license)) {
    return c.json({ error: `Invalid license. Use: ${validLicenses.join(', ')}` }, 400);
  }

  // Validate category if provided
  const validCategories = ['coding', 'research', 'data', 'automation', 'integration', 'other'];
  const finalCategory = category && validCategories.includes(category) ? category : 'other';

  // Create the library item
  const item = createLibraryItem({
    contributor: from,
    title: title.trim(),
    description: description?.trim(),
    deliverable: deliverable,
    skills: Array.isArray(skills) ? skills : (skills ? [skills] : []),
    category: finalCategory,
    license: license || 'public-domain',
    sourceMarketplace: source,
    sourceId: source_id,
    sourceUrl: source_url
  });

  // Get updated reputation
  const reputation = getOrCreateReputation(from);

  return c.json({
    success: true,
    libraryId: item.id,
    libraryUrl: `/v2/library/${item.id}`,
    reputation: {
      earned: 25,
      newScore: reputation.reputation_score,
      tier: getContributorRank(reputation.reputation_score)
    },
    message: 'Published! Other agents can now find and cite your work.'
  });
});

// ============================================================
// SEARCH (FREE - no auth required)
// ============================================================

/**
 * Full-text search across ALL library items (direct + escrow-based)
 */
libraryRoutes.get('/search', async (c) => {
  const query = c.req.query('q');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const category = c.req.query('category');

  if (!query) {
    return c.json({ error: 'Missing q parameter' }, 400);
  }

  const db = getDb();
  const allResults: any[] = [];

  // Search direct library items
  try {
    let libSql = `
      SELECT
        li.id as id,
        'direct' as source,
        li.title,
        li.description,
        li.category,
        li.skills,
        li.license,
        li.deliverable_inline as deliverable,
        li.contributor,
        li.access_count as accessCount,
        li.citation_count as citationCount,
        li.created_at as createdAt
      FROM library_items li
      JOIN library_fts fts ON li.rowid = fts.rowid
      WHERE library_fts MATCH ?
    `;
    const libParams: any[] = [query];

    if (category) {
      libSql += ' AND li.category = ?';
      libParams.push(category);
    }

    const libResults = db.prepare(libSql).all(...libParams);
    allResults.push(...libResults);
  } catch (err) {
    // FTS might fail, continue with tasks search
  }

  // Search escrow-based items (tasks)
  try {
    let taskSql = `
      SELECT
        t.escrow_id as id,
        'escrow' as source,
        t.title,
        t.description,
        t.category,
        t.skills,
        t.license,
        t.deliverable_summary as deliverable,
        t.worker as contributor,
        t.access_count as accessCount,
        0 as citationCount,
        t.made_public_at as createdAt
      FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.is_public = 1
      AND tasks_fts MATCH ?
    `;
    const taskParams: any[] = [query];

    if (category) {
      taskSql += ' AND t.category = ?';
      taskParams.push(category);
    }

    const taskResults = db.prepare(taskSql).all(...taskParams);
    allResults.push(...taskResults);
  } catch (err) {
    // FTS might fail, continue
  }

  // Sort by recency and apply pagination
  allResults.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const total = allResults.length;
  const paginatedResults = allResults.slice(offset, offset + limit);

  return c.json({
    items: paginatedResults.map(formatSearchResult),
    total,
    query,
    limit,
    offset
  });
});

/**
 * Browse public deliverables with filters
 * Queries BOTH library_items (direct publishes) AND tasks (escrow-based)
 */
libraryRoutes.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const category = c.req.query('category');
  const skills = c.req.query('skills');
  const license = c.req.query('license');
  const sort = c.req.query('sort') || 'recent';

  const db = getDb();
  const allItems: any[] = [];

  // Query direct library items
  {
    const conditions: string[] = [];
    const params: any[] = [];

    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }
    if (skills) {
      conditions.push('skills LIKE ?');
      params.push(`%${skills}%`);
    }
    if (license) {
      conditions.push('license = ?');
      params.push(license);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const libItems = db.prepare(`
      SELECT
        id,
        'direct' as source,
        title,
        description,
        category,
        skills,
        license,
        deliverable_inline as deliverable,
        contributor,
        access_count as accessCount,
        citation_count as citationCount,
        created_at as createdAt
      FROM library_items
      ${where}
    `).all(...params);

    allItems.push(...libItems);
  }

  // Query escrow-based items
  {
    const conditions: string[] = ['is_public = 1'];
    const params: any[] = [];

    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }
    if (skills) {
      conditions.push('skills LIKE ?');
      params.push(`%${skills}%`);
    }
    if (license) {
      conditions.push('license = ?');
      params.push(license);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const taskItems = db.prepare(`
      SELECT
        escrow_id as id,
        'escrow' as source,
        title,
        description,
        category,
        skills,
        license,
        deliverable_summary as deliverable,
        worker as contributor,
        access_count as accessCount,
        0 as citationCount,
        made_public_at as createdAt
      FROM tasks
      ${where}
    `).all(...params);

    allItems.push(...taskItems);
  }

  // Sort
  switch (sort) {
    case 'popular':
      allItems.sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0));
      break;
    case 'recent':
    default:
      allItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // Paginate
  const total = allItems.length;
  const paginatedItems = allItems.slice(offset, offset + limit);

  return c.json({
    items: paginatedItems.map(formatBrowseResult),
    total,
    limit,
    offset
  });
});

/**
 * Library statistics (combined from direct + escrow publishes)
 */
libraryRoutes.get('/stats', async (c) => {
  const db = getDb();

  // Stats from escrow-based items
  const escrowStats = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(access_count), 0) as accesses,
      COUNT(DISTINCT worker) as contributors
    FROM tasks
    WHERE is_public = 1
  `).get() as { count: number; accesses: number; contributors: number };

  // Stats from direct library items
  const directStats = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(access_count), 0) as accesses,
      COUNT(DISTINCT contributor) as contributors
    FROM library_items
  `).get() as { count: number; accesses: number; contributors: number };

  // Combined stats
  const totalItems = (escrowStats?.count || 0) + (directStats?.count || 0);
  const totalAccesses = (escrowStats?.accesses || 0) + (directStats?.accesses || 0);
  const uniqueContributors = (escrowStats?.contributors || 0) + (directStats?.contributors || 0);

  // Top categories from both tables
  const topCategories = db.prepare(`
    SELECT category, SUM(cnt) as count FROM (
      SELECT category, COUNT(*) as cnt FROM tasks WHERE is_public = 1 AND category != '' GROUP BY category
      UNION ALL
      SELECT category, COUNT(*) as cnt FROM library_items WHERE category != '' GROUP BY category
    ) GROUP BY category ORDER BY count DESC LIMIT 10
  `).all();

  // Recently added (last 7 days)
  const weekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const recentEscrow = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE is_public = 1 AND made_public_at > ?
  `).get(weekAgo * 1000) as { count: number };
  const recentDirect = db.prepare(`
    SELECT COUNT(*) as count FROM library_items WHERE created_at > ?
  `).get(weekAgo) as { count: number };
  const recentlyAdded = (recentEscrow?.count || 0) + (recentDirect?.count || 0);

  return c.json({
    totalItems,
    totalAccesses,
    uniqueContributors,
    directPublishes: directStats?.count || 0,
    escrowPublishes: escrowStats?.count || 0,
    topCategories,
    recentlyAdded
  });
});

// ============================================================
// CONTRIBUTORS (must come before /:escrowId)
// ============================================================

/**
 * Get leaderboard of top contributors
 */
libraryRoutes.get('/contributors/top', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const contributors = getTopContributors(limit);

  return c.json({
    contributors: contributors.map((rep, index) => ({
      rank: index + 1,
      address: rep.address,
      score: rep.reputation_score,
      citationsReceived: rep.citations_received,
      bountiesCompleted: rep.bounties_completed,
      itemsPublished: rep.items_published,
      tier: getContributorRank(rep.reputation_score)
    }))
  });
});

/**
 * Get contributor profile and reputation
 */
libraryRoutes.get('/contributor/:address', async (c) => {
  const address = c.req.param('address').toLowerCase();
  const db = getDb();

  // Get reputation
  const reputation = getOrCreateReputation(address);

  // Get their published items
  const items = db.prepare(`
    SELECT escrow_id as escrowId, title, category, skills, access_count as accessCount, made_public_at as publishedAt
    FROM tasks
    WHERE worker = ? AND is_public = 1
    ORDER BY made_public_at DESC
    LIMIT 20
  `).all(address);

  return c.json({
    address,
    reputation: {
      score: reputation.reputation_score,
      citationsReceived: reputation.citations_received,
      bountiesCompleted: reputation.bounties_completed,
      bountiesPosted: reputation.bounties_posted,
      itemsPublished: reputation.items_published
    },
    items: items.map(formatLibraryItem),
    rank: getContributorRank(reputation.reputation_score)
  });
});

/**
 * Get single deliverable details (increments access count)
 * Handles both direct publishes (lib_*) and escrow-based items
 */
libraryRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  // Check if it's a direct publish (lib_*) or escrow-based
  if (id.startsWith('lib_')) {
    // Direct library item
    const item = getLibraryItem(id);
    if (!item) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Increment access count
    incrementLibraryAccess(id);

    // Get contributor reputation
    const reputation = getOrCreateReputation(item.contributor);

    return c.json({
      id: item.id,
      source: 'direct',
      title: item.title,
      description: item.description,
      category: item.category,
      skills: parseSkills(item.skills),
      license: item.license,
      contributor: item.contributor,
      contributorReputation: {
        score: reputation.reputation_score,
        tier: getContributorRank(reputation.reputation_score)
      },
      deliverable: item.deliverable_inline,
      accessCount: item.access_count + 1,
      citationCount: item.citation_count,
      createdAt: item.created_at
    });
  }

  // Escrow-based item
  const item = db.prepare(`
    SELECT
      escrow_id as escrowId, title, description, category, skills,
      amount, token, license, deliverable_summary as deliverableSummary,
      evidence_hash as evidenceHash, client, worker, completed_at as completedAt,
      made_public_at as madePublicAt, access_count as accessCount,
      success_criteria as successCriteria, deliverables
    FROM tasks
    WHERE escrow_id = ? AND is_public = 1
  `).get(id) as any;

  if (!item) {
    return c.json({ error: 'Not found or not public' }, 404);
  }

  // Increment access count
  db.prepare(`
    UPDATE tasks SET access_count = access_count + 1
    WHERE escrow_id = ?
  `).run(id);

  // Fetch full deliverable content if small enough
  let deliverableContent = null;
  if (item.evidenceHash) {
    try {
      const content = await fetchFromIPFS(item.evidenceHash);
      if (content && content.length < 50000) {
        deliverableContent = content;
      }
    } catch (err) {
      // Ignore fetch errors
    }
  }

  // Get contributor reputation
  const reputation = item.worker ? getOrCreateReputation(item.worker) : null;

  return c.json({
    id: item.escrowId,
    source: 'escrow',
    ...formatLibraryItem(item),
    contributorReputation: reputation ? {
      score: reputation.reputation_score,
      tier: getContributorRank(reputation.reputation_score)
    } : null,
    successCriteria: item.successCriteria,
    deliverables: item.deliverables ? JSON.parse(item.deliverables) : [],
    deliverableContent,
    rawEvidenceHash: item.evidenceHash
  });
});

// ============================================================
// PUBLISH (requires completed escrow)
// ============================================================

/**
 * Publish completed work to the library
 */
libraryRoutes.post('/:escrowId/publish', async (c) => {
  const escrowId = c.req.param('escrowId');
  const body = await c.req.json();
  const { from, license, summary } = body;

  if (!from) {
    return c.json({ error: 'Missing from address' }, 400);
  }
  if (!license || !['public-domain', 'attribution', 'non-commercial'].includes(license)) {
    return c.json({ error: 'Invalid license. Use: public-domain, attribution, non-commercial' }, 400);
  }

  const db = getDb();

  // Get the task
  const task = db.prepare(`
    SELECT escrow_id, client, worker, state, is_public, description
    FROM tasks WHERE escrow_id = ?
  `).get(escrowId) as any;

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  // Must be completed (Resolved state)
  if (task.state !== 'Resolved') {
    return c.json({ error: 'Task must be completed before publishing' }, 400);
  }

  // Must be client or worker
  const fromLower = from.toLowerCase();
  if (task.client?.toLowerCase() !== fromLower && task.worker?.toLowerCase() !== fromLower) {
    return c.json({ error: 'Only client or worker can publish' }, 403);
  }

  // Already public?
  if (task.is_public) {
    return c.json({ error: 'Already published' }, 400);
  }

  // Update task
  db.prepare(`
    UPDATE tasks SET
      is_public = 1,
      license = ?,
      deliverable_summary = ?,
      made_public_at = ?
    WHERE escrow_id = ?
  `).run(license, summary || task.description, Date.now(), escrowId);

  return c.json({
    success: true,
    escrowId,
    license,
    libraryUrl: `/v2/library/${escrowId}`
  });
});

// ============================================================
// CITATIONS
// ============================================================

/**
 * Cite/use a library item (records usage, boosts contributor reputation)
 */
libraryRoutes.post('/:escrowId/cite', async (c) => {
  const escrowId = c.req.param('escrowId');
  const body = await c.req.json();
  const { from, context } = body;

  if (!from) {
    return c.json({ error: 'Missing from address' }, 400);
  }

  const db = getDb();

  // Check item exists and is public
  const item = db.prepare('SELECT escrow_id, worker, is_public FROM tasks WHERE escrow_id = ?')
    .get(escrowId) as any;

  if (!item || !item.is_public) {
    return c.json({ error: 'Item not found or not public' }, 404);
  }

  // Create citation
  const citation = createCitation(escrowId, from, context);

  return c.json({
    success: true,
    citation: {
      id: citation.id,
      libraryId: escrowId,
      citedBy: from,
      context: citation.context,
      contributor: item.worker,
      message: `Thank you for citing this work! ${item.worker} earned +10 reputation.`
    }
  });
});

/**
 * Get citations for a library item
 */
libraryRoutes.get('/:escrowId/citations', async (c) => {
  const escrowId = c.req.param('escrowId');
  const citations = getCitationsForItem(escrowId);

  return c.json({
    escrowId,
    citations: citations.map(cite => ({
      id: cite.id,
      citedBy: cite.cited_by,
      context: cite.context,
      createdAt: cite.created_at
    })),
    total: citations.length
  });
});

// ============================================================
// HELPERS
// ============================================================

function getContributorRank(score: number): string {
  if (score >= 1000) return 'legendary';
  if (score >= 500) return 'expert';
  if (score >= 200) return 'contributor';
  if (score >= 50) return 'member';
  return 'newcomer';
}

function parseSkills(skills: any): string[] {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills;
  if (typeof skills === 'string') {
    if (skills.startsWith('[')) {
      try {
        return JSON.parse(skills);
      } catch {
        return skills.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    return skills.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function formatSearchResult(item: any) {
  return {
    id: item.id,
    source: item.source, // 'direct' or 'escrow'
    title: item.title,
    description: item.description,
    category: item.category,
    skills: parseSkills(item.skills),
    license: item.license,
    contributor: item.contributor,
    accessCount: item.accessCount || 0,
    citationCount: item.citationCount || 0,
    createdAt: item.createdAt,
    libraryUrl: item.source === 'direct' ? `/v2/library/${item.id}` : `/v2/library/${item.id}`
  };
}

function formatBrowseResult(item: any) {
  return {
    id: item.id,
    source: item.source, // 'direct' or 'escrow'
    title: item.title,
    description: item.description,
    category: item.category,
    skills: parseSkills(item.skills),
    license: item.license,
    contributor: item.contributor,
    accessCount: item.accessCount || 0,
    citationCount: item.citationCount || 0,
    createdAt: item.createdAt,
    libraryUrl: `/v2/library/${item.id}`
  };
}

function formatLibraryItem(item: any) {
  // Handle skills - could be JSON array string or comma-separated
  let skills: string[] = [];
  if (item.skills) {
    if (item.skills.startsWith('[')) {
      try {
        skills = JSON.parse(item.skills);
      } catch {
        skills = item.skills.split(',').filter(Boolean);
      }
    } else {
      skills = item.skills.split(',').filter(Boolean);
    }
  }

  return {
    escrowId: item.escrowId,
    title: item.title,
    description: item.description,
    category: item.category,
    skills,
    amount: item.amount,
    token: item.token,
    license: item.license,
    summary: item.deliverableSummary,
    evidenceUri: item.evidenceHash ?
      (item.evidenceHash.startsWith('ipfs://') ?
        `https://gateway.pinata.cloud/ipfs/${item.evidenceHash.replace('ipfs://', '')}` :
        item.evidenceHash) :
      null,
    contributor: item.worker,
    client: item.client,
    completedAt: item.completedAt,
    publishedAt: item.madePublicAt,
    accessCount: item.accessCount || 0
  };
}
