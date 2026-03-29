/**
 * lib/handoff.js
 * Session handoff nodes — enable cross-session continuity via constellation.
 * 
 * handoff: Create a handoff node summarizing what happened this session
 * recall-recent: Retrieve recent handoffs + recently ingested nodes for session startup
 */

const { loadBrain, saveBrain, generateStableId } = require('./core');
const { getEmbedding, cosineSimilarity } = require('./embeddings');
const db = require('./db');

// ============================================================================
// HANDOFF — Create session summary node
// ============================================================================
async function handoffCommand(args) {
  const text = args.join(' ').trim();
  if (!text || text.length < 20) {
    console.log('Usage: node constellation.js handoff "Summary of what happened this session. Open threads: X, Y, Z."');
    console.log('  Creates a handoff node (category: handoff, high priority, 7-day decay)');
    process.exit(1);
  }

  const brain = loadBrain();
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].substring(0, 5);
  
  // Prefix with timestamp for easy identification
  const fullText = `[Session Handoff ${dateStr} ${timeStr}] ${text}`;
  const id = generateStableId(fullText);

  // Check for duplicate
  if (brain.nodes.find(n => n.id === id)) {
    console.log(`⚠️  Handoff node ${id} already exists.`);
    return;
  }

  console.log(`📋 Creating session handoff node...`);

  // Embed directly (no distillation needed — handoffs are already concise)
  let embedding = [];
  try {
    embedding = await getEmbedding(fullText);
  } catch (e) {
    console.log(`   ⚠️  Embedding failed: ${e.message}`);
  }

  const node = {
    id,
    text: fullText,
    distilled: fullText, // Already concise, no LLM distillation needed
    embedding,
    category: 'handoff',
    sourceFile: `handoff-${dateStr}`,
    tags: ['handoff', 'session-continuity', dateStr],
    extractedEntities: { people: [], companies: [], tools: [], topics: [], dates: [{ date: dateStr, event: 'session handoff' }], decisions: [], relationships: [] },
    usage: {
      hits: 0,
      referenced: 0,
      stability: 7.0, // 7-day natural decay — handoffs stay relevant for a week
      lastUsed: now.toISOString(),
      firstSeen: now.toISOString(),
      recallIntervals: []
    },
    tier: 'core', // Always core — handoffs are high priority for recall
  };

  brain.nodes.push(node);

  // Wire to other recent handoffs and any related nodes
  if (embedding.length > 0) {
    let edgeCount = 0;
    const candidates = brain.nodes
      .filter(n => n.id !== id && !n.mergedInto && n.embedding?.length > 0)
      .map(n => ({ id: n.id, sim: cosineSimilarity(embedding, n.embedding), cat: n.category }))
      .filter(c => c.sim > 0.4) // Lower threshold — handoffs should connect broadly
      .sort((a, b) => {
        // Prioritize other handoffs, then by similarity
        if (a.cat === 'handoff' && b.cat !== 'handoff') return -1;
        if (b.cat === 'handoff' && a.cat !== 'handoff') return 1;
        return b.sim - a.sim;
      })
      .slice(0, 10);

    candidates.forEach(c => {
      brain.edges.push({
        source: id,
        target: c.id,
        type: c.cat === 'handoff' ? 'handoff_chain' : 'shared_entity',
        weight: Math.round(c.sim * 100) / 100,
        usage: { hits: 0, lastUsed: null }
      });
      edgeCount++;
    });

    console.log(`   🔗 Wired to ${edgeCount} nodes`);
  }

  saveBrain(brain);
  console.log(`   ✅ Handoff node created: ${id}`);
  console.log(`   📝 ${fullText.substring(0, 120)}...`);
}

// ============================================================================
// RECALL-RECENT — Startup recall for new sessions
// ============================================================================
async function recallRecentCommand(args) {
  // Parse flags
  let maxHandoffs = 5;
  let maxRecent = 10;
  let daysBack = 3;
  let compactMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--handoffs' && i + 1 < args.length) { maxHandoffs = parseInt(args[i + 1]); i++; }
    else if (args[i] === '--recent' && i + 1 < args.length) { maxRecent = parseInt(args[i + 1]); i++; }
    else if (args[i] === '--days' && i + 1 < args.length) { daysBack = parseInt(args[i + 1]); i++; }
    else if (args[i] === '-c' || args[i] === '--compact') { compactMode = true; }
  }

  const brain = loadBrain();
  const now = new Date();
  const cutoff = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString();

  // 1. Get handoff nodes, sorted by most recent
  const handoffs = brain.nodes
    .filter(n => n.category === 'handoff' && !n.mergedInto)
    .sort((a, b) => {
      const dateA = a.usage?.firstSeen || a.usage?.lastUsed || '2020-01-01';
      const dateB = b.usage?.firstSeen || b.usage?.lastUsed || '2020-01-01';
      return dateB.localeCompare(dateA);
    })
    .slice(0, maxHandoffs);

  // 2. Get recently ingested nodes (non-handoff, within daysBack)
  const recentNodes = brain.nodes
    .filter(n => {
      if (n.mergedInto || n.category === 'handoff') return false;
      const firstSeen = n.usage?.firstSeen || '';
      return firstSeen >= cutoffStr;
    })
    .sort((a, b) => {
      const dateA = a.usage?.firstSeen || '2020-01-01';
      const dateB = b.usage?.firstSeen || '2020-01-01';
      return dateB.localeCompare(dateA);
    })
    .slice(0, maxRecent);

  if (compactMode) {
    const output = {
      handoffs: handoffs.map(h => ({
        id: h.id,
        text: h.distilled || h.text,
        date: (h.usage?.firstSeen || '').split('T')[0],
        time: (h.usage?.firstSeen || '').split('T')[1]?.substring(0, 5) || '?'
      })),
      recent: recentNodes.map(n => ({
        id: n.id,
        d: (n.distilled || n.text || '').substring(0, 200),
        cat: n.category,
        src: n.sourceFile,
        date: (n.usage?.firstSeen || '').split('T')[0]
      })),
      stats: {
        totalNodes: brain.nodes.filter(n => !n.mergedInto).length,
        totalEdges: brain.edges.length,
        handoffCount: brain.nodes.filter(n => n.category === 'handoff' && !n.mergedInto).length
      }
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Pretty output
  console.log(`\n🧠 SESSION RECALL (last ${daysBack} days)\n`);
  console.log('═'.repeat(80));

  if (handoffs.length > 0) {
    console.log(`\n📋 SESSION HANDOFFS (${handoffs.length}):\n`);
    handoffs.forEach((h, i) => {
      const date = (h.usage?.firstSeen || '?').split('T')[0];
      const time = (h.usage?.firstSeen || '').split('T')[1]?.substring(0, 5) || '?';
      console.log(`  ${i + 1}. [${date} ${time}]`);
      console.log(`     ${h.distilled || h.text}\n`);
    });
  } else {
    console.log(`\n📋 No session handoffs found. Use 'constellation.js handoff "..."' to create one.\n`);
  }

  if (recentNodes.length > 0) {
    console.log(`\n🆕 RECENTLY INGESTED (${recentNodes.length}):\n`);
    recentNodes.forEach((n, i) => {
      const date = (n.usage?.firstSeen || '?').split('T')[0];
      const cat = n.category || '?';
      const text = (n.distilled || n.text || '').substring(0, 150);
      console.log(`  ${i + 1}. [${date}] (${cat}) ${text}`);
    });
  }

  console.log('\n' + '═'.repeat(80));
  console.log(`📊 Brain: ${brain.nodes.filter(n => !n.mergedInto).length} nodes | ${brain.edges.length} edges | ${brain.nodes.filter(n => n.category === 'handoff').length} handoffs total\n`);
}

module.exports = {
  handoffCommand,
  recallRecentCommand
};
