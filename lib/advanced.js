/**
 * lib/advanced.js
 * Advanced features: conflicts, watch, feedback, RAPTOR, inference
 */

const fs = require('fs');
const path = require('path');
const { 
  MEMORY_DIR,
  loadBrain, 
  saveBrain, 
  generateStableId, 
  buildAdjacencyMap,
  truncateText,
  sleep 
} = require('./core');
const { OPENAI_API_KEY, callOpenAI, getEmbedding, cosineSimilarity } = require('./embeddings');
const { parseMemoryContent, categorizeNode } = require('./parsing');
const { extractEntities } = require('./ingest');

// ============================================================================
// FEEDBACK COMMAND
// ============================================================================
function feedbackCommand(args) {
  if (args.length < 2) {
    console.log('Usage: node brain.js feedback <node-id> <good|bad>');
    process.exit(1);
  }
  
  const nodeId = args[0];
  const rating = args[1].toLowerCase();
  
  if (rating !== 'good' && rating !== 'bad') {
    console.log('❌ Rating must be "good" or "bad"');
    process.exit(1);
  }
  
  const brain = loadBrain();
  const node = brain.nodes.find(n => n.id === nodeId);
  
  if (!node) {
    console.log(`❌ Node ${nodeId} not found`);
    process.exit(1);
  }
  
  // Initialize feedback if needed
  if (!node.feedback) {
    node.feedback = { good: 0, bad: 0 };
  }
  
  // Update feedback
  if (rating === 'good') {
    node.feedback.good++;
    console.log(`✅ Marked node ${nodeId} as good (total: ${node.feedback.good} good, ${node.feedback.bad} bad)`);
  } else {
    node.feedback.bad++;
    console.log(`❌ Marked node ${nodeId} as bad (total: ${node.feedback.good} good, ${node.feedback.bad} bad)`);
  }
  
  saveBrain(brain);
  
  console.log(`📝 Node: ${truncateText(node.distilled || node.text, 80)}\n`);
}

// ============================================================================
// CHECK-CONFLICTS COMMAND — detect contradictions
// ============================================================================
async function checkConflictsCommand() {
  console.log('🔍 Scanning for contradictions in memory...\n');
  
  const brain = loadBrain();
  const nodesWithEmbeddings = brain.nodes.filter(node => 
    node.embedding && 
    node.embedding.length > 0 && 
    !node.mergedInto
  );
  
  if (nodesWithEmbeddings.length < 2) {
    console.log('❌ Need at least 2 nodes with embeddings for conflict detection');
    return;
  }
  
  console.log(`📊 Analyzing ${nodesWithEmbeddings.length} nodes for conflicts...\n`);
  
  const conflicts = [];
  const similarityThreshold = 0.75; // Lowered from 0.85 — contradictions can be topically similar but disagree
  
  // Find highly similar pairs
  for (let i = 0; i < nodesWithEmbeddings.length; i++) {
    for (let j = i + 1; j < nodesWithEmbeddings.length; j++) {
      const nodeA = nodesWithEmbeddings[i];
      const nodeB = nodesWithEmbeddings[j];
      
      const similarity = cosineSimilarity(nodeA.embedding, nodeB.embedding);
      
      if (similarity > similarityThreshold) {
        // Check for contradiction using GPT-4o-mini
        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: 'You are a fact-checking assistant. Respond with YES or NO, then explain briefly.'
                },
                {
                  role: 'user',
                  content: `Do these two memories contradict each other?\n\nMemory A: ${nodeA.distilled || nodeA.text}\n\nMemory B: ${nodeB.distilled || nodeB.text}\n\nReply YES or NO, then explain briefly.`
                }
              ],
              temperature: 0.1,
              max_tokens: 150
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            const answer = data.choices[0].message.content.trim();
            
            if (answer.toUpperCase().startsWith('YES')) {
              const conflict = {
                nodeA: { id: nodeA.id, text: nodeA.distilled || nodeA.text },
                nodeB: { id: nodeB.id, text: nodeB.distilled || nodeB.text },
                similarity,
                explanation: answer
              };
              conflicts.push(conflict);
              
              // Store conflict in BOTH nodes' metadata
              const now = new Date().toISOString();
              if (!nodeA.conflicts) nodeA.conflicts = [];
              if (!nodeB.conflicts) nodeB.conflicts = [];
              
              nodeA.conflicts.push({
                nodeId: nodeB.id,
                explanation: answer,
                detectedAt: now,
                resolved: false
              });
              
              nodeB.conflicts.push({
                nodeId: nodeA.id,
                explanation: answer,
                detectedAt: now,
                resolved: false
              });
              
              console.log(`⚠️  CONFLICT FOUND:`);
              console.log(`   Node A [${nodeA.id}]: ${truncateText(nodeA.distilled || nodeA.text, 80)}`);
              console.log(`   Node B [${nodeB.id}]: ${truncateText(nodeB.distilled || nodeB.text, 80)}`);
              console.log(`   Similarity: ${similarity.toFixed(3)}`);
              console.log(`   ${answer}\n`);
            }
          }
          
          // Rate limit: small delay between API calls
          await sleep(300);
        } catch (error) {
          console.log(`   ❌ Error checking pair ${nodeA.id}/${nodeB.id}: ${error.message}`);
        }
      }
    }
  }
  
  if (conflicts.length === 0) {
    console.log('✅ No contradictions found!\n');
  } else {
    saveBrain(brain); // Save conflict metadata
    console.log(`\n📊 Found ${conflicts.length} conflicts\n`);
    console.log('💡 Consider reviewing these nodes and merging or updating them.\n');
    console.log('💡 Use: node brain.js resolve <nodeId> <conflictNodeId> to mark as resolved\n');
  }
}

// ============================================================================
// RESOLVE COMMAND — mark conflict as resolved
// ============================================================================
function resolveCommand(args) {
  if (args.length < 2) {
    console.log('Usage: node brain.js resolve <nodeId> <conflictNodeId>');
    console.log('  Marks the conflict between two nodes as resolved');
    process.exit(1);
  }
  
  const nodeId = args[0];
  const conflictNodeId = args[1];
  
  const brain = loadBrain();
  const node = brain.nodes.find(n => n.id === nodeId);
  const conflictNode = brain.nodes.find(n => n.id === conflictNodeId);
  
  if (!node) {
    console.log(`❌ Node ${nodeId} not found`);
    process.exit(1);
  }
  
  if (!conflictNode) {
    console.log(`❌ Conflict node ${conflictNodeId} not found`);
    process.exit(1);
  }
  
  // Mark conflict as resolved in both nodes
  let resolved = false;
  
  if (node.conflicts) {
    const conflict = node.conflicts.find(c => c.nodeId === conflictNodeId);
    if (conflict) {
      conflict.resolved = true;
      conflict.resolvedAt = new Date().toISOString();
      resolved = true;
    }
  }
  
  if (conflictNode.conflicts) {
    const conflict = conflictNode.conflicts.find(c => c.nodeId === nodeId);
    if (conflict) {
      conflict.resolved = true;
      conflict.resolvedAt = new Date().toISOString();
      resolved = true;
    }
  }
  
  if (!resolved) {
    console.log(`⚠️  No conflict found between ${nodeId} and ${conflictNodeId}`);
    return;
  }
  
  saveBrain(brain);
  console.log(`✅ Marked conflict as resolved`);
  console.log(`   Node A: ${truncateText(node.distilled || node.text, 80)}`);
  console.log(`   Node B: ${truncateText(conflictNode.distilled || conflictNode.text, 80)}\n`);
}

// ============================================================================
// WATCH COMMAND — daemon for auto-ingesting new content
// ============================================================================
async function watchCommand() {
  console.log('👁️  Starting watch daemon for memory directory...\n');
  console.log(`📂 Watching: ${MEMORY_DIR}`);
  console.log('🔄 Will auto-ingest new content from .md files');
  console.log('⏹️  Press Ctrl+C to stop\n');
  
  // Track what we've already seen
  const seenIds = new Set();
  const brain = loadBrain();
  brain.nodes.forEach(n => seenIds.add(n.id));
  
  // Scan function
  const scanAndIngest = async (filePath) => {
    try {
      if (!filePath.endsWith('.md')) return;
      
      const content = fs.readFileSync(filePath, 'utf8');
      const fileName = path.basename(filePath);
      
      // Split into sections
      const sections = content.includes('##') 
        ? content.split(/(?=^##\s)/m).filter(s => s.trim().length > 50)
        : (content.trim().length > 20 ? [content.trim()] : []);
      
      for (const section of sections) {
        const text = section.trim();
        const id = generateStableId(text);
        
        // Skip if we've seen it
        if (seenIds.has(id)) continue;
        
        seenIds.add(id);
        
        console.log(`\n📝 New content detected in ${fileName}`);
        console.log(`   Text: ${text.substring(0, 80)}...`);
        
        // Ingest the new section
        try {
          // Parse entities/tags
          const parsed = parseMemoryContent(text);
          const category = categorizeNode(text, parsed.tags);
          
          // Distill
          const distilled = await callOpenAI(text);
          console.log(`   ✅ Distilled`);
          
          // Embed
          const embedding = await getEmbedding(distilled);
          console.log(`   ✅ Embedded`);
          
          // Extract entities
          const extractedEntities = await extractEntities(distilled);
          console.log(`   ✅ Extracted entities`);
          
          // Create node
          const brain = loadBrain();
          const node = {
            id,
            text,
            distilled,
            embedding,
            category,
            sourceFile: `memory/${fileName}`,
            tags: [...parsed.tags, category].filter((t, i, a) => t && a.indexOf(t) === i),
            extractedEntities,
            usage: { hits: 0, referenced: 0, stability: 1.0, lastUsed: null, firstSeen: new Date().toISOString() },
            tier: 'synapse',
          };
          
          // Wire
          let edgeCount = 0;
          if (embedding.length > 0) {
            brain.nodes.forEach(existing => {
              if (existing.mergedInto || !existing.embedding?.length) return;
              const sim = cosineSimilarity(embedding, existing.embedding);
              if (sim > 0.92) {
                brain.edges.push({
                  source: id,
                  target: existing.id,
                  weight: Math.round(sim * 100) / 100,
                  usage: { hits: 0, lastUsed: null }
                });
                edgeCount++;
              }
            });
            
            // Auto-wire orphans
            if (edgeCount === 0) {
              const candidates = brain.nodes
                .filter(existing => !existing.mergedInto && existing.embedding?.length > 0)
                .map(existing => ({
                  id: existing.id,
                  sim: cosineSimilarity(embedding, existing.embedding)
                }))
                .filter(c => c.sim > 0.5)
                .sort((a, b) => b.sim - a.sim)
                .slice(0, 3);
              
              candidates.forEach(c => {
                brain.edges.push({
                  source: id,
                  target: c.id,
                  weight: Math.round(c.sim * 100) / 100,
                  usage: { hits: 0, lastUsed: null }
                });
                edgeCount++;
              });
            }
          }
          
          brain.nodes.push(node);
          saveBrain(brain);
          
          console.log(`   ✅ Ingested node ${id} with ${edgeCount} edges`);
        } catch (error) {
          console.log(`   ❌ Failed to ingest: ${error.message}`);
        }
      }
    } catch (error) {
      console.log(`❌ Error processing ${filePath}: ${error.message}`);
    }
  };
  
  // Initial scan
  const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
  console.log(`🔍 Initial scan of ${files.length} files...`);
  for (const file of files) {
    await scanAndIngest(path.join(MEMORY_DIR, file));
  }
  console.log(`\n✅ Initial scan complete. Now watching for changes...\n`);
  
  // Watch for changes
  fs.watch(MEMORY_DIR, { persistent: true }, async (eventType, filename) => {
    if (!filename || !filename.endsWith('.md')) return;
    
    const filePath = path.join(MEMORY_DIR, filename);
    
    // Debounce: wait 500ms before processing
    await sleep(500);
    
    if (fs.existsSync(filePath)) {
      await scanAndIngest(filePath);
    }
  });
  
  // Keep running
  await new Promise(() => {});
}

// ============================================================================
// AGGLOMERATIVE CLUSTERING (for RAPTOR)
// ============================================================================
/**
 * Agglomerative clustering: merge closest pairs until max cluster size reached
 * @param {Array} items - Array of {id, embedding}
 * @param {number} maxClusterSize - Max items per cluster (8-12)
 * @param {number} similarityThreshold - Min similarity to merge (0.65)
 * @returns {Array} clusters - Array of {centroid, members: [{id, embedding}]}
 */
function agglomerativeClustering(items, maxClusterSize = 10, similarityThreshold = 0.65) {
  if (items.length === 0) return [];
  
  // Start with each item as its own cluster
  let clusters = items.map(item => ({
    members: [item],
    centroid: [...item.embedding] // copy embedding
  }));
  
  // Helper: compute centroid from members
  const computeCentroid = (members) => {
    const dim = members[0].embedding.length;
    const centroid = new Array(dim).fill(0);
    members.forEach(m => {
      m.embedding.forEach((val, idx) => {
        centroid[idx] += val;
      });
    });
    // Average and normalize
    const count = members.length;
    for (let i = 0; i < dim; i++) centroid[i] /= count;
    const mag = Math.sqrt(centroid.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? centroid.map(v => v / mag) : centroid;
  };
  
  // Iteratively merge closest clusters
  while (true) {
    // Find closest pair
    let bestSim = -1;
    let bestI = -1, bestJ = -1;
    
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = cosineSimilarity(clusters[i].centroid, clusters[j].centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }
    
    // Stop if no pair above threshold OR if merging would exceed max size
    if (bestSim < similarityThreshold) break;
    const mergedSize = clusters[bestI].members.length + clusters[bestJ].members.length;
    if (mergedSize > maxClusterSize) break;
    
    // Merge clusters[bestI] and clusters[bestJ]
    const merged = {
      members: [...clusters[bestI].members, ...clusters[bestJ].members],
      centroid: null
    };
    merged.centroid = computeCentroid(merged.members);
    
    // Remove old clusters and add merged
    clusters = [
      ...clusters.slice(0, bestI),
      ...clusters.slice(bestI + 1, bestJ),
      ...clusters.slice(bestJ + 1),
      merged
    ];
  }
  
  return clusters;
}

// ============================================================================
// RAPTOR COMMAND — hierarchical summaries
// ============================================================================
/**
 * Build RAPTOR hierarchy: cluster nodes → summarize → embed → recurse
 * Idempotent: deletes old raptor nodes before rebuilding
 */
async function raptorCommand() {
  console.log('🌳 Building RAPTOR hierarchical summaries...\n');
  
  const brain = loadBrain();
  
  // 1. Delete old raptor nodes (idempotent rebuild)
  const oldRaptorCount = brain.nodes.filter(n => n.tier === 'raptor').length;
  if (oldRaptorCount > 0) {
    console.log(`🗑️  Removing ${oldRaptorCount} old raptor nodes...`);
    const raptorIds = new Set(brain.nodes.filter(n => n.tier === 'raptor').map(n => n.id));
    brain.nodes = brain.nodes.filter(n => n.tier !== 'raptor');
    // Remove edges involving raptor nodes
    brain.edges = brain.edges.filter(e => !raptorIds.has(e.source) && !raptorIds.has(e.target));
  }
  
  // 2. Get all leaf nodes (non-raptor, have embeddings)
  const leafNodes = brain.nodes.filter(n => 
    n.tier !== 'raptor' && 
    n.embedding && 
    n.embedding.length > 0 &&
    !n.mergedInto
  );
  
  if (leafNodes.length < 5) {
    console.log('❌ Need at least 5 embedded nodes to build RAPTOR hierarchy');
    return;
  }
  
  console.log(`📦 Processing ${leafNodes.length} leaf nodes\n`);
  
  // 3. Build level 1: cluster leaf nodes
  let currentLevel = 1;
  let nodesToCluster = leafNodes.map(n => ({ id: n.id, embedding: n.embedding }));
  let allRaptorNodes = [];
  
  while (nodesToCluster.length > 1 && currentLevel <= 3) {
    console.log(`🔄 Level ${currentLevel}: Clustering ${nodesToCluster.length} nodes...`);
    
    // Cluster
    const clusters = agglomerativeClustering(nodesToCluster, 12, 0.65);
    
    if (clusters.length === nodesToCluster.length) {
      // No merging happened — stop
      console.log(`   ⚠️  No clusters formed at level ${currentLevel} (all nodes too dissimilar)`);
      break;
    }
    
    console.log(`   ✅ Formed ${clusters.length} clusters (avg ${Math.round(nodesToCluster.length / clusters.length)} nodes/cluster)`);
    
    // 4. Summarize each cluster into a raptor node
    const newRaptorNodes = [];
    
    for (let clusterIdx = 0; clusterIdx < clusters.length; clusterIdx++) {
      const cluster = clusters[clusterIdx];
      
      // Skip singleton clusters (no need to summarize)
      if (cluster.members.length === 1) {
        console.log(`   ⏭️  Cluster ${clusterIdx + 1}: singleton, skipping`);
        continue;
      }
      
      console.log(`   📝 Cluster ${clusterIdx + 1}: summarizing ${cluster.members.length} nodes...`);
      
      // Get full node objects
      const nodeMap = new Map(brain.nodes.map(n => [n.id, n]));
      const memberNodes = cluster.members.map(m => nodeMap.get(m.id)).filter(Boolean);
      
      // Build summary prompt from distilled texts
      const texts = memberNodes.map(n => n.distilled || n.text).join('\n\n');
      const summaryPrompt = `Summarize the following related facts into a concise overview paragraph (2-4 sentences):\n\n${texts}`;
      
      try {
        // Call LLM for summary
        const summary = await callOpenAI(summaryPrompt, 'gpt-4o-mini');
        console.log(`      ✅ Summary: ${summary.substring(0, 80)}...`);
        
        // Embed the summary
        const summaryEmbedding = await getEmbedding(summary);
        
        // Create raptor node
        const raptorId = generateStableId(`raptor-l${currentLevel}-c${clusterIdx}-${summary}`);
        const raptorNode = {
          id: raptorId,
          text: summary,
          distilled: summary,
          embedding: summaryEmbedding,
          category: 'raptor',
          sourceFile: `raptor-level-${currentLevel}`,
          tags: ['raptor', `level-${currentLevel}`],
          tier: 'raptor',
          raptorLevel: currentLevel,
          childIds: cluster.members.map(m => m.id),
          usage: { hits: 0, referenced: 0, stability: 1.0, lastUsed: null, firstSeen: new Date().toISOString() }
        };
        
        brain.nodes.push(raptorNode);
        newRaptorNodes.push({ id: raptorId, embedding: summaryEmbedding });
        allRaptorNodes.push(raptorNode);
        
        // Create edges from raptor node to children
        cluster.members.forEach(child => {
          brain.edges.push({
            source: raptorId,
            target: child.id,
            type: 'raptor_parent',
            weight: 1.0,
            usage: { hits: 0, lastUsed: null }
          });
        });
        
        await sleep(300); // Rate limit
      } catch (error) {
        console.log(`      ❌ Failed to summarize cluster ${clusterIdx + 1}: ${error.message}`);
      }
    }
    
    console.log(`   ✅ Created ${newRaptorNodes.length} level-${currentLevel} raptor nodes\n`);
    
    // 5. Check if we need next level (if >10 raptor nodes, recurse)
    if (newRaptorNodes.length <= 10) {
      console.log(`🎯 Level ${currentLevel} complete. ${newRaptorNodes.length} summary nodes (≤10, stopping)\n`);
      break;
    }
    
    // Prepare for next level
    nodesToCluster = newRaptorNodes;
    currentLevel++;
  }
  
  // Save
  saveBrain(brain);
  
  console.log(`✅ RAPTOR hierarchy built!`);
  console.log(`   🌲 Total raptor nodes: ${allRaptorNodes.length}`);
  console.log(`   📊 Level distribution:`);
  for (let level = 1; level <= 3; level++) {
    const count = allRaptorNodes.filter(n => n.raptorLevel === level).length;
    if (count > 0) console.log(`      Level ${level}: ${count} nodes`);
  }
  console.log(`\n💡 Test with: node brain.js query -c "what clients does Vlad have"`);
}

// ============================================================================
// INFER COMMAND — Hypothetical Edges (Transitive Inference)
// ============================================================================
async function inferCommand(args = []) {
  const nodeFilter = args[0]; // Optional: single node ID to infer for
  
  console.log('🧠 Discovering implicit connections via transitive inference...\n');
  
  const brain = loadBrain();
  const activeNodes = brain.nodes.filter(n => !n.mergedInto && !n.archived);
  const adjMap = buildAdjacencyMap(brain);
  
  if (activeNodes.length < 3) {
    console.log('❌ Need at least 3 nodes for transitive inference');
    return;
  }
  
  console.log(`📊 Analyzing ${activeNodes.length} active nodes...\n`);
  
  // Build node lookup map
  const nodeMap = new Map();
  activeNodes.forEach(n => nodeMap.set(n.id, n));
  
  // Find transitive candidates: A→B→C where no A→C edge exists
  const candidates = [];
  
  const targetNodes = nodeFilter ? [nodeMap.get(nodeFilter)].filter(Boolean) : activeNodes;
  
  targetNodes.forEach(nodeA => {
    if (!nodeA || !nodeA.embedding || nodeA.embedding.length === 0) return;
    
    // Get neighbors of A (B nodes)
    const neighborsB = adjMap.get(nodeA.id) || [];
    
    neighborsB.forEach(({ id: nodeBId, weight: weightAB }) => {
      const nodeB = nodeMap.get(nodeBId);
      if (!nodeB) return;
      
      // Get neighbors of B (C nodes)
      const neighborsC = adjMap.get(nodeBId) || [];
      
      neighborsC.forEach(({ id: nodeCId, weight: weightBC }) => {
        if (nodeCId === nodeA.id) return; // Skip A→B→A loops
        
        const nodeC = nodeMap.get(nodeCId);
        if (!nodeC || !nodeC.embedding || nodeC.embedding.length === 0) return;
        
        // Check if A→C edge already exists
        const directEdgeExists = brain.edges.some(e =>
          (e.source === nodeA.id && e.target === nodeCId) ||
          (e.source === nodeCId && e.target === nodeA.id)
        );
        
        if (directEdgeExists) return; // Skip if direct edge exists
        
        // Calculate base confidence: min(weight_AB, weight_BC) * 0.7 (damping)
        const baseConfidence = Math.min(weightAB, weightBC) * 0.7;
        
        // Check cosine similarity between A and C embeddings
        const cosineSim = cosineSimilarity(nodeA.embedding, nodeC.embedding);
        
        // Apply embedding boost/kill
        let confidence = baseConfidence;
        if (cosineSim > 0.5) {
          confidence *= 1.3; // Boost if embeddings agree
        } else if (cosineSim < 0.2) {
          return; // Kill inference if topically unrelated
        }
        
        // Only create if confidence > 0.3
        if (confidence > 0.3) {
          candidates.push({
            source: nodeA.id,
            target: nodeCId,
            via: nodeBId,
            confidence,
            cosineSim,
            sourceNode: nodeA,
            targetNode: nodeC
          });
        }
      });
    });
  });
  
  // Deduplicate and sort by confidence
  const uniqueCandidates = new Map();
  candidates.forEach(c => {
    const key = [c.source, c.target].sort().join('|');
    if (!uniqueCandidates.has(key) || uniqueCandidates.get(key).confidence < c.confidence) {
      uniqueCandidates.set(key, c);
    }
  });
  
  const sortedCandidates = Array.from(uniqueCandidates.values())
    .sort((a, b) => b.confidence - a.confidence);
  
  if (sortedCandidates.length === 0) {
    console.log('✅ No new inferred edges found\n');
    return;
  }
  
  console.log(`📊 Found ${sortedCandidates.length} potential inferred connections\n`);
  
  // Create inferred edges
  let created = 0;
  const now = new Date().toISOString();
  
  sortedCandidates.forEach(c => {
    brain.edges.push({
      source: c.source,
      target: c.target,
      type: 'inferred_transitive',
      weight: c.confidence,
      metadata: {
        via: c.via,
        confidence: c.confidence,
        cosineSim: c.cosineSim,
        createdAt: now
      },
      usage: { hits: 0, lastUsed: null }
    });
    created++;
    
    // Log first 10
    if (created <= 10) {
      const viaNode = nodeMap.get(c.via);
      console.log(`   ✅ ${truncateText(c.sourceNode.distilled || c.sourceNode.text, 40)}`);
      console.log(`      → (via ${truncateText(viaNode?.distilled || viaNode?.text || '?', 30)}) →`);
      console.log(`      ${truncateText(c.targetNode.distilled || c.targetNode.text, 40)}`);
      console.log(`      Confidence: ${c.confidence.toFixed(3)}, Cosine: ${c.cosineSim.toFixed(3)}\n`);
    }
  });
  
  if (created > 10) {
    console.log(`   ... and ${created - 10} more\n`);
  }
  
  saveBrain(brain);
  
  console.log(`✅ Inference complete!`);
  console.log(`   🔗 Created ${created} inferred edges`);
  console.log(`   📊 Total edges: ${brain.edges.length}`);
  console.log(`   🧠 Inferred edges: ${brain.edges.filter(e => e.type === 'inferred_transitive').length}\n`);
}

module.exports = {
  feedbackCommand,
  checkConflictsCommand,
  resolveCommand,
  watchCommand,
  agglomerativeClustering,
  raptorCommand,
  inferCommand
};
