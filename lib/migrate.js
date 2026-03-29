/**
 * lib/migrate.js
 * One-time migration: unified-constellation.json → constellation.db
 * 
 * Run: node memory/lib/migrate.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || path.resolve(__dirname, '../..');
const JSON_PATH = path.join(WORKSPACE, 'memory/unified-constellation.json');
const BAK_PATH  = path.join(WORKSPACE, 'memory/unified-constellation.json.bak');

const db = require('./db');

async function migrate() {
  console.log('🚀 Starting migration: JSON → SQLite\n');

  // Verify source file exists
  if (!fs.existsSync(JSON_PATH)) {
    // Check if already migrated
    const { getDb, getMeta } = db;
    try {
      const ver = getMeta('version');
      if (ver) {
        console.log('✅ Already migrated (JSON file gone, DB exists)');
        return;
      }
    } catch (e) {}
    console.log(`❌ Source file not found: ${JSON_PATH}`);
    process.exit(1);
  }

  console.log(`📂 Loading JSON: ${JSON_PATH}`);
  const raw = fs.readFileSync(JSON_PATH, 'utf8');
  const brain = JSON.parse(raw);

  const nodes = brain.nodes || [];
  const edges = brain.edges || [];
  const episodes = brain.episodes || [];
  const queryMisses = brain.queryMisses || [];

  console.log(`   Nodes:       ${nodes.length}`);
  console.log(`   Edges:       ${edges.length}`);
  console.log(`   Episodes:    ${episodes.length}`);
  console.log(`   QueryMisses: ${queryMisses.length}\n`);

  const { getDb, setMeta, vectorToBlob, transaction } = db;
  const sqliteDb = getDb(); // Initialize schema

  // ============================================================================
  // MIGRATE IN ONE TRANSACTION (fast)
  // ============================================================================

  const insertNode = sqliteDb.prepare(`
    INSERT OR IGNORE INTO nodes (id, text, distilled, category, source_file, tags, tier, parent_id,
                                  extracted_entities, conflicts, merged_into, raptor_level, created_at, updated_at)
    VALUES (@id, @text, @distilled, @category, @source_file, @tags, @tier, @parent_id,
            @extracted_entities, @conflicts, @merged_into, @raptor_level, @created_at, @updated_at)
  `);

  const insertUsage = sqliteDb.prepare(`
    INSERT OR IGNORE INTO node_usage (node_id, hits, referenced, stability, last_used, first_seen, recall_intervals, query_appearances)
    VALUES (@node_id, @hits, @referenced, @stability, @last_used, @first_seen, @recall_intervals, @query_appearances)
  `);

  const insertFeedback = sqliteDb.prepare(`
    INSERT OR IGNORE INTO node_feedback (node_id, good, bad) VALUES (@node_id, @good, @bad)
  `);

  const insertEmbedding = sqliteDb.prepare(`
    INSERT OR IGNORE INTO embeddings (node_id, vector) VALUES (?, ?)
  `);

  const insertEdge = sqliteDb.prepare(`
    INSERT INTO edges (source, target, type, weight, shared_entities, relationships, metadata, hits, last_used, tuning_boosts, tuning_decays)
    VALUES (@source, @target, @type, @weight, @shared_entities, @relationships, @metadata, @hits, @last_used, @tuning_boosts, @tuning_decays)
    ON CONFLICT(source, target, type) DO UPDATE SET
      weight        = MAX(excluded.weight, weight),
      hits          = hits + excluded.hits,
      last_used     = COALESCE(excluded.last_used, last_used),
      tuning_boosts = tuning_boosts + excluded.tuning_boosts,
      tuning_decays = tuning_decays + excluded.tuning_decays
  `);

  const insertEpisode = sqliteDb.prepare(`
    INSERT OR IGNORE INTO episodes (episode_id, theme, timespan_start, timespan_end, events, created_at, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMiss = sqliteDb.prepare(`
    INSERT INTO query_misses (query, timestamp, top_score, result_count) VALUES (?, ?, ?, ?)
  `);

  const now = new Date().toISOString();

  // === NODES ===
  console.log(`📦 Migrating ${nodes.length} nodes...`);
  let embeddedCount = 0;

  sqliteDb.transaction(() => {
    for (const node of nodes) {
      const usage = node.usage || {};

      insertNode.run({
        id: node.id,
        text: node.text || null,
        distilled: node.distilled || null,
        category: node.category || null,
        source_file: node.sourceFile || null,
        tags: node.tags ? JSON.stringify(node.tags) : null,
        tier: node.tier || 'synapse',
        parent_id: node.parentId || null,
        extracted_entities: node.extractedEntities ? JSON.stringify(node.extractedEntities) : null,
        conflicts: (node.conflicts && node.conflicts.length > 0) ? JSON.stringify(node.conflicts) : null,
        merged_into: node.mergedInto || null,
        raptor_level: node.raptorLevel || null,
        created_at: usage.firstSeen || now,
        updated_at: now,
      });

      insertUsage.run({
        node_id: node.id,
        hits: usage.hits || 0,
        referenced: usage.referenced || 0,
        stability: usage.stability != null ? usage.stability : 1.0,
        last_used: usage.lastUsed || null,
        first_seen: usage.firstSeen || now,
        recall_intervals: usage.recallIntervals ? JSON.stringify(usage.recallIntervals) : '[]',
        query_appearances: usage.queryAppearances || 0,
      });

      if (node.feedback && (node.feedback.good || node.feedback.bad)) {
        insertFeedback.run({
          node_id: node.id,
          good: node.feedback.good || 0,
          bad: node.feedback.bad || 0,
        });
      }

      if (node.embedding && node.embedding.length > 0) {
        const buf = Buffer.allocUnsafe(node.embedding.length * 4);
        for (let i = 0; i < node.embedding.length; i++) {
          buf.writeFloatLE(node.embedding[i], i * 4);
        }
        insertEmbedding.run(node.id, buf);
        embeddedCount++;
      }
    }
  })();

  console.log(`   ✅ Nodes inserted (${embeddedCount} with embeddings)\n`);

  // === EDGES ===
  console.log(`🔗 Migrating ${edges.length} edges...`);
  let edgeSkipped = 0;

  sqliteDb.transaction(() => {
    for (const edge of edges) {
      const tuning = edge.tuningStats || {};
      const usage = edge.usage || {};

      try {
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
      } catch (e) {
        edgeSkipped++;
      }
    }
  })();

  console.log(`   ✅ Edges inserted (${edgeSkipped} merged/deduped)\n`);

  // === EPISODES ===
  console.log(`📖 Migrating ${episodes.length} episodes...`);

  sqliteDb.transaction(() => {
    for (const ep of episodes) {
      insertEpisode.run(
        ep.id || null,
        ep.theme || null,
        ep.timespan ? ep.timespan.start : null,
        ep.timespan ? ep.timespan.end : null,
        ep.events ? JSON.stringify(ep.events) : '[]',
        ep.createdAt || now,
        ep.sourceFile || null,
      );
    }
  })();

  console.log(`   ✅ Episodes inserted\n`);

  // === QUERY MISSES ===
  if (queryMisses.length > 0) {
    console.log(`❓ Migrating ${queryMisses.length} query misses...`);
    sqliteDb.transaction(() => {
      for (const miss of queryMisses.slice(-50)) {
        insertMiss.run(
          miss.query || '',
          miss.timestamp || now,
          miss.topScore || 0,
          miss.resultCount || 0,
        );
      }
    })();
    console.log(`   ✅ Query misses inserted\n`);
  }

  // === META ===
  setMeta('version', String(brain.version || 2));
  setMeta('lastUpdated', brain.lastUpdated || now);
  setMeta('lastTracked', brain.lastTracked || now);
  setMeta('totalQueriesTracked', String(brain.totalQueriesTracked || 0));

  // === VERIFY ===
  console.log('🔍 Verifying migration...\n');

  const { getNodeCounts, getEdgeCounts, getEpisodes } = db;
  const nodeCounts = getNodeCounts();
  const edgeCounts = getEdgeCounts();
  const episodeRows = getEpisodes();

  console.log(`   Nodes:    ${nodeCounts.total} (expected ~${nodes.length})`);
  console.log(`   Embedded: ${nodeCounts.embedded} (expected ~${embeddedCount})`);
  console.log(`   Edges:    ${edgeCounts.total} (expected ≤${edges.length})`);
  console.log(`   Episodes: ${episodeRows.length} (expected ${episodes.length})\n`);

  // Sanity check
  if (nodeCounts.total !== nodes.length) {
    console.log(`⚠️  Node count mismatch! Expected ${nodes.length}, got ${nodeCounts.total}`);
    console.log('    This may indicate duplicate IDs in the source JSON (they were merged).');
  }

  // === RENAME JSON ===
  fs.renameSync(JSON_PATH, BAK_PATH);
  console.log(`✅ Migration complete!`);
  console.log(`   JSON renamed to: ${BAK_PATH}`);
  console.log(`   DB location:     ${path.join(WORKSPACE, 'memory/constellation.db')}\n`);
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
