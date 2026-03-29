const crypto = require('crypto');
const path = require('path');
const db = require('./db');

// Constants
const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || path.resolve(__dirname, '../..');
const UNIFIED_PATH = path.join(WORKSPACE, 'memory/unified-constellation.json'); // kept for compat
const MEMORY_DIR = path.join(WORKSPACE, 'memory');

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

function generateStableId(text) {
  // Generate stable 8-char hash from content
  return crypto.createHash('sha256').update(text.trim()).digest('hex').substring(0, 8);
}

/**
 * Load brain from SQLite.
 * Returns the same structure as the old JSON-based loadBrain() for full compatibility.
 */
function loadBrain() {
  const sqliteDb = db.getDb();

  // Load meta
  const version = parseInt(db.getMeta('version') || '2');
  const lastUpdated = db.getMeta('lastUpdated') || new Date().toISOString();
  const lastTracked = db.getMeta('lastTracked') || new Date().toISOString();
  const totalQueriesTracked = parseInt(db.getMeta('totalQueriesTracked') || '0');

  // Load all nodes with usage, feedback, and embeddings (joined in one query)
  const nodeRows = sqliteDb.prepare(`
    SELECT n.*,
           u.hits, u.referenced, u.stability, u.last_used, u.first_seen,
           u.recall_intervals, u.query_appearances,
           f.good, f.bad,
           e.vector
    FROM nodes n
    LEFT JOIN node_usage u ON n.id = u.node_id
    LEFT JOIN node_feedback f ON n.id = f.node_id
    LEFT JOIN embeddings e ON n.id = e.node_id
  `).all();

  const nodes = nodeRows.map(db.rowToNode);

  // Load edges
  const edges = db.getAllEdges();

  // Load episodes
  const episodes = db.getEpisodes();

  // Load query misses
  const queryMisses = db.getQueryMisses(50);

  return {
    version,
    lastUpdated,
    lastTracked,
    totalQueriesTracked,
    nodes,
    edges,
    episodes,
    queryMisses,
  };
}

/**
 * Save brain back to SQLite.
 * Upserts all nodes, edges, episodes, and meta in a single transaction.
 */
function saveBrain(brain) {
  const now = new Date().toISOString();

  db.transaction(() => {
    // Update meta
    db.setMeta('version', String(brain.version || 2));
    db.setMeta('lastUpdated', now);
    db.setMeta('lastTracked', brain.lastTracked || now);
    db.setMeta('totalQueriesTracked', String(brain.totalQueriesTracked || 0));

    // Upsert all nodes
    for (const node of brain.nodes) {
      db.upsertNode(node);
    }

    // Full edge replacement: delete all edges then re-insert from brain.
    // This is safe (single-threaded Node.js, inside a transaction) and avoids
    // the hits double-counting bug that would occur with upsertEdge.
    // Note: tracking.js inserts new co_recall edges AFTER saveBrain() is called,
    // so they will be picked up by the next loadBrain().
    const sqliteDb = db.getDb();

    const deleteAllEdges = sqliteDb.prepare('DELETE FROM edges');
    const insertEdge = sqliteDb.prepare(`
      INSERT OR IGNORE INTO edges
        (source, target, type, weight, shared_entities, relationships, metadata, hits, last_used, tuning_boosts, tuning_decays)
      VALUES
        (@source, @target, @type, @weight, @shared_entities, @relationships, @metadata, @hits, @last_used, @tuning_boosts, @tuning_decays)
    `);

    deleteAllEdges.run();

    for (const edge of brain.edges) {
      const tuning = edge.tuningStats || {};
      const usage = edge.usage || {};
      insertEdge.run({
        source: edge.source,
        target: edge.target,
        type: edge.type || '',
        weight: edge.weight != null ? edge.weight : 0.5,
        shared_entities: edge.sharedEntities ? JSON.stringify(edge.sharedEntities) : null,
        relationships: edge.relationships ? JSON.stringify(edge.relationships) : null,
        metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
        hits: usage.hits || 0,
        last_used: usage.lastUsed || null,
        tuning_boosts: tuning.boosts || 0,
        tuning_decays: tuning.decays || 0,
      });
    }

    // Upsert episodes
    for (const ep of (brain.episodes || [])) {
      db.upsertEpisode(ep);
    }

    // Note: query_misses are managed directly via db.addQueryMiss() in search.js
    // No need to handle them here to avoid count drift issues
  });
}

// Build adjacency map for fast traversal (FIX 8)
function buildAdjacencyMap(brain) {
  const adj = new Map();
  brain.edges.forEach(e => {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push({ id: e.target, weight: e.weight || 1 });
    adj.get(e.target).push({ id: e.source, weight: e.weight || 1 });
  });
  return adj;
}

function isCore(node) { return node.tier === 'core' || node.tier === 'singularity'; }
function isSingularity(node) { return node.tier === 'singularity'; }

/**
 * Protected nodes — never archive, prune, or merge away.
 * Covers: core/singularity, curated files, and content matching protected terms.
 */
const PROTECTED_SOURCE_FILES = ['MEMORY.md', 'TOOLS.md', 'USER.md', 'SOUL.md'];
const PROTECTED_TERMS = [
  // Family
  'milana', 'daughter', 'wife', 'family', 'parenting', 'child',
  // Health  
  'health', 'weight', 'bmi', 'panic', 'anxiety', 'sleep', 'obesity',
  'blood pressure', 'doctor', 'medical', 'medication', 'exercise',
  'kg', 'fitness',
];

function isProtected(node) {
  if (!node) return false;
  if (node.core) return true;
  if (isCore(node)) return true;
  if (PROTECTED_SOURCE_FILES.includes(node.sourceFile || '')) return true;
  
  const text = ((node.distilled || '') + ' ' + (node.text || '')).toLowerCase();
  return PROTECTED_TERMS.some(term => text.includes(term));
}

function truncateText(text, maxLength) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength 
    ? cleaned.substring(0, maxLength) + '...'
    : cleaned;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  WORKSPACE,
  UNIFIED_PATH,
  MEMORY_DIR,
  generateStableId,
  loadBrain,
  saveBrain,
  buildAdjacencyMap,
  isCore,
  isSingularity,
  isProtected,
  PROTECTED_TERMS,
  truncateText,
  sleep
};
