/**
 * lib/graph.js
 * Graph operations: rebuild, rewire, promote, fix orphans
 */

const fs = require('fs');
const path = require('path');
const { 
  WORKSPACE,
  MEMORY_DIR,
  UNIFIED_PATH,
  loadBrain, 
  saveBrain, 
  generateStableId, 
  buildAdjacencyMap, 
  isCore, 
  isSingularity, 
  truncateText 
} = require('./core');
const { parseMemoryContent, categorizeNode, findConnections } = require('./parsing');
const { cosineSimilarity } = require('./embeddings');

// ============================================================================
// ENTITY INDEX
// ============================================================================
function buildEntityIndex(brain) {
  const entityIndex = new Map();
  
  brain.nodes.forEach(node => {
    if (!node.extractedEntities || node.merged) return;
    
    const entities = [
      ...(node.extractedEntities.people || []).map(p => p.name),
      ...(node.extractedEntities.companies || []).map(c => c.name),
      ...(node.extractedEntities.tools || []).map(t => t.name),
      ...(node.extractedEntities.topics || [])
    ];
    
    // Deduplicate per node — each node counted once per entity
    const seen = new Set();
    entities.forEach(entityName => {
      const normalizedName = entityName.toLowerCase().trim();
      if (normalizedName.length < 2) return; // Skip single chars
      const key = normalizedName + '::' + node.id;
      if (seen.has(key)) return;
      seen.add(key);
      if (!entityIndex.has(normalizedName)) {
        entityIndex.set(normalizedName, []);
      }
      entityIndex.get(normalizedName).push(node.id);
    });
  });
  
  return entityIndex;
}

// ============================================================================
// REBUILD COMMAND
// ============================================================================
async function rebuildCommand(args) {
  const fullRebuild = args.includes('--full');
  console.log(`🔄 Rebuilding brain graph (merge mode)${fullRebuild ? ' with distillation & embeddings' : ''}...\n`);
  
  // Load existing brain — this is the source of truth for flags
  const brain = loadBrain();
  const existingIds = new Set(brain.nodes.map(n => n.id));
  
  // Build a map of existing nodes by ID for quick lookup
  const nodeMap = new Map();
  brain.nodes.forEach(n => nodeMap.set(n.id, n));
  
  // Scan ALL relevant MD files (expanded scope)
  const memoryFiles = [];
  
  // 1. Root workspace MDs
  const rootMDs = ['MEMORY.md', 'LESSONS.md', 'ROADMAP.md', 'TOOLS.md', 'TODO.md', 'ECOMHERO_AUDIT.md', 'USER.md'];
  rootMDs.forEach(filename => {
    const filePath = path.join(WORKSPACE, filename);
    if (fs.existsSync(filePath)) {
      memoryFiles.push({ path: filePath, name: filename });
    }
  });
  
  // 2. Memory directory files (daily logs + special files)
  if (fs.existsSync(MEMORY_DIR)) {
    // Daily memory files (YYYY-MM-DD*.md)
    const dailyFiles = fs.readdirSync(MEMORY_DIR)
      .filter(file => file.match(/^\d{4}-\d{2}-\d{2}.*\.md$/))
      .sort();
    dailyFiles.forEach(file => {
      memoryFiles.push({ path: path.join(MEMORY_DIR, file), name: `memory/${file}` });
    });
    
    // Non-daily memory files
    const specialMemoryFiles = ['clients.md', 'feedback.md', 'cron-metrics.md'];
    specialMemoryFiles.forEach(filename => {
      const filePath = path.join(MEMORY_DIR, filename);
      if (fs.existsSync(filePath)) {
        memoryFiles.push({ path: filePath, name: `memory/${filename}` });
      }
    });
  }
  
  // 3. Client README files
  const clientFiles = [
    'clients/judaica/README.md',
    'clients/rs/README.md'
  ];
  clientFiles.forEach(relativePath => {
    const filePath = path.join(WORKSPACE, relativePath);
    if (fs.existsSync(filePath)) {
      memoryFiles.push({ path: filePath, name: relativePath });
    }
  });
  
  console.log(`📂 Scanning ${memoryFiles.length} files for new content...\n`);
  
  let added = 0;
  let updated = 0;
  
  memoryFiles.forEach(file => {
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      const sections = content.includes('##') 
        ? content.split(/(?=^##\s)/m).filter(s => s.trim().length > 50)
        : (content.trim().length > 20 ? [content.trim()] : []);
      
      sections.forEach(section => {
        const text = section.trim();
        const id = generateStableId(text);
        
        if (existingIds.has(id)) {
          // Node exists — update text and sourceFile but PRESERVE flags
          const existing = nodeMap.get(id);
          existing.text = text;
          existing.sourceFile = file.name;
          updated++;
        } else {
          // New node — add it (parent chunk)
          const parsed = parseMemoryContent(text);
          const category = categorizeNode(text, parsed.tags);
          
          // Set initial stability based on source file (SM-2 upgrade)
          let initialStability = 1.0;
          if (['MEMORY.md', 'TOOLS.md', 'USER.md', 'SOUL.md'].includes(file.name)) {
            initialStability = 15.0;
          }
          
          const node = {
            id,
            text,
            category,
            sourceFile: file.name,
            tags: [...parsed.tags, category].filter((t, i, a) => t && a.indexOf(t) === i),
            usage: { hits: 0, referenced: 0, stability: initialStability, lastUsed: null, firstSeen: new Date().toISOString(), recallIntervals: [] },
            tier: 'synapse',
          };
          brain.nodes.push(node);
          nodeMap.set(id, node);
          existingIds.add(id);
          added++;
          
          // === UPGRADE 2: Proposition-level chunking will be done in --full mode ===
          // (Deferred to avoid blocking rebuild; propositions created during distill phase)
        }
      });
    } catch (error) {
      console.error(`❌ Error processing ${file.name}:`, error.message);
    }
  });
  
  console.log(`   ➕ ${added} new nodes added`);
  console.log(`   🔄 ${updated} existing nodes refreshed`);
  
  // Rebuild edges for new nodes only (preserve existing edge usage)
  if (added > 0) {
    console.log('\n🔗 Building connections for new nodes...\n');
    const existingEdgeSet = new Set(brain.edges.map(e => [e.source, e.target].sort().join('|')));
    
    brain.nodes.forEach(node => {
      const connections = findConnections(node, brain.nodes);
      connections.forEach(conn => {
        const ek = [node.id, conn.targetId].sort().join('|');
        if (!existingEdgeSet.has(ek)) {
          existingEdgeSet.add(ek);
          brain.edges.push({
            source: node.id,
            target: conn.targetId,
            weight: conn.weight,
            usage: { hits: 0, lastUsed: null }
          });
        }
      });
    });
  }
  
  // Auto-assign singularity to top 5 core nodes by usage
  brain.nodes.forEach(n => { if (n.tier === 'singularity') n.tier = 'core'; });
  const coreByUsage = brain.nodes
    .filter(n => isCore(n))
    .sort((a, b) => (b.usage?.hits || 0) - (a.usage?.hits || 0));
  coreByUsage.slice(0, 5).forEach(n => { n.tier = 'singularity'; });
  
  brain.lastUpdated = new Date().toISOString();
  saveBrain(brain);
  
  const coreCount = brain.nodes.filter(n => isCore(n)).length;
  const singCount = brain.nodes.filter(n => isSingularity(n)).length;
  const synCount = brain.nodes.length - coreCount;
  
  console.log(`\n✅ Rebuild complete!`);
  console.log(`   📊 ${brain.nodes.length} nodes (${added} new)`);
  console.log(`   🔗 ${brain.edges.length} edges`);
  console.log(`   ✦ ${singCount} singularity`);
  console.log(`   ◆ ${coreCount} core`);
  console.log(`   ○ ${synCount} synapses`);
  console.log(`   💾 Saved to constellation.db\n`);
  
  // Run distillation and embeddings if --full flag is passed
  if (fullRebuild) {
    console.log('🧠 Running full brain upgrade (distillation + embeddings + entities + rewire)...\n');
    
    try {
      // These will be imported from lib/ingest.js
      const { distillCommand, embedCommand, extractCommand } = require('./ingest');
      
      // Run distillation
      await distillCommand();
      console.log('');
      
      // Run embeddings
      await embedCommand();
      console.log('');
      
      // Run entity extraction
      await extractCommand();
      console.log('');
      
      // Run rewiring
      rewireCommand();
      console.log('');
      
      console.log('🚀 Full brain upgrade complete!\n');
    } catch (error) {
      console.log(`❌ Brain upgrade failed: ${error.message}\n`);
    }
  }
}

// ============================================================================
// REWIRE COMMAND
// ============================================================================
function rewireCommand() {
  console.log('🔗 Building typed edges from extracted entities...\n');
  
  const brain = loadBrain();
  const nodesWithEntities = brain.nodes.filter(node => node.extractedEntities);
  
  if (nodesWithEntities.length === 0) {
    console.log('❌ No nodes with extracted entities found. Run: node brain.js extract');
    return;
  }
  
  console.log(`🏗️  Processing ${nodesWithEntities.length} nodes with entities...\n`);
  
  // Build entity index
  const entityIndex = buildEntityIndex(brain);
  console.log(`📊 Built index for ${entityIndex.size} unique entities`);
  
  // Separate typed edges from existing edges
  if (!brain.edges) brain.edges = [];
  
  // Remove old typed edges (we'll rebuild them)
  brain.edges = brain.edges.filter(edge => edge.type !== 'shared_entity');
  
  let newEdges = 0;
  const entityEdges = [];
  
  // Create shared entity edges
  entityIndex.forEach((nodeIds, entityName) => {
    if (nodeIds.length < 2) return; // Skip entities mentioned by only one node
    if (nodeIds.length > 5) return; // Skip overly common entities (IDF filter — too generic to be meaningful)
    
    // Create edges between all nodes that mention this entity
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const sourceId = nodeIds[i];
        const targetId = nodeIds[j];
        
        // Check if edge already exists
        const existingEdge = entityEdges.find(e =>
          (e.source === sourceId && e.target === targetId) ||
          (e.source === targetId && e.target === sourceId)
        );
        
        if (existingEdge) {
          // Increment weight for shared entities
          existingEdge.weight += 0.5;
          existingEdge.sharedEntities.push(entityName);
        } else {
          // Create new typed edge
          entityEdges.push({
            source: sourceId,
            target: targetId,
            type: 'shared_entity',
            weight: 0.5,
            sharedEntities: [entityName],
            usage: { hits: 0, lastUsed: null }
          });
        }
      }
    }
  });
  
  // Add relationship edges from extractedEntities (only for rare entities)
  nodesWithEntities.forEach(node => {
    const relationships = node.extractedEntities.relationships || [];
    
    relationships.forEach(rel => {
      // Find nodes that mention the "to" entity
      const fromEntity = rel.from.toLowerCase().trim();
      const toEntity = rel.to.toLowerCase().trim();
      
      const toNodes = entityIndex.get(toEntity) || [];
      // Skip if "to" entity is too common (same IDF filter as shared entities)
      if (toNodes.length > 5) return;
      
      toNodes.forEach(toNodeId => {
        if (toNodeId === node.id) return; // Skip self-references
        
        const existingEdge = entityEdges.find(e =>
          (e.source === node.id && e.target === toNodeId) ||
          (e.source === toNodeId && e.target === node.id)
        );
        
        if (existingEdge) {
          if (!existingEdge.relationships) existingEdge.relationships = [];
          existingEdge.relationships.push(rel);
          existingEdge.weight += 0.3;
        } else {
          entityEdges.push({
            source: node.id,
            target: toNodeId,
            type: 'shared_entity',
            weight: 0.3,
            relationships: [rel],
            usage: { hits: 0, lastUsed: null }
          });
        }
      });
    });
  });
  
  // Add new typed edges to brain
  brain.edges.push(...entityEdges);
  newEdges = entityEdges.length;
  
  saveBrain(brain);
  
  console.log(`\n✅ Rewiring complete!`);
  console.log(`   🔗 ${newEdges} new typed edges created`);
  console.log(`   📊 Total edges: ${brain.edges.length}`);
  console.log(`   🏷️  Typed edges: ${brain.edges.filter(e => e.type).length}`);
  console.log(`   📝 Classic edges: ${brain.edges.filter(e => !e.type).length}\n`);
}

// ============================================================================
// FIX ORPHANS COMMAND
// ============================================================================
function fixOrphansCommand() {
  console.log('🔗 Wiring orphan nodes with relaxed thresholds...\n');
  
  const brain = loadBrain();
  const edgeNodeIds = new Set();
  brain.edges.forEach(e => { edgeNodeIds.add(e.source); edgeNodeIds.add(e.target); });
  
  const orphans = brain.nodes.filter(n => !edgeNodeIds.has(n.id) && !n.mergedInto && n.embedding?.length > 0);
  const connected = brain.nodes.filter(n => edgeNodeIds.has(n.id) && !n.mergedInto && n.embedding?.length > 0);
  
  if (orphans.length === 0) {
    console.log('✅ No orphan nodes found!');
    return;
  }
  
  console.log(`🔍 Found ${orphans.length} orphans. Searching for connections (threshold: 0.6)...\n`);
  
  let wired = 0;
  const existingEdgeSet = new Set(brain.edges.map(e => [e.source, e.target].sort().join('|')));
  
  orphans.forEach(orphan => {
    // Find best matches among ALL nodes (connected + other orphans)
    const candidates = brain.nodes
      .filter(n => n.id !== orphan.id && !n.mergedInto && n.embedding?.length > 0)
      .map(n => ({ id: n.id, sim: cosineSimilarity(orphan.embedding, n.embedding) }))
      .filter(c => c.sim > 0.6)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5); // max 5 edges per orphan
    
    candidates.forEach(c => {
      const ek = [orphan.id, c.id].sort().join('|');
      if (!existingEdgeSet.has(ek)) {
        existingEdgeSet.add(ek);
        brain.edges.push({
          source: orphan.id,
          target: c.id,
          weight: Math.round(c.sim * 100) / 100,
          usage: { hits: 0, lastUsed: null }
        });
        wired++;
      }
    });
    
    if (candidates.length > 0) {
      console.log(`   ✅ ${orphan.id} → ${candidates.length} edges (best: ${candidates[0].sim.toFixed(3)})`);
    } else {
      console.log(`   ⚠️  ${orphan.id} — no matches above 0.6`);
    }
  });
  
  saveBrain(brain);
  
  // Recount orphans
  const newEdgeNodes = new Set();
  brain.edges.forEach(e => { newEdgeNodes.add(e.source); newEdgeNodes.add(e.target); });
  const remainingOrphans = brain.nodes.filter(n => !newEdgeNodes.has(n.id) && !n.mergedInto).length;
  
  console.log(`\n✅ Wired ${wired} new edges. Remaining orphans: ${remainingOrphans}`);
  console.log(`   📊 Total edges: ${brain.edges.length}\n`);
}

// ============================================================================
// PROMOTE COMMAND
// ============================================================================
function isCoreCandidate(node, brain, adjMap) {
  const connections = (adjMap.get(node.id) || []).length;
  const usageHits = node.usage?.hits || 0;
  
  // Already core
  if (isCore(node)) return null;
  
  // Highly connected nodes
  if (connections >= 5) return node.category;
  
  // High usage nodes
  if (usageHits >= 10) return node.category;
  
  // Critical categories with decent connections
  const criticalCategories = ['identity', 'client', 'strategy', 'infrastructure', 'relationship'];
  if (criticalCategories.includes(node.category) && connections >= 3) {
    return node.category;
  }
  
  return null;
}

function promoteCommand() {
  console.log('🎯 Scanning for core promotion candidates...\n');
  
  const brain = loadBrain();
  const currentCore = brain.nodes.filter(n => isCore(n));
  
  console.log(`📋 Current core: ${currentCore.length} nodes\n`);
  
  const candidates = [];
  const adjMap = buildAdjacencyMap(brain);
  
  brain.nodes.forEach(node => {
    const category = isCoreCandidate(node, brain, adjMap);
    if (category) {
      const connections = (adjMap.get(node.id) || []).length;
      const score = connections * 0.5 + 
                    (node.usage?.hits || 0) * 0.3;
      
      candidates.push({
        node,
        category,
        score
      });
    }
  });
  
  candidates.sort((a, b) => b.score - a.score);
  
  if (candidates.length === 0) {
    console.log('✅ No promotion candidates found. Core is stable.\n');
    return;
  }
  
  console.log(`🔍 Found ${candidates.length} candidates:\n`);
  
  candidates.slice(0, 10).forEach((c, i) => {
    console.log(`   ${i+1}. [${c.category}] ${truncateText(c.node.text, 70)} (score: ${c.score.toFixed(1)})`);
  });
  
  // Promote top 5
  const toPromote = candidates.slice(0, 5);
  let promoted = 0;
  
  toPromote.forEach(c => {
    c.node.tier = 'core';
    promoted++;
  });
  
  // Auto-assign singularity to top 5 core nodes by usage
  brain.nodes.filter(n => isCore(n)).forEach(n => { n.tier = 'core'; }); // reset singularity
  const coreByUsage = brain.nodes
    .filter(n => isCore(n))
    .sort((a, b) => (b.usage?.hits || 0) - (a.usage?.hits || 0));
  coreByUsage.slice(0, 5).forEach(n => { n.tier = 'singularity'; });
  if (promoted > 0 || true) {
    saveBrain(brain);
    if (promoted > 0) {
      console.log(`\n✅ Promoted ${promoted} nodes to Core:`);
      toPromote.forEach(c => {
        console.log(`   ✨ ${c.node.id} [${c.category}] ${truncateText(c.node.text, 70)}`);
      });
    }
    const singCount = brain.nodes.filter(n => isSingularity(n)).length;
    const coreCount = brain.nodes.filter(n => isCore(n)).length;
    const synCount = brain.nodes.length - coreCount;
    console.log(`\n📊 ✦ ${singCount} singularity | ◆ ${coreCount} core | ○ ${synCount} synapses\n`);
  }
}

module.exports = {
  buildEntityIndex,
  rebuildCommand,
  rewireCommand,
  fixOrphansCommand,
  isCoreCandidate,
  promoteCommand
};
