#!/usr/bin/env node
/**
 * constellation.js — Unified Memory Brain System (CLI Router)
 * 
 * All logic lives in lib/ modules. This file is just the CLI entry point.
 * 
 * Usage:
 *   node constellation.js query "search terms"     → search + auto-track usage
 *   node constellation.js track "snippet1" ...     → manually track usage
 *   node constellation.js rebuild                  → rebuild graph from memory files
 *   node constellation.js promote                  → scan for new core candidates
 *   node constellation.js stats                    → show graph statistics
 */
const { loadBrain, saveBrain, generateStableId } = require('./lib/core');
const { trackCommand } = require('./lib/tracking');
const { queryCommand } = require('./lib/search');
const { distillCommand, embedCommand, extractCommand, ingestCommand } = require('./lib/ingest');
const { rebuildCommand, rewireCommand, fixOrphansCommand, promoteCommand } = require('./lib/graph');
const { statsCommand, compactCommand, decayCommand, archiveCommand, feedbackStatsCommand, dedupCommand, pruneDecayCommand } = require('./lib/maintenance');
const { episodeCommand, episodeQueryCommand } = require('./lib/episodes');
const { feedbackCommand, checkConflictsCommand, resolveCommand, watchCommand, raptorCommand, inferCommand } = require('./lib/advanced');
const { handoffCommand, recallRecentCommand } = require('./lib/handoff');
const { summarizeCommand } = require('./lib/summarize');
const { deepLink, detectDuplicates, detectGaps } = require('./lib/cortex');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('Usage: node constellation.js <command> [args]');
    console.log('');
    console.log('Commands:');
    console.log('  query [-c] [-R] [--threshold 0.3] [--recent] "terms"  Search (-c = compact, -R = no-rerank)');
    console.log('  track "snippet1" ...      Manually track usage');
    console.log('  rebuild [--full]          Rebuild graph from memory files');
    console.log('  promote                   Scan for new core candidates');
    console.log('  stats                     Show statistics');
    console.log('  distill                   Generate distilled summaries for all nodes');
    console.log('  embed                     Generate embeddings for distilled nodes');
    console.log('  extract                   Extract entities from distilled text');
    console.log('  rewire                    Build typed edges from extracted entities');
    console.log('  ingest "memory text"      Add single memory (distill+embed+wire ~2-3s)');
    console.log('  wire <nodeId>             Auto-wire a node (cosine + entity edges)');
    console.log('  watch                     Watch memory directory for changes (daemon mode)');
    console.log('  check-conflicts           Detect contradictions in similar memories');
    console.log('  resolve <nodeId> <id>     Mark conflict as resolved');
    console.log('  decay                     Show retention heatmap (spaced repetition analysis)');
    console.log('  archive [--dry-run]       Archive decayed nodes below retention threshold');
    console.log('  dedup [--dry-run] [--threshold=0.90]  Merge duplicate nodes (cron-safe)');
    console.log('  prune-decay [--dry-run] [--min-age=7]  Archive decay nodes with 0 hits (cron-safe)');
    console.log('  feedback <node-id> <good|bad>  Rate query result quality');
    console.log('  feedback-stats            Show automatic query feedback loop metrics');
    console.log('  compact                   Prune weak edges, truncate embeddings, shrink file');
    console.log('  raptor                    Build RAPTOR hierarchical summaries (idempotent)');
    console.log('  infer [nodeId]            Discover implicit connections via transitive closure');
    console.log('  episode [--date YYYY-MM-DD]  Extract episodes from daily memory files');
    console.log('  episode-query "query"     Query episodic memory (event sequences)');
    console.log('  handoff "summary"         Create session handoff node for cross-session continuity');
    console.log('  recall-recent [-c] [--days 3] [--handoffs 5]  Startup recall: recent handoffs + ingested nodes');
    console.log('  summarize [--dry-run] [--force]  Progressive summarization: daily→weekly→monthly compression');
    process.exit(1);
  }

  switch (command) {
    case 'query': await queryCommand(args.slice(1)); break;
    case 'track': trackCommand(args.slice(1)); break;
    case 'rebuild': await rebuildCommand(args.slice(1)); break;
    case 'promote': promoteCommand(); break;
    case 'stats': statsCommand(); break;
    case 'distill': await distillCommand(); break;
    case 'embed': await embedCommand(); break;
    case 'extract': await extractCommand(); break;
    case 'rewire': rewireCommand(); break;
    case 'ingest': await ingestCommand(args.slice(1)); break;
    case 'wire': wireNodeCommand(args.slice(1)); break;
    case 'fix-orphans': fixOrphansCommand(); break;
    case 'watch': await watchCommand(); break;
    case 'check-conflicts': await checkConflictsCommand(); break;
    case 'resolve': resolveCommand(args.slice(1)); break;
    case 'decay': decayCommand(); break;
    case 'feedback': feedbackCommand(args.slice(1)); break;
    case 'feedback-stats': feedbackStatsCommand(); break;
    case 'compact': compactCommand(); break;
    case 'dedup': dedupCommand(args.slice(1)); break;
    case 'prune-decay': pruneDecayCommand(args.slice(1)); break;
    case 'raptor': await raptorCommand(); break;
    case 'archive': archiveCommand(args.slice(1)); break;
    case 'infer': await inferCommand(args.slice(1)); break;
    case 'episode': await episodeCommand(args.slice(1)); break;
    case 'episode-query': await episodeQueryCommand(args.slice(1)); break;
    case 'handoff': await handoffCommand(args.slice(1)); break;
    case 'recall-recent': await recallRecentCommand(args.slice(1)); break;
    case 'summarize': await summarizeCommand(args.slice(1)); break;
    case 'cortex':
    case 'nightly': {
      const dbModule = require('./lib/db');
      console.log('🌙 Constellation Cortex — Nightly Maintenance\n');
      console.log('=== Phase 1: Deep Linking ===');
      const linkStats = await deepLink(dbModule, 50);
      console.log(`  → ${linkStats.created} new edges\n`);
      console.log('=== Phase 2: Dedup Detection ===');
      const dedupStats = await detectDuplicates(dbModule, 30);
      console.log(`  → ${dedupStats.merged} duplicates found\n`);
      console.log('=== Phase 3: Gap Detection ===');
      const gaps = await detectGaps(dbModule);
      console.log(`  → ${gaps.length} gaps found`);
      gaps.forEach(g => console.log(`    [${g.category}] ${g.gap}`));
      console.log('\n🌙 Nightly complete.');
      break;
    }
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Run: node constellation.js (no args) for usage');
      process.exit(1);
  }
}

function wireNodeCommand(args) {
  const nodeId = args[0];
  if (!nodeId) { console.log('Usage: wire <nodeId>'); process.exit(1); }
  
  const { cosineSimilarity } = require('./lib/embeddings');
  const brain = loadBrain();
  const target = brain.nodes.find(n => n.id === nodeId || n.id.startsWith(nodeId));
  if (!target) { console.log(`Node ${nodeId} not found`); process.exit(1); }
  if (!target.embedding?.length) { console.log(`Node ${nodeId} has no embedding — run embed first`); process.exit(1); }
  
  console.log(`🔗 Wiring node ${target.id}: ${(target.d || target.distilled || '').substring(0, 80)}...\n`);
  
  let edgeCount = 0;
  const edgeExists = (a, b) => brain.edges.some(e => (e.source === a && e.target === b) || (e.source === b && e.target === a));
  
  // 1. Cosine-based edges (>0.5, top 10)
  const cosineCandidates = brain.nodes
    .filter(n => n.id !== target.id && !n.mergedInto && n.embedding?.length > 0)
    .map(n => ({ id: n.id, sim: cosineSimilarity(target.embedding, n.embedding) }))
    .filter(c => c.sim > 0.5)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 10);
  
  cosineCandidates.forEach(c => {
    if (!edgeExists(target.id, c.id)) {
      brain.edges.push({ source: target.id, target: c.id, weight: Math.round(c.sim * 100) / 100, usage: { hits: 0, lastUsed: null } });
      edgeCount++;
    }
  });
  console.log(`  Cosine edges: ${edgeCount}`);
  
  // 2. Entity-based edges
  let entityEdges = 0;
  const targetEntities = [
    ...(target.extractedEntities?.people || []).map(p => (p.name || p).toLowerCase()),
    ...(target.extractedEntities?.companies || []).map(c => (c.name || c).toLowerCase()),
    ...(target.extractedEntities?.tools || []).map(t => (t.name || t).toLowerCase()),
    ...(target.extractedEntities?.topics || []).map(t => t?.toLowerCase())
  ].filter(Boolean);
  
  if (targetEntities.length > 0) {
    brain.nodes.forEach(existing => {
      if (existing.id === target.id || existing.mergedInto || !existing.extractedEntities) return;
      const existingEntities = [
        ...(existing.extractedEntities?.people || []).map(p => (p.name || p).toLowerCase()),
        ...(existing.extractedEntities?.companies || []).map(c => (c.name || c).toLowerCase()),
        ...(existing.extractedEntities?.tools || []).map(t => (t.name || t).toLowerCase()),
        ...(existing.extractedEntities?.topics || []).map(t => t?.toLowerCase())
      ].filter(Boolean);
      const overlap = targetEntities.filter(e => existingEntities.includes(e));
      if (overlap.length >= 2 && !edgeExists(target.id, existing.id)) {
        brain.edges.push({ source: target.id, target: existing.id, type: 'shared_entity', weight: 0.5 * overlap.length, sharedEntities: overlap, usage: { hits: 0, lastUsed: null } });
        entityEdges++;
      }
    });
  }
  console.log(`  Entity edges: ${entityEdges}`);
  console.log(`\n✅ Total new edges: ${edgeCount + entityEdges}`);
  
  saveBrain(brain);
}

if (require.main === module) {
  main();
}

module.exports = { loadBrain, saveBrain, generateStableId };
