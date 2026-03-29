/**
 * lib/maintenance.js
 * Maintenance operations: stats, decay, compact, archive, feedback stats
 */

const fs = require('fs');
const path = require('path');
const { 
  MEMORY_DIR,
  loadBrain, 
  saveBrain, 
  isCore, 
  isSingularity, 
  isProtected,
  truncateText 
} = require('./core');

// ============================================================================
// STATS COMMAND
// ============================================================================
function statsCommand() {
  const brain = loadBrain();
  
  if (!brain.nodes.length) {
    console.log('No brain data found. Run: node brain.js rebuild');
    return;
  }
  
  const activeNodes = brain.nodes.filter(n => !n.mergedInto);
  const mergedNodes = brain.nodes.filter(n => n.mergedInto);
  const coreNodes = activeNodes.filter(n => isCore(n));
  const raptorNodes = activeNodes.filter(n => n.tier === 'raptor');
  const distilledNodes = activeNodes.filter(n => n.distilled && n.distilled.trim() !== '');
  const embeddedNodes = activeNodes.filter(n => n.embedding && n.embedding.length > 0);
  const extractedNodes = activeNodes.filter(n => n.extractedEntities);
  
  const typedEdges = brain.edges.filter(e => e.type);
  const classicEdges = brain.edges.filter(e => !e.type);
  const inferredEdges = brain.edges.filter(e => e.type === 'inferred_transitive');
  
  const categoryCounts = {};
  const topUsed = activeNodes
    .filter(n => n.usage?.hits > 0)
    .sort((a, b) => b.usage.hits - a.usage.hits)
    .slice(0, 10);
  
  const nodesWithFeedback = activeNodes.filter(n => n.feedback && (n.feedback.good > 0 || n.feedback.bad > 0));
  const totalGoodFeedback = nodesWithFeedback.reduce((sum, n) => sum + (n.feedback?.good || 0), 0);
  const totalBadFeedback = nodesWithFeedback.reduce((sum, n) => sum + (n.feedback?.bad || 0), 0);
  
  const nodesWithConflicts = activeNodes.filter(n => n.conflicts && n.conflicts.length > 0);
  const unresolvedConflicts = nodesWithConflicts.reduce((sum, n) => {
    return sum + (n.conflicts?.filter(c => !c.resolved).length || 0);
  }, 0) / 2; // Divide by 2 because each conflict is counted twice (once per node)
  
  // Calculate decay distribution
  const now = new Date();
  const decayZones = { critical: 0, low: 0, medium: 0, healthy: 0 };
  activeNodes.forEach(node => {
    const lastUsed = node.usage?.lastUsed ? new Date(node.usage.lastUsed) : new Date(node.usage?.firstSeen || 0);
    const daysSinceAccess = (now - lastUsed) / (1000 * 60 * 60 * 24);
    const stability = node.usage?.stability || 1.0;
    const retention = Math.exp(-daysSinceAccess / stability) * 100;
    
    if (retention < 10) decayZones.critical++;
    else if (retention < 40) decayZones.low++;
    else if (retention < 80) decayZones.medium++;
    else decayZones.healthy++;
  });
  
  activeNodes.forEach(node => {
    categoryCounts[node.category] = (categoryCounts[node.category] || 0) + 1;
  });
  
  // Count entities
  let totalEntities = 0;
  const entityTypes = { people: 0, companies: 0, tools: 0, topics: 0, decisions: 0, relationships: 0 };
  extractedNodes.forEach(node => {
    if (node.extractedEntities) {
      totalEntities += (node.extractedEntities.people || []).length + 
                       (node.extractedEntities.companies || []).length + 
                       (node.extractedEntities.tools || []).length +
                       (node.extractedEntities.topics || []).length;
      entityTypes.people += (node.extractedEntities.people || []).length;
      entityTypes.companies += (node.extractedEntities.companies || []).length;
      entityTypes.tools += (node.extractedEntities.tools || []).length;
      entityTypes.topics += (node.extractedEntities.topics || []).length;
      entityTypes.decisions += (node.extractedEntities.decisions || []).length;
      entityTypes.relationships += (node.extractedEntities.relationships || []).length;
    }
  });
  
  console.log('\n📊 Brain Statistics\n');
  console.log('═'.repeat(80) + '\n');
  console.log(`📦 Total nodes:        ${brain.nodes.length} (${activeNodes.length} active, ${mergedNodes.length} merged)`);
  console.log(`🔗 Total edges:        ${brain.edges.length} (${typedEdges.length} typed, ${classicEdges.length} classic, ${inferredEdges.length} inferred)`);
  console.log(`🔴 Core nodes:         ${coreNodes.length} (${Math.round(coreNodes.length/activeNodes.length*100)}%)`);
  console.log(`🌲 RAPTOR nodes:       ${raptorNodes.length} (${Math.round(raptorNodes.length/activeNodes.length*100)}%)`);
  console.log(`🧠 Distilled:          ${distilledNodes.length} (${Math.round(distilledNodes.length/activeNodes.length*100)}%)`);
  console.log(`🚀 Embeddings:         ${embeddedNodes.length} (${Math.round(embeddedNodes.length/activeNodes.length*100)}%)`);
  console.log(`🔍 Entities extracted: ${extractedNodes.length} (${Math.round(extractedNodes.length/activeNodes.length*100)}%)`);
  console.log(`👍 Feedback:           ${nodesWithFeedback.length} nodes (${totalGoodFeedback} good, ${totalBadFeedback} bad)`);
  console.log(`⚠️  Conflicts:          ${unresolvedConflicts} unresolved contradictions`);
  console.log(`📉 Decay:              💀 ${decayZones.critical} | 🔴 ${decayZones.low} | 🟡 ${decayZones.medium} | 🟢 ${decayZones.healthy}`);
  
  // === QUERY FEEDBACK STATS ===
  const totalQueries = brain.totalQueriesTracked || 0;
  const totalMisses = brain.queryMisses?.length || 0;
  const nodesWithQueryData = activeNodes.filter(n => (n.usage?.queryAppearances || 0) >= 5);
  const avgHitRate = nodesWithQueryData.length > 0
    ? nodesWithQueryData.reduce((sum, n) => {
        const hitRate = (n.usage?.referenced || 0) / Math.max(n.usage?.queryAppearances || 1, 1);
        return sum + hitRate;
      }, 0) / nodesWithQueryData.length
    : 0;
  
  console.log(`📊 Query feedback:     ${totalQueries} queries tracked, ${totalMisses} misses`);
  if (nodesWithQueryData.length > 0) {
    console.log(`🎯 Avg hit rate:       ${(avgHitRate * 100).toFixed(1)}% (across ${nodesWithQueryData.length} nodes with ≥5 appearances)`);
  }
  
  // Episodic memory stats
  const episodeCount = brain.episodes?.length || 0;
  const totalEvents = brain.episodes?.reduce((sum, ep) => sum + (ep.events?.length || 0), 0) || 0;
  console.log(`📖 Episodes:           ${episodeCount} episodes (${totalEvents} events total)`);
  
  console.log(`📅 Last updated:       ${brain.lastUpdated}`);
  console.log(`📈 Last tracked:       ${brain.lastTracked}\n`);
  
  if (raptorNodes.length > 0) {
    console.log('🌳 RAPTOR Hierarchy:\n');
    for (let level = 1; level <= 3; level++) {
      const levelNodes = raptorNodes.filter(n => n.raptorLevel === level);
      if (levelNodes.length > 0) {
        console.log(`   Level ${level}: ${levelNodes.length} summary nodes`);
      }
    }
    console.log('');
  }
  
  if (totalEntities > 0) {
    console.log('🏷️  Entity Breakdown:\n');
    console.log(`   👥 People:           ${entityTypes.people}`);
    console.log(`   🏢 Companies:        ${entityTypes.companies}`);
    console.log(`   🛠️  Tools:            ${entityTypes.tools}`);
    console.log(`   📚 Topics:           ${entityTypes.topics}`);
    console.log(`   ✅ Decisions:        ${entityTypes.decisions}`);
    console.log(`   🔗 Relationships:    ${entityTypes.relationships}`);
    console.log(`   📊 Total entities:   ${totalEntities}\n`);
  }
  
  console.log('📑 By Category:\n');
  Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      const coreCount = brain.nodes.filter(n => n.category === cat && isCore(n)).length;
      const distilledCount = brain.nodes.filter(n => n.category === cat && n.distilled && n.distilled.trim() !== '').length;
      const embeddedCount = brain.nodes.filter(n => n.category === cat && n.embedding && n.embedding.length > 0).length;
      console.log(`   ${cat.padEnd(20)} ${String(count).padStart(4)} nodes (${coreCount} core, ${distilledCount} distilled, ${embeddedCount} embedded)`);
    });
  
  if (topUsed.length > 0) {
    console.log('\n🔥 Most Accessed:\n');
    topUsed.forEach((node, i) => {
      const flags = [];
      if (isCore(node)) flags.push('🔴');
      if (node.distilled) flags.push('🧠');
      if (node.embedding) flags.push('🚀');
      const flagStr = flags.length > 0 ? ` ${flags.join('')}` : '';
      console.log(`   ${i+1}. ${truncateText(node.text, 60)} (${node.usage.hits} hits)${flagStr}`);
    });
  }
  
  // Progress indicators
  console.log('🚀 Upgrade Progress:\n');
  if (distilledNodes.length < activeNodes.length) {
    console.log(`   💡 ${activeNodes.length - distilledNodes.length} nodes need distillation. Run: node brain.js distill`);
  } else {
    console.log(`   ✅ All active nodes are distilled`);
  }
  
  if (distilledNodes.length > embeddedNodes.length) {
    console.log(`   💡 ${distilledNodes.length - embeddedNodes.length} distilled nodes need embeddings. Run: node brain.js embed`);
  } else if (distilledNodes.length > 0) {
    console.log(`   ✅ All distilled nodes have embeddings`);
  }
  
  if (distilledNodes.length > extractedNodes.length) {
    console.log(`   💡 ${distilledNodes.length - extractedNodes.length} distilled nodes need entity extraction. Run: node brain.js extract`);
  } else if (distilledNodes.length > 0) {
    console.log(`   ✅ All distilled nodes have extracted entities`);
  }
  
  if (typedEdges.length === 0 && extractedNodes.length > 0) {
    console.log(`   💡 Typed edges not built yet. Run: node brain.js rewire`);
  } else if (typedEdges.length > 0) {
    console.log(`   ✅ Typed edges built from entities`);
  }
  
  if (mergedNodes.length === 0 && embeddedNodes.length > 5) {
    console.log(`   💡 Deduplication not run yet. Run: node brain.js dedup`);
  } else if (mergedNodes.length > 0) {
    console.log(`   ✅ Deduplication completed (${mergedNodes.length} nodes merged)`);
  }
  
  if (distilledNodes.length === activeNodes.length && 
      embeddedNodes.length === distilledNodes.length &&
      extractedNodes.length === distilledNodes.length &&
      typedEdges.length > 0) {
    console.log('\n🎉 All active nodes are fully upgraded! Brain is at maximum power.');
  }
  
  console.log('\n' + '═'.repeat(80) + '\n');
}

// ============================================================================
// COMPACT COMMAND
// ============================================================================
function compactCommand() {
  console.log('🗜️  Compacting brain...\n');
  
  const brain = loadBrain();
  const beforeEdges = brain.edges.length;
  const beforeSize = JSON.stringify(brain).length;
  
  // 1. Prune classic edges below 0.85 threshold (lowered from 0.92 for Phase 1)
  const classicBefore = brain.edges.filter(e => !e.type).length;
  brain.edges = brain.edges.filter(e => {
    if (e.type) return true; // keep typed edges (will handle inferred separately)
    return (e.weight || 0) > 0.85;
  });
  const classicAfter = brain.edges.filter(e => !e.type).length;
  console.log(`🔪 Pruned classic edges: ${classicBefore} → ${classicAfter} (removed ${classicBefore - classicAfter})`);
  
  // 1b. Prune inferred edges with zero usage (never co-recalled)
  const inferredBefore = brain.edges.filter(e => e.type === 'inferred_transitive').length;
  brain.edges = brain.edges.filter(e => {
    if (e.type === 'inferred_transitive') {
      // Keep if it has been used at least once
      return (e.usage?.hits || 0) > 0;
    }
    return true;
  });
  const inferredAfter = brain.edges.filter(e => e.type === 'inferred_transitive').length;
  if (inferredBefore > 0) {
    console.log(`🧠 Pruned unused inferred edges: ${inferredBefore} → ${inferredAfter} (removed ${inferredBefore - inferredAfter})`);
  }
  
  // 2. Cap max classic edges per node to 15 (keep highest weight)
  const activeNodes = brain.nodes.filter(n => !n.mergedInto);
  const typedEdges = brain.edges.filter(e => e.type);
  let classicEdges = brain.edges.filter(e => !e.type);
  
  // Build per-node edge map
  const nodeEdgeMap = new Map();
  classicEdges.forEach((edge, idx) => {
    [edge.source, edge.target].forEach(nid => {
      if (!nodeEdgeMap.has(nid)) nodeEdgeMap.set(nid, []);
      nodeEdgeMap.get(nid).push({ idx, weight: edge.weight || 0 });
    });
  });
  
  const edgesToRemove = new Set();
  nodeEdgeMap.forEach((edges, nid) => {
    if (edges.length <= 15) return;
    // Sort by weight descending, mark excess for removal
    edges.sort((a, b) => b.weight - a.weight);
    edges.slice(15).forEach(e => edgesToRemove.add(e.idx));
  });
  
  if (edgesToRemove.size > 0) {
    classicEdges = classicEdges.filter((_, idx) => !edgesToRemove.has(idx));
    console.log(`✂️  Capped edges/node to 15: removed ${edgesToRemove.size} excess edges`);
  }
  
  brain.edges = [...typedEdges, ...classicEdges];
  
  // 3. Truncate embeddings from 3072 → 1024 dimensions
  // text-embedding-3-large supports Matryoshka truncation — first N dims are valid
  let truncated = 0;
  activeNodes.forEach(n => {
    if (n.embedding && n.embedding.length > 1024) {
      // Normalize the truncated vector
      const slice = n.embedding.slice(0, 1024);
      const mag = Math.sqrt(slice.reduce((s, v) => s + v * v, 0));
      n.embedding = mag > 0 ? slice.map(v => Math.round((v / mag) * 1e6) / 1e6) : slice;
      truncated++;
    }
  });
  console.log(`📐 Truncated embeddings: ${truncated} nodes (3072 → 1024 dims)`);
  
  // 4. Remove dead score field
  let cleaned = 0;
  brain.nodes.forEach(n => {
    if ('score' in n) { delete n.score; cleaned++; }
  });
  if (cleaned) console.log(`🧹 Removed dead 'score' field from ${cleaned} nodes`);
  
  // 5. Round embedding values to 6 decimal places (already done above for truncated)
  activeNodes.forEach(n => {
    if (n.embedding && n.embedding.length === 1024) return; // already rounded
    if (n.embedding) {
      n.embedding = n.embedding.map(v => Math.round(v * 1e6) / 1e6);
    }
  });
  
  saveBrain(brain);
  
  const afterSize = JSON.stringify(brain).length;
  console.log(`\n📊 Results:`);
  console.log(`   Edges: ${beforeEdges} → ${brain.edges.length}`);
  console.log(`   Size: ${(beforeSize/1024/1024).toFixed(1)}MB → ${(afterSize/1024/1024).toFixed(1)}MB`);
  console.log(`   Saved: ${((beforeSize - afterSize)/1024/1024).toFixed(1)}MB (${Math.round((1 - afterSize/beforeSize) * 100)}%)`);
}

// ============================================================================
// DECAY COMMAND — show retention heatmap
// ============================================================================
function decayCommand() {
  console.log('📉 Memory Decay Analysis\n');
  
  const brain = loadBrain();
  const activeNodes = brain.nodes.filter(n => !n.mergedInto);
  const now = new Date();
  
  // Calculate retention for each node
  const nodesWithRetention = activeNodes.map(node => {
    const lastUsed = node.usage?.lastUsed ? new Date(node.usage.lastUsed) : new Date(node.usage?.firstSeen || 0);
    const daysSinceAccess = (now - lastUsed) / (1000 * 60 * 60 * 24);
    const stability = node.usage?.stability || 1.0;
    const retention = Math.exp(-daysSinceAccess / stability);
    
    return {
      id: node.id,
      retention: retention * 100,
      daysSinceAccess: Math.round(daysSinceAccess),
      stability,
      hits: node.usage?.hits || 0,
      distilled: node.distilled || node.text || '',
      sourceFile: node.sourceFile || '?'
    };
  }).sort((a, b) => a.retention - b.retention); // Lowest retention first
  
  // Group into zones
  const zones = {
    critical: nodesWithRetention.filter(n => n.retention < 10),
    low: nodesWithRetention.filter(n => n.retention >= 10 && n.retention < 40),
    medium: nodesWithRetention.filter(n => n.retention >= 40 && n.retention < 80),
    healthy: nodesWithRetention.filter(n => n.retention >= 80)
  };
  
  console.log('🎯 Retention Distribution:\n');
  console.log(`   💀 Critical (<10%):  ${zones.critical.length} nodes`);
  console.log(`   🔴 Low (10-40%):     ${zones.low.length} nodes`);
  console.log(`   🟡 Medium (40-80%):  ${zones.medium.length} nodes`);
  console.log(`   🟢 Healthy (>80%):   ${zones.healthy.length} nodes`);
  console.log('');
  
  // Show top 20 most decayed nodes
  const showCount = Math.min(20, nodesWithRetention.length);
  console.log(`📊 Top ${showCount} Most Decayed Nodes (lowest retention first):\n`);
  
  nodesWithRetention.slice(0, showCount).forEach((node, idx) => {
    let icon = '🟢';
    if (node.retention < 10) icon = '💀';
    else if (node.retention < 40) icon = '🔴';
    else if (node.retention < 80) icon = '🟡';
    
    console.log(`${idx + 1}. ${icon} [${node.id}] ${node.retention.toFixed(1)}% retention`);
    console.log(`   📁 ${node.sourceFile} | ⏱️  ${node.daysSinceAccess}d idle | 🎯 stability ${node.stability.toFixed(1)} | 🔥 ${node.hits} hits`);
    console.log(`   💬 ${truncateText(node.distilled, 80)}\n`);
  });
  
  console.log(`💡 Nodes with <10% retention may be candidates for archival.`);
  console.log(`💡 Run: node brain.js archive --dry-run to preview\n`);
}

// ============================================================================
// ARCHIVE COMMAND — prune decayed nodes
// ============================================================================
function archiveCommand(args = []) {
  const dryRun = args.includes('--dry-run');
  const brain = loadBrain();
  const now = new Date();
  const RETENTION_THRESHOLD = 0.05; // Below 5% retention = archive
  const MIN_AGE_DAYS = 14; // Don't archive anything less than 2 weeks old
  
  console.log(`🗄️  Archive scan${dryRun ? ' (DRY RUN)' : ''}...\n`);
  
  const toArchive = [];
  
  brain.nodes.forEach(node => {
    // Never archive: core nodes, protected nodes, merged nodes
    if (isProtected(node)) return;
    if (node.mergedInto) return;
    
    // Check age
    const firstSeen = node.usage?.firstSeen ? new Date(node.usage.firstSeen) : new Date(node.created || 0);
    const ageDays = (now - firstSeen) / (1000 * 60 * 60 * 24);
    if (ageDays < MIN_AGE_DAYS) return;
    
    // Calculate Ebbinghaus retention
    const lastUsed = node.usage?.lastUsed ? new Date(node.usage.lastUsed) : firstSeen;
    const daysSinceAccess = (now - lastUsed) / (1000 * 60 * 60 * 24);
    const stability = node.usage?.stability || 1.0;
    const retention = Math.exp(-daysSinceAccess / stability);
    
    if (retention < RETENTION_THRESHOLD) {
      toArchive.push({
        id: node.id,
        source: node.sourceFile || '?',
        retention: retention,
        hits: node.usage?.hits || 0,
        daysSinceAccess: Math.round(daysSinceAccess),
        distilled: (node.distilled || node.text || '').substring(0, 80)
      });
    }
  });
  
  if (toArchive.length === 0) {
    console.log('✅ No nodes below retention threshold. Graph is healthy.\n');
    return;
  }
  
  console.log(`Found ${toArchive.length} nodes below ${RETENTION_THRESHOLD * 100}% retention:\n`);
  toArchive.forEach(n => {
    console.log(`  💀 [${n.id}] (${n.retention.toFixed(3)}) ${n.hits} hits, ${n.daysSinceAccess}d idle — ${n.source}`);
    console.log(`     ${n.distilled}...`);
  });
  
  if (dryRun) {
    console.log(`\n🔍 Dry run — no changes made. Remove --dry-run to archive.\n`);
    return;
  }
  
  // Archive: write to archive file, remove from brain
  const archivePath = path.join(MEMORY_DIR, 'constellation-archive.json');
  let archive = [];
  if (fs.existsSync(archivePath)) {
    try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf-8')); } catch(e) { archive = []; }
  }
  
  const archiveIds = new Set(toArchive.map(n => n.id));
  
  // Move full nodes to archive
  const archivedNodes = brain.nodes.filter(n => archiveIds.has(n.id));
  archivedNodes.forEach(n => { n.archivedAt = now.toISOString(); });
  archive.push(...archivedNodes);
  fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2));
  
  // Remove from brain
  brain.nodes = brain.nodes.filter(n => !archiveIds.has(n.id));
  // Remove orphaned edges
  const activeIds = new Set(brain.nodes.map(n => n.id));
  const edgesBefore = brain.edges.length;
  brain.edges = brain.edges.filter(e => activeIds.has(e.source) && activeIds.has(e.target));
  const edgesRemoved = edgesBefore - brain.edges.length;
  
  saveBrain(brain);
  
  console.log(`\n🗄️  Archived ${toArchive.length} nodes, removed ${edgesRemoved} orphaned edges.`);
  console.log(`   Archive: ${archivePath} (${archive.length} total archived)`);
  console.log(`   Brain: ${brain.nodes.length} nodes, ${brain.edges.length} edges remaining.\n`);
}

// ============================================================================
// FEEDBACK STATS COMMAND
// ============================================================================
function feedbackStatsCommand() {
  console.log('📊 Query Feedback Loop Statistics\n');
  console.log('═'.repeat(80) + '\n');
  
  const brain = loadBrain();
  const totalQueries = brain.totalQueriesTracked || 0;
  const totalMisses = brain.queryMisses?.length || 0;
  
  console.log(`📈 Query Tracking:`);
  console.log(`   Total queries tracked: ${totalQueries}`);
  console.log(`   Query misses logged: ${totalMisses}\n`);
  
  // Calculate hit rates for all nodes with ≥5 appearances
  const nodesWithHitRates = brain.nodes
    .filter(n => !n.mergedInto && (n.usage?.queryAppearances || 0) >= 5)
    .map(n => {
      const appearances = n.usage?.queryAppearances || 0;
      const referenced = n.usage?.referenced || 0;
      const hitRate = referenced / Math.max(appearances, 1);
      
      return {
        id: n.id,
        hitRate,
        appearances,
        referenced,
        distilled: n.distilled || n.text || '',
        sourceFile: n.sourceFile || '?'
      };
    });
  
  if (nodesWithHitRates.length === 0) {
    console.log('⚠️  No nodes with ≥5 query appearances yet. Need more query data.\n');
  } else {
    const avgHitRate = nodesWithHitRates.reduce((sum, n) => sum + n.hitRate, 0) / nodesWithHitRates.length;
    console.log(`🎯 Average hit rate: ${(avgHitRate * 100).toFixed(1)}% (across ${nodesWithHitRates.length} nodes with ≥5 appearances)\n`);
    
    // Top 10 highest hit-rate nodes (most consistently useful)
    const topUseful = [...nodesWithHitRates].sort((a, b) => b.hitRate - a.hitRate).slice(0, 10);
    
    if (topUseful.length > 0) {
      console.log('🏆 Top 10 Highest Hit-Rate Nodes (Most Consistently Useful):\n');
      topUseful.forEach((node, idx) => {
        console.log(`   ${idx + 1}. [${node.id}] Hit rate: ${(node.hitRate * 100).toFixed(1)}% (${node.referenced}/${node.appearances})`);
        console.log(`      📁 ${node.sourceFile}`);
        console.log(`      💬 ${truncateText(node.distilled, 80)}\n`);
      });
    }
    
    // Top 10 lowest hit-rate nodes (noise candidates)
    const topNoise = [...nodesWithHitRates].sort((a, b) => a.hitRate - b.hitRate).slice(0, 10);
    
    if (topNoise.length > 0) {
      console.log('🗑️  Top 10 Lowest Hit-Rate Nodes (Noise Candidates — appeared often but never referenced):\n');
      topNoise.forEach((node, idx) => {
        console.log(`   ${idx + 1}. [${node.id}] Hit rate: ${(node.hitRate * 100).toFixed(1)}% (${node.referenced}/${node.appearances})`);
        console.log(`      📁 ${node.sourceFile}`);
        console.log(`      💬 ${truncateText(node.distilled, 80)}\n`);
      });
    }
  }
  
  // Last 10 query misses (knowledge gaps)
  if (brain.queryMisses && brain.queryMisses.length > 0) {
    const recentMisses = brain.queryMisses.slice(-10).reverse();
    
    console.log('❌ Last 10 Query Misses (Knowledge Gaps):\n');
    recentMisses.forEach((miss, idx) => {
      const date = new Date(miss.timestamp).toLocaleString();
      console.log(`   ${idx + 1}. "${miss.query}"`);
      console.log(`      ⏰ ${date} | 📊 Top score: ${miss.topScore.toFixed(3)} | Results: ${miss.resultCount}\n`);
    });
  } else {
    console.log('✅ No query misses logged yet.\n');
  }
  
  // Edge tuning stats
  const edgesWithTuning = brain.edges.filter(e => e.tuningStats && (e.tuningStats.boosts > 0 || e.tuningStats.decays > 0));
  const totalBoosts = edgesWithTuning.reduce((sum, e) => sum + (e.tuningStats?.boosts || 0), 0);
  const totalDecays = edgesWithTuning.reduce((sum, e) => sum + (e.tuningStats?.decays || 0), 0);
  
  console.log('🔗 Edge Weight Tuning Stats:\n');
  console.log(`   Edges tuned: ${edgesWithTuning.length}`);
  console.log(`   Total boosts (both nodes high hit rate >0.5): ${totalBoosts}`);
  console.log(`   Total decays (both nodes low hit rate <0.2): ${totalDecays}\n`);
  
  console.log('═'.repeat(80) + '\n');
  
  console.log('💡 Interpretation:');
  console.log('   • High hit-rate nodes = consistently useful when surfaced');
  console.log('   • Low hit-rate nodes = noise (appear often but never get referenced)');
  console.log('   • Query misses = gaps in knowledge (queries that return nothing relevant)');
  console.log('   • Edge tuning = graph topology reflecting real usefulness over time\n');
}

// ============================================================================
// DEDUP COMMAND — Aggressive deduplication with 0.90 threshold
// ============================================================================
function dedupCommand(args = []) {
  const { cosineSimilarity } = require('./embeddings');
  const dryRun = args.includes('--dry-run');
  const threshold = parseFloat(args.find(a => a.startsWith('--threshold='))?.split('=')[1]) || 0.90;
  
  console.log(`🔀 Aggressive Deduplication${dryRun ? ' (DRY RUN)' : ''} (threshold: ${threshold})...\n`);
  
  const brain = loadBrain();
  const activeNodes = brain.nodes.filter(n => !n.mergedInto && n.embedding?.length > 0);
  
  console.log(`📊 Scanning ${activeNodes.length} nodes for duplicates...\n`);
  
  const merges = [];
  const processed = new Set();
  
  // Find duplicates
  for (let i = 0; i < activeNodes.length; i++) {
    const nodeA = activeNodes[i];
    if (processed.has(nodeA.id)) continue;
    
    const duplicates = [];
    for (let j = i + 1; j < activeNodes.length; j++) {
      const nodeB = activeNodes[j];
      if (processed.has(nodeB.id)) continue;
      
      const sim = cosineSimilarity(nodeA.embedding, nodeB.embedding);
      if (sim >= threshold) {
        duplicates.push({ node: nodeB, similarity: sim });
      }
    }
    
    if (duplicates.length > 0) {
      duplicates.sort((a, b) => b.similarity - a.similarity);
      
      // Choose the best representative (most hits, longest text, or newest)
      let best = nodeA;
      const candidates = [nodeA, ...duplicates.map(d => d.node)];
      
      candidates.forEach(c => {
        const bestHits = best.usage?.hits || 0;
        const cHits = c.usage?.hits || 0;
        const bestLen = (best.text || '').length;
        const cLen = (c.text || '').length;
        
        if (cHits > bestHits || (cHits === bestHits && cLen > bestLen)) {
          best = c;
        }
      });
      
      // Merge others into best
      candidates.forEach(c => {
        if (c.id === best.id) return;
        merges.push({
          from: c.id,
          to: best.id,
          similarity: cosineSimilarity(c.embedding, best.embedding),
          fromText: truncateText(c.distilled || c.text || '', 60),
          toText: truncateText(best.distilled || best.text || '', 60)
        });
        processed.add(c.id);
      });
      
      processed.add(best.id);
    }
  }
  
  console.log(`📊 Found ${merges.length} nodes to merge\n`);
  
  if (merges.length === 0) {
    console.log('✅ No duplicates found!');
    return;
  }
  
  // Show preview
  console.log('📋 Merge Preview:\n');
  merges.slice(0, 10).forEach((m, idx) => {
    console.log(`${idx + 1}. [${m.from}] → [${m.to}] (sim: ${m.similarity.toFixed(3)})`);
    console.log(`   From: ${m.fromText}`);
    console.log(`   To:   ${m.toText}\n`);
  });
  
  if (merges.length > 10) {
    console.log(`   ... and ${merges.length - 10} more\n`);
  }
  
  if (dryRun) {
    console.log('🔍 DRY RUN — no changes made. Remove --dry-run to execute.');
    return;
  }
  
  // Execute merges
  merges.forEach(m => {
    const fromNode = brain.nodes.find(n => n.id === m.from);
    const toNode = brain.nodes.find(n => n.id === m.to);
    
    if (!fromNode || !toNode) return;
    
    // Mark as merged
    fromNode.mergedInto = m.to;
    
    // Combine usage stats
    toNode.usage.hits += fromNode.usage?.hits || 0;
    toNode.usage.referenced += fromNode.usage?.referenced || 0;
    
    // Update edges: redirect all edges pointing to fromNode → toNode
    brain.edges.forEach(edge => {
      if (edge.source === m.from) edge.source = m.to;
      if (edge.target === m.from) edge.target = m.to;
    });
  });
  
  // Remove self-loops and duplicate edges
  const edgeSet = new Set();
  brain.edges = brain.edges.filter(e => {
    if (e.source === e.target) return false; // Remove self-loops
    const key = `${e.source}-${e.target}-${e.type || 'classic'}`;
    if (edgeSet.has(key)) return false; // Remove duplicate edges
    edgeSet.add(key);
    return true;
  });
  
  saveBrain(brain);
  
  const afterActive = brain.nodes.filter(n => !n.mergedInto).length;
  console.log(`\n✅ Deduplication complete!`);
  console.log(`   Merged: ${merges.length} nodes`);
  console.log(`   Active nodes: ${activeNodes.length} → ${afterActive}`);
  console.log(`   Edges cleaned: ${brain.edges.length} (self-loops & duplicates removed)\n`);
}

// ============================================================================
// PRUNE-DECAY COMMAND — Kill decay-stage nodes with 0 hits AND age >7 days
// ============================================================================
function pruneDecayCommand(args = []) {
  const dryRun = args.includes('--dry-run');
  const minAgeDays = parseFloat(args.find(a => a.startsWith('--min-age='))?.split('=')[1]) || 7;
  
  console.log(`💀 Pruning Decay Nodes${dryRun ? ' (DRY RUN)' : ''} (min age: ${minAgeDays} days)...\n`);
  
  const brain = loadBrain();
  const activeNodes = brain.nodes.filter(n => !n.mergedInto);
  const now = new Date();
  
  const toPrune = [];
  
  activeNodes.forEach(node => {
    // Never prune protected nodes (core, family, health, curated files)
    if (isProtected(node)) return;
    
    // Calculate retention (based on last access)
    const lastUsed = node.usage?.lastUsed ? new Date(node.usage.lastUsed) : new Date(node.usage?.firstSeen || 0);
    const daysSinceAccess = (now - lastUsed) / (1000 * 60 * 60 * 24);
    const stability = node.usage?.stability || 1.0;
    const retention = Math.exp(-daysSinceAccess / stability) * 100;
    
    // Age = days since first created (not last access — lastUsed gets refreshed by merges)
    const firstSeen = node.usage?.firstSeen ? new Date(node.usage.firstSeen) : new Date(0);
    const ageDays = (now - firstSeen) / (1000 * 60 * 60 * 24);
    
    // Prune if: decay stage (<10% retention) AND 0 hits AND age > minAgeDays
    if (retention < 10 && (node.usage?.hits || 0) === 0 && ageDays > minAgeDays) {
      toPrune.push({
        id: node.id,
        retention: retention.toFixed(1),
        age: Math.round(daysSinceAccess),
        text: truncateText(node.distilled || node.text || '', 60)
      });
    }
  });
  
  console.log(`📊 Found ${toPrune.length} decay nodes to prune\n`);
  
  if (toPrune.length === 0) {
    console.log('✅ No decay nodes to prune!');
    return;
  }
  
  // Show preview
  console.log('📋 Prune Preview:\n');
  toPrune.slice(0, 10).forEach((n, idx) => {
    console.log(`${idx + 1}. 💀 [${n.id}] ${n.retention}% retention, ${n.age}d old`);
    console.log(`   ${n.text}\n`);
  });
  
  if (toPrune.length > 10) {
    console.log(`   ... and ${toPrune.length - 10} more\n`);
  }
  
  if (dryRun) {
    console.log('🔍 DRY RUN — no changes made. Remove --dry-run to execute.');
    return;
  }
  
  // Execute pruning
  toPrune.forEach(p => {
    const node = brain.nodes.find(n => n.id === p.id);
    if (!node) return;
    
    // Mark as merged into special "archived" node (soft delete)
    node.mergedInto = 'archived-decay';
  });
  
  // Remove edges connected to pruned nodes
  const prunedIds = new Set(toPrune.map(p => p.id));
  const beforeEdges = brain.edges.length;
  brain.edges = brain.edges.filter(e => !prunedIds.has(e.source) && !prunedIds.has(e.target));
  
  saveBrain(brain);
  
  const afterActive = brain.nodes.filter(n => !n.mergedInto).length;
  console.log(`\n✅ Pruning complete!`);
  console.log(`   Pruned: ${toPrune.length} decay nodes`);
  console.log(`   Edges removed: ${beforeEdges - brain.edges.length}`);
  console.log(`   Active nodes: ${activeNodes.length} → ${afterActive}\n`);
}

module.exports = {
  statsCommand,
  compactCommand,
  decayCommand,
  archiveCommand,
  feedbackStatsCommand,
  dedupCommand,
  pruneDecayCommand
};
