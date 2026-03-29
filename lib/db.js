/**
 * lib/db.js
 * SQLite schema + accessor layer for the constellation memory system.
 * Replaces unified-constellation.json with constellation.db
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || path.resolve(__dirname, '../..');
const DB_PATH = path.join(WORKSPACE, 'memory/constellation.db');

let _db = null;

// ============================================================================
// VECTOR BLOB SERIALIZATION
// ============================================================================

/**
 * Convert a JS number array (embedding) to a Buffer (Float32Array binary)
 * 1024 dims × 4 bytes = 4096 bytes per node
 */
function vectorToBlob(vector) {
  if (!vector || vector.length === 0) return null;
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buf.writeFloatLE(vector[i], i * 4);
  }
  return buf;
}

/**
 * Convert a Buffer (Float32Array binary) back to a JS number array
 */
function blobToVector(blob) {
  if (!blob || blob.length === 0) return [];
  const len = blob.length / 4;
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = blob.readFloatLE(i * 4);
  }
  return result;
}

// ============================================================================
// DB SINGLETON + SCHEMA
// ============================================================================

function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH);

  // WAL mode for concurrent reads
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = OFF'); // OFF for performance; we handle referential integrity in app

  _db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      text TEXT,
      distilled TEXT,
      category TEXT,
      source_file TEXT,
      tags TEXT,                   -- JSON array
      tier TEXT DEFAULT 'synapse',
      parent_id TEXT,
      extracted_entities TEXT,     -- JSON object
      conflicts TEXT,              -- JSON array
      merged_into TEXT,
      raptor_level INTEGER,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS node_usage (
      node_id TEXT PRIMARY KEY,
      hits INTEGER DEFAULT 0,
      referenced INTEGER DEFAULT 0,
      stability REAL DEFAULT 1.0,
      last_used TEXT,
      first_seen TEXT,
      recall_intervals TEXT,       -- JSON array
      query_appearances INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS node_feedback (
      node_id TEXT PRIMARY KEY,
      good INTEGER DEFAULT 0,
      bad INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      node_id TEXT PRIMARY KEY,
      vector BLOB
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',   -- '' for classic edges (NULL-safe unique)
      weight REAL DEFAULT 0.5,
      shared_entities TEXT,            -- JSON array
      relationships TEXT,              -- JSON array
      metadata TEXT,                   -- JSON object
      hits INTEGER DEFAULT 0,
      last_used TEXT,
      tuning_boosts INTEGER DEFAULT 0,
      tuning_decays INTEGER DEFAULT 0,
      UNIQUE(source, target, type)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id TEXT UNIQUE,
      theme TEXT,
      timespan_start TEXT,
      timespan_end TEXT,
      events TEXT,                     -- JSON array
      node_ids TEXT,                   -- JSON array (optional)
      created_at TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS query_misses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT,
      timestamp TEXT,
      top_score REAL,
      result_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash TEXT PRIMARY KEY,
      vector BLOB,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_source   ON nodes(source_file);
    CREATE INDEX IF NOT EXISTS idx_nodes_tier     ON nodes(tier);
    CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent   ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_edges_source   ON edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target   ON edges(target);
    CREATE INDEX IF NOT EXISTS idx_edges_type     ON edges(type);
    CREATE INDEX IF NOT EXISTS idx_usage_hits     ON node_usage(hits DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_last     ON node_usage(last_used);
  `);

  return _db;
}

// ============================================================================
// META
// ============================================================================

function getMeta(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

// ============================================================================
// NODE SERIALIZATION HELPERS
// ============================================================================

function rowToNode(row) {
  const node = {
    id: row.id,
    text: row.text,
    distilled: row.distilled || undefined,
    category: row.category || undefined,
    sourceFile: row.source_file || undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    tier: row.tier || 'synapse',
    parentId: row.parent_id || undefined,
    extractedEntities: row.extracted_entities ? JSON.parse(row.extracted_entities) : undefined,
    conflicts: row.conflicts ? JSON.parse(row.conflicts) : undefined,
    mergedInto: row.merged_into || undefined,
    raptorLevel: row.raptor_level || undefined,
    createdAt: row.created_at || undefined,
  };

  // Usage (from join or separate query)
  node.usage = {
    hits: row.hits || 0,
    referenced: row.referenced || 0,
    stability: row.stability != null ? row.stability : 1.0,
    lastUsed: row.last_used || null,
    firstSeen: row.first_seen || new Date().toISOString(),
    recallIntervals: row.recall_intervals ? JSON.parse(row.recall_intervals) : [],
    queryAppearances: row.query_appearances || 0,
  };

  // Feedback
  if (row.good != null || row.bad != null) {
    node.feedback = {
      good: row.good || 0,
      bad: row.bad || 0,
    };
  }

  // Embedding
  if (row.vector) {
    node.embedding = blobToVector(row.vector);
  }

  return node;
}

function nodeToRow(node) {
  return {
    id: node.id,
    text: node.text || null,
    distilled: node.distilled || null,
    category: node.category || null,
    source_file: node.sourceFile || null,
    tags: node.tags ? JSON.stringify(node.tags) : null,
    tier: node.tier || 'synapse',
    parent_id: node.parentId || null,
    extracted_entities: node.extractedEntities ? JSON.stringify(node.extractedEntities) : null,
    conflicts: node.conflicts && node.conflicts.length > 0 ? JSON.stringify(node.conflicts) : null,
    merged_into: node.mergedInto || null,
    raptor_level: node.raptorLevel || null,
    created_at: (node.usage && node.usage.firstSeen) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ============================================================================
// NODE QUERIES
// ============================================================================

const NODE_WITH_EVERYTHING = `
  SELECT n.*,
         u.hits, u.referenced, u.stability, u.last_used, u.first_seen, u.recall_intervals, u.query_appearances,
         f.good, f.bad,
         e.vector
  FROM nodes n
  LEFT JOIN node_usage u ON n.id = u.node_id
  LEFT JOIN node_feedback f ON n.id = f.node_id
  LEFT JOIN embeddings e ON n.id = e.node_id
`;

const NODE_WITHOUT_EMBEDDINGS = `
  SELECT n.*,
         u.hits, u.referenced, u.stability, u.last_used, u.first_seen, u.recall_intervals, u.query_appearances,
         f.good, f.bad
  FROM nodes n
  LEFT JOIN node_usage u ON n.id = u.node_id
  LEFT JOIN node_feedback f ON n.id = f.node_id
`;

function getNode(id) {
  const db = getDb();
  const row = db.prepare(NODE_WITH_EVERYTHING + ' WHERE n.id = ?').get(id);
  return row ? rowToNode(row) : null;
}

function getNodes() {
  const db = getDb();
  const rows = db.prepare(NODE_WITHOUT_EMBEDDINGS).all();
  return rows.map(rowToNode);
}

function getNodesWithEmbeddings() {
  const db = getDb();
  const rows = db.prepare(NODE_WITH_EVERYTHING + ' WHERE e.vector IS NOT NULL').all();
  return rows.map(rowToNode);
}

// ============================================================================
// NODE WRITES
// ============================================================================

const _upsertNodeStmt = () => {
  const db = getDb();
  return db.prepare(`
    INSERT INTO nodes (id, text, distilled, category, source_file, tags, tier, parent_id,
                       extracted_entities, conflicts, merged_into, raptor_level, created_at, updated_at)
    VALUES (@id, @text, @distilled, @category, @source_file, @tags, @tier, @parent_id,
            @extracted_entities, @conflicts, @merged_into, @raptor_level, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      text               = excluded.text,
      distilled          = excluded.distilled,
      category           = excluded.category,
      source_file        = excluded.source_file,
      tags               = excluded.tags,
      tier               = excluded.tier,
      parent_id          = excluded.parent_id,
      extracted_entities = excluded.extracted_entities,
      conflicts          = excluded.conflicts,
      merged_into        = excluded.merged_into,
      raptor_level       = excluded.raptor_level,
      updated_at         = excluded.updated_at
  `);
};

const _upsertUsageStmt = () => {
  const db = getDb();
  return db.prepare(`
    INSERT INTO node_usage (node_id, hits, referenced, stability, last_used, first_seen, recall_intervals, query_appearances)
    VALUES (@node_id, @hits, @referenced, @stability, @last_used, @first_seen, @recall_intervals, @query_appearances)
    ON CONFLICT(node_id) DO UPDATE SET
      hits               = excluded.hits,
      referenced         = excluded.referenced,
      stability          = excluded.stability,
      last_used          = excluded.last_used,
      first_seen         = excluded.first_seen,
      recall_intervals   = excluded.recall_intervals,
      query_appearances  = excluded.query_appearances
  `);
};

const _upsertFeedbackStmt = () => {
  const db = getDb();
  return db.prepare(`
    INSERT INTO node_feedback (node_id, good, bad)
    VALUES (@node_id, @good, @bad)
    ON CONFLICT(node_id) DO UPDATE SET
      good = excluded.good,
      bad  = excluded.bad
  `);
};

function upsertNode(node) {
  const db = getDb();
  const row = nodeToRow(node);
  _upsertNodeStmt().run(row);

  // Usage
  const usage = node.usage || {};
  _upsertUsageStmt().run({
    node_id: node.id,
    hits: usage.hits || 0,
    referenced: usage.referenced || 0,
    stability: usage.stability != null ? usage.stability : 1.0,
    last_used: usage.lastUsed || null,
    first_seen: usage.firstSeen || new Date().toISOString(),
    recall_intervals: usage.recallIntervals ? JSON.stringify(usage.recallIntervals) : '[]',
    query_appearances: usage.queryAppearances || 0,
  });

  // Feedback (only if present)
  if (node.feedback) {
    _upsertFeedbackStmt().run({
      node_id: node.id,
      good: node.feedback.good || 0,
      bad: node.feedback.bad || 0,
    });
  }

  // Embedding (only if present)
  if (node.embedding && node.embedding.length > 0) {
    setEmbedding(node.id, node.embedding);
  }
}

// Fast path: update only usage fields (for tracking without full save)
function updateNodeUsage(nodeId, usage) {
  const db = getDb();
  db.prepare(`
    INSERT INTO node_usage (node_id, hits, referenced, stability, last_used, first_seen, recall_intervals, query_appearances)
    VALUES (@node_id, @hits, @referenced, @stability, @last_used, @first_seen, @recall_intervals, @query_appearances)
    ON CONFLICT(node_id) DO UPDATE SET
      hits              = excluded.hits,
      referenced        = excluded.referenced,
      stability         = excluded.stability,
      last_used         = excluded.last_used,
      recall_intervals  = excluded.recall_intervals,
      query_appearances = excluded.query_appearances
  `).run({
    node_id: nodeId,
    hits: usage.hits || 0,
    referenced: usage.referenced || 0,
    stability: usage.stability != null ? usage.stability : 1.0,
    last_used: usage.lastUsed || null,
    first_seen: usage.firstSeen || null,
    recall_intervals: usage.recallIntervals ? JSON.stringify(usage.recallIntervals) : '[]',
    query_appearances: usage.queryAppearances || 0,
  });
}

// ============================================================================
// EMBEDDING QUERIES
// ============================================================================

function getEmbedding(nodeId) {
  const db = getDb();
  const row = db.prepare('SELECT vector FROM embeddings WHERE node_id = ?').get(nodeId);
  if (!row || !row.vector) return null;
  return blobToVector(row.vector);
}

function setEmbedding(nodeId, vector) {
  const db = getDb();
  const blob = vectorToBlob(vector);
  db.prepare(`
    INSERT INTO embeddings (node_id, vector) VALUES (?, ?)
    ON CONFLICT(node_id) DO UPDATE SET vector = excluded.vector
  `).run(nodeId, blob);
}

// ============================================================================
// EDGE QUERIES
// ============================================================================

function rowToEdge(row) {
  const edge = {
    source: row.source,
    target: row.target,
    type: row.type || undefined,  // '' → undefined for compat
    weight: row.weight != null ? row.weight : 0.5,
    sharedEntities: row.shared_entities ? JSON.parse(row.shared_entities) : undefined,
    relationships: row.relationships ? JSON.parse(row.relationships) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    usage: {
      hits: row.hits || 0,
      lastUsed: row.last_used || null,
    },
  };

  if (row.tuning_boosts > 0 || row.tuning_decays > 0) {
    edge.tuningStats = {
      boosts: row.tuning_boosts || 0,
      decays: row.tuning_decays || 0,
    };
  }

  return edge;
}

function edgeToRow(edge) {
  const tuning = edge.tuningStats || {};
  // Handle legacy edge.usage.hits mapping to column hits
  const usageHits = (edge.usage && edge.usage.hits) ? edge.usage.hits : 0;
  const usageLastUsed = (edge.usage && edge.usage.lastUsed) ? edge.usage.lastUsed : null;
  return {
    source: edge.source,
    target: edge.target,
    type: edge.type || '',
    weight: edge.weight != null ? edge.weight : 0.5,
    shared_entities: edge.sharedEntities ? JSON.stringify(edge.sharedEntities) : null,
    relationships: edge.relationships ? JSON.stringify(edge.relationships) : null,
    metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
    hits: usageHits,
    last_used: usageLastUsed,
    tuning_boosts: tuning.boosts || 0,
    tuning_decays: tuning.decays || 0,
  };
}

function getAllEdges() {
  const db = getDb();
  return db.prepare('SELECT * FROM edges').all().map(rowToEdge);
}

function getEdges(nodeId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM edges WHERE source = ? OR target = ?').all(nodeId, nodeId);
  return rows.map(rowToEdge);
}

function upsertEdge(edge) {
  const db = getDb();
  const row = edgeToRow(edge);
  db.prepare(`
    INSERT INTO edges (source, target, type, weight, shared_entities, relationships, metadata, hits, last_used, tuning_boosts, tuning_decays)
    VALUES (@source, @target, @type, @weight, @shared_entities, @relationships, @metadata, @hits, @last_used, @tuning_boosts, @tuning_decays)
    ON CONFLICT(source, target, type) DO UPDATE SET
      weight          = MAX(excluded.weight, weight),
      shared_entities = COALESCE(excluded.shared_entities, shared_entities),
      relationships   = COALESCE(excluded.relationships, relationships),
      metadata        = COALESCE(excluded.metadata, metadata),
      hits            = hits + excluded.hits,
      last_used       = COALESCE(excluded.last_used, last_used),
      tuning_boosts   = tuning_boosts + excluded.tuning_boosts,
      tuning_decays   = tuning_decays + excluded.tuning_decays
  `).run(row);
}

function updateEdge(source, target, type, updates) {
  const db = getDb();
  const t = type || '';
  db.prepare(`
    UPDATE edges SET
      weight        = @weight,
      hits          = @hits,
      last_used     = @last_used,
      tuning_boosts = @tuning_boosts,
      tuning_decays = @tuning_decays
    WHERE source = @source AND target = @target AND type = @type
  `).run({
    source, target, type: t,
    weight: updates.weight,
    hits: updates.hits,
    last_used: updates.lastUsed,
    tuning_boosts: updates.tuningBoosts || 0,
    tuning_decays: updates.tuningDecays || 0,
  });
}

function deleteEdges(filter) {
  const db = getDb();
  if (filter && filter.type) {
    db.prepare('DELETE FROM edges WHERE type = ?').run(filter.type);
  } else if (filter && filter.source) {
    db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(filter.source, filter.source);
  }
}

function findEdge(source, target, type) {
  const db = getDb();
  const t = type || '';
  // Check both directions
  const row = db.prepare(
    'SELECT * FROM edges WHERE ((source = ? AND target = ?) OR (source = ? AND target = ?)) AND type = ?'
  ).get(source, target, target, source, t);
  return row ? rowToEdge(row) : null;
}

function addQueryMissDb(miss) {
  const db = getDb();
  db.prepare(
    'INSERT INTO query_misses (query, timestamp, top_score, result_count) VALUES (?, ?, ?, ?)'
  ).run(miss.query, miss.timestamp, miss.topScore, miss.resultCount);

  // Keep only last 50
  db.prepare(`
    DELETE FROM query_misses WHERE id NOT IN (
      SELECT id FROM query_misses ORDER BY id DESC LIMIT 50
    )
  `).run();
}

// ============================================================================
// EPISODES
// ============================================================================

function getEpisodes() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM episodes').all();
  return rows.map(row => ({
    id: row.episode_id,
    theme: row.theme,
    timespan: {
      start: row.timespan_start,
      end: row.timespan_end,
    },
    events: row.events ? JSON.parse(row.events) : [],
    createdAt: row.created_at,
    sourceFile: row.source_file,
  }));
}

function addEpisode(episode) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO episodes (episode_id, theme, timespan_start, timespan_end, events, created_at, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    episode.id || null,
    episode.theme || null,
    episode.timespan ? episode.timespan.start : null,
    episode.timespan ? episode.timespan.end : null,
    episode.events ? JSON.stringify(episode.events) : '[]',
    episode.createdAt || new Date().toISOString(),
    episode.sourceFile || null,
  );
}

function upsertEpisode(episode) {
  const db = getDb();
  db.prepare(`
    INSERT INTO episodes (episode_id, theme, timespan_start, timespan_end, events, created_at, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(episode_id) DO UPDATE SET
      theme           = excluded.theme,
      timespan_start  = excluded.timespan_start,
      timespan_end    = excluded.timespan_end,
      events          = excluded.events,
      created_at      = excluded.created_at,
      source_file     = excluded.source_file
  `).run(
    episode.id || null,
    episode.theme || null,
    episode.timespan ? episode.timespan.start : null,
    episode.timespan ? episode.timespan.end : null,
    episode.events ? JSON.stringify(episode.events) : '[]',
    episode.createdAt || new Date().toISOString(),
    episode.sourceFile || null,
  );
}

// ============================================================================
// QUERY MISSES
// ============================================================================

function getQueryMisses(limit = 50) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM query_misses ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(row => ({
    query: row.query,
    timestamp: row.timestamp,
    topScore: row.top_score,
    resultCount: row.result_count,
  })).reverse();
}

function addQueryMiss(miss) {
  const db = getDb();
  db.prepare(
    'INSERT INTO query_misses (query, timestamp, top_score, result_count) VALUES (?, ?, ?, ?)'
  ).run(miss.query, miss.timestamp, miss.topScore || 0, miss.resultCount || 0);

  // Keep only last 50
  db.prepare(`
    DELETE FROM query_misses WHERE id NOT IN (
      SELECT id FROM query_misses ORDER BY id DESC LIMIT 50
    )
  `).run();
}

// ============================================================================
// EMBEDDING CACHE
// ============================================================================

function getCachedEmbedding(text) {
  const db = getDb();
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const row = db.prepare('SELECT vector FROM embedding_cache WHERE text_hash = ?').get(hash);
  if (!row || !row.vector) return null;
  return blobToVector(row.vector);
}

function setCachedEmbedding(text, vector) {
  const db = getDb();
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const blob = vectorToBlob(vector);
  db.prepare(`
    INSERT OR REPLACE INTO embedding_cache (text_hash, vector, created_at) VALUES (?, ?, ?)
  `).run(hash, blob, new Date().toISOString());
}

// ============================================================================
// TRANSACTION WRAPPER
// ============================================================================

function transaction(fn) {
  const db = getDb();
  return db.transaction(fn)();
}

// ============================================================================
// STATS HELPERS (direct SQL aggregations)
// ============================================================================

function getNodeCounts() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as n FROM nodes').get().n;
  const active = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE merged_into IS NULL").get().n;
  const merged = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE merged_into IS NOT NULL").get().n;
  const distilled = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE distilled IS NOT NULL AND distilled != '' AND merged_into IS NULL").get().n;
  const embedded = db.prepare("SELECT COUNT(*) as n FROM embeddings").get().n;
  const extracted = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE extracted_entities IS NOT NULL AND merged_into IS NULL").get().n;

  const tierCounts = {};
  const tiers = db.prepare("SELECT tier, COUNT(*) as n FROM nodes WHERE merged_into IS NULL GROUP BY tier").all();
  tiers.forEach(r => { tierCounts[r.tier] = r.n; });

  const catCounts = {};
  const cats = db.prepare("SELECT category, COUNT(*) as n FROM nodes WHERE merged_into IS NULL GROUP BY category").all();
  cats.forEach(r => { catCounts[r.category || 'unknown'] = r.n; });

  return { total, active, merged, distilled, embedded, extracted, tierCounts, catCounts };
}

function getEdgeCounts() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as n FROM edges').get().n;
  const typed = db.prepare("SELECT COUNT(*) as n FROM edges WHERE type != ''").get().n;
  const classic = db.prepare("SELECT COUNT(*) as n FROM edges WHERE type = ''").get().n;
  const inferred = db.prepare("SELECT COUNT(*) as n FROM edges WHERE type = 'inferred_transitive'").get().n;
  return { total, typed, classic, inferred };
}

module.exports = {
  getDb,
  getMeta,
  setMeta,
  vectorToBlob,
  blobToVector,
  rowToNode,
  nodeToRow,
  // Nodes
  getNode,
  getNodes,
  getNodesWithEmbeddings,
  upsertNode,
  updateNodeUsage,
  // Embeddings
  getEmbedding,
  setEmbedding,
  // Edges
  getAllEdges,
  getEdges,
  upsertEdge,
  updateEdge,
  deleteEdges,
  findEdge,
  // Episodes
  getEpisodes,
  addEpisode,
  upsertEpisode,
  // Query misses
  getQueryMisses,
  addQueryMiss,
  // Embedding cache
  getCachedEmbedding,
  setCachedEmbedding,
  // Transactions
  transaction,
  // Stats
  getNodeCounts,
  getEdgeCounts,
};
