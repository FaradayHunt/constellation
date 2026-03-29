/**
 * lib/tracking.js
 * Usage tracking — now uses direct SQL UPDATEs instead of loading/saving full brain.
 * This is the hottest path (called on every query), so SQL is critical for speed.
 */

const { loadBrain, saveBrain, truncateText } = require('./core');
const { findMatchingNodes } = require('./parsing');
const db = require('./db');

function trackUsage(brain, nodeIds, referencedIds = []) {
  // Fast path: use direct SQL updates for node usage
  // This avoids serializing the entire brain just to update a few fields
  
  const now = new Date().toISOString();
  const nowMs = Date.now();
  
  const sqliteDb = db.getDb();

  // Get current usage for all affected nodes in one query
  const allIds = [...new Set([...nodeIds, ...referencedIds])];
  if (allIds.length === 0) return;
  
  const placeholders = allIds.map(() => '?').join(',');
  const currentUsageRows = sqliteDb.prepare(
    `SELECT node_id, hits, referenced, stability, last_used, first_seen, recall_intervals, query_appearances
     FROM node_usage WHERE node_id IN (${placeholders})`
  ).all(...allIds);
  
  const usageMap = new Map(currentUsageRows.map(r => [r.node_id, r]));

  const updateUsage = sqliteDb.prepare(`
    INSERT INTO node_usage (node_id, hits, referenced, stability, last_used, first_seen, recall_intervals, query_appearances)
    VALUES (@node_id, @hits, @referenced, @stability, @last_used, @first_seen, @recall_intervals, @query_appearances)
    ON CONFLICT(node_id) DO UPDATE SET
      hits             = excluded.hits,
      referenced       = excluded.referenced,
      stability        = excluded.stability,
      last_used        = excluded.last_used,
      recall_intervals = excluded.recall_intervals,
      query_appearances= excluded.query_appearances
  `);

  const processNode = (id, isReferenced) => {
    const current = usageMap.get(id);
    if (!current) return; // Node not in DB — skip
    
    const lastUsedMs = current.last_used ? new Date(current.last_used).getTime() : nowMs;
    const intervalDays = (nowMs - lastUsedMs) / (1000 * 60 * 60 * 24);
    
    let intervals = [];
    try { intervals = JSON.parse(current.recall_intervals || '[]'); } catch(e) {}
    
    if (intervalDays > 0.01) {
      intervals.push(intervalDays);
      if (intervals.length > 10) intervals = intervals.slice(-10);
    }
    
    const currentStability = current.stability || 1.0;
    let stabilityMultiplier;
    
    if (isReferenced) {
      stabilityMultiplier = 1.5;
      if (intervalDays > currentStability) stabilityMultiplier = 2.2;
      else if (intervalDays < currentStability / 3) stabilityMultiplier = 1.2;
    } else {
      stabilityMultiplier = 1.3;
      if (intervalDays > currentStability) stabilityMultiplier = 2.0;
      else if (intervalDays < currentStability / 3) stabilityMultiplier = 1.1;
    }
    
    const newStability = Math.min(currentStability * stabilityMultiplier, 90);
    
    updateUsage.run({
      node_id: id,
      hits: isReferenced ? (current.hits || 0) : (current.hits || 0) + 1,
      referenced: isReferenced ? (current.referenced || 0) + 1 : (current.referenced || 0),
      stability: newStability,
      last_used: now,
      first_seen: current.first_seen || now,
      recall_intervals: JSON.stringify(intervals),
      query_appearances: current.query_appearances || 0,
    });
  };

  sqliteDb.transaction(() => {
    // Track hits
    nodeIds.forEach(id => processNode(id, false));
    
    // Track referenced
    referencedIds.forEach(id => processNode(id, true));
    
    // Track edge usage (co-occurrence) + hit rate tuning
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const src = nodeIds[i];
        const tgt = nodeIds[j];
        
        // Find existing edge (either direction, any type including classic '')
        const edge = sqliteDb.prepare(`
          SELECT id, weight, hits, tuning_boosts, tuning_decays
          FROM edges
          WHERE (source = ? AND target = ?) OR (source = ? AND target = ?)
          ORDER BY hits DESC LIMIT 1
        `).get(src, tgt, tgt, src);
        
        if (edge) {
          // Get hit rates for both nodes
          const usageA = usageMap.get(src);
          const usageB = usageMap.get(tgt);
          
          let newWeight = edge.weight || 0.5;
          let boostDelta = 0;
          let decayDelta = 0;
          
          if (usageA && usageB) {
            const appA = usageA.query_appearances || 1;
            const appB = usageB.query_appearances || 1;
            const hitRateA = (usageA.referenced || 0) / appA;
            const hitRateB = (usageB.referenced || 0) / appB;
            
            if (hitRateA > 0.5 && hitRateB > 0.5) {
              newWeight = Math.min(newWeight * 1.15, 1.0);
              boostDelta = 1;
            } else if (hitRateA < 0.2 && hitRateB < 0.2) {
              newWeight = Math.max(newWeight * 0.9, 0.1);
              decayDelta = 1;
            } else {
              newWeight = Math.min(newWeight * 1.1, 1.0);
            }
          } else {
            newWeight = Math.min(newWeight * 1.1, 1.0);
          }
          
          sqliteDb.prepare(`
            UPDATE edges SET
              weight        = ?,
              hits          = hits + 1,
              last_used     = ?,
              tuning_boosts = tuning_boosts + ?,
              tuning_decays = tuning_decays + ?
            WHERE id = ?
          `).run(newWeight, now, boostDelta, decayDelta, edge.id);
        } else {
          // Create new co_recall edge
          sqliteDb.prepare(`
            INSERT INTO edges (source, target, type, weight, hits, last_used)
            VALUES (?, ?, 'co_recall', 0.3, 1, ?)
            ON CONFLICT(source, target, type) DO UPDATE SET
              hits      = hits + 1,
              last_used = excluded.last_used
          `).run(src, tgt, now);
        }
      }
    }
    
    // Update lastTracked meta
    db.setMeta('lastTracked', now);
  })();
}

function trackCommand(args) {
  if (!args.length) {
    console.log('Usage: node brain.js track "snippet1" "snippet2" ...');
    process.exit(1);
  }
  
  const brain = loadBrain();
  const allMatched = new Set();
  
  args.forEach(snippet => {
    const matches = findMatchingNodes(snippet, brain);
    matches.forEach(id => allMatched.add(id));
  });
  
  const matchedIds = Array.from(allMatched);
  
  if (matchedIds.length === 0) {
    console.log('❌ No matching nodes found for provided snippets');
    return;
  }
  
  trackUsage(brain, matchedIds);
  
  console.log(`✅ Tracked ${matchedIds.length} nodes:`);
  matchedIds.slice(0, 10).forEach(id => {
    const node = brain.nodes.find(n => n.id === id);
    if (node) {
      console.log(`   • ${id}: ${truncateText(node.text, 80)} (hits: ${node.usage?.hits || 0})`);
    }
  });
}

module.exports = {
  trackUsage,
  trackCommand
};
