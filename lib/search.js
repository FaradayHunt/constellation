/**
 * lib/search.js
 * Query command and graph traversal for memory search
 * 
 * Changes from JSON version:
 * - Uses db.getNodesWithEmbeddings() for faster embedding-only load
 * - Dropped LLM reranking (rerankWithCrossEncoder) — saves 1 API call per query
 * - Dropped query expansion (expandQuery) — saves 1 API call per query
 * - All other scoring logic (BM25+RRF, MMR, Ebbinghaus, category boosts) preserved
 */

const { 
  loadBrain, 
  saveBrain, 
  buildAdjacencyMap, 
  isCore, 
  truncateText 
} = require('./core');
const { 
  tokenize, 
  buildBM25Index, 
  bm25Score, 
  reciprocalRankFusion 
} = require('./bm25');
const { 
  getEmbedding, 
  getEmbeddings,
  cosineSimilarity 
} = require('./embeddings');
const { 
  calculateRelevance, 
  calculateImportance 
} = require('./parsing');
const { trackUsage } = require('./tracking');
const path = require('path');
const db = require('./db');
const { addQueryMiss } = require('./db');

// ============================================================================
// GRAPH TRAVERSAL
// ============================================================================
function getConnectedNodes(brain, nodeId, hops = 3, adjMap = null) {
  const adj = adjMap || buildAdjacencyMap(brain);
  const nodeMap = new Map();
  brain.nodes.forEach(n => nodeMap.set(n.id, n));
  
  const visited = new Set([nodeId]);
  const connected = [];
  
  // Quality gate: require higher edge weight for deeper hops
  // Hop 1: weight >= 0.3 (broad), Hop 2: >= 0.5 (moderate), Hop 3: >= 0.7 (strict)
  const minWeightByHop = [0.3, 0.5, 0.7];
  
  const traverse = (currentId, hopLevel) => {
    if (hopLevel >= hops) return;
    
    const minWeight = minWeightByHop[hopLevel] || 0.7;
    const neighbors = adj.get(currentId) || [];
    
    // Sort by weight, take top 5 per node to prevent fan-out explosion
    const topNeighbors = neighbors
      .filter(n => n.weight >= minWeight)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
    
    topNeighbors.forEach(({ id: connectedId, weight }) => {
      if (!visited.has(connectedId)) {
        visited.add(connectedId);
        const connectedNode = nodeMap.get(connectedId);
        if (connectedNode && !connectedNode.mergedInto) {
          connected.push({
            ...connectedNode,
            connectionWeight: weight,
            hopsAway: hopLevel + 1
          });
          traverse(connectedId, hopLevel + 1);
        }
      }
    });
  };
  
  traverse(nodeId, 0);
  return connected;
}

// ============================================================================
// QUERY COMMAND
// ============================================================================
async function queryCommand(args) {
  // Parse flags
  let customThreshold = null;
  let recentBoost = false;
  let compactMode = false;
  let feedbackNodeIds = [];
  const filteredArgs = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && i + 1 < args.length) {
      customThreshold = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--recent') {
      recentBoost = true;
    } else if (args[i] === '--compact' || args[i] === '-c') {
      compactMode = true;
    } else if ((args[i] === '--feedback' || args[i] === '-f') && i + 1 < args.length) {
      feedbackNodeIds = args[i + 1].split(',').map(id => id.trim());
      i++;
    } else if (args[i] === '--no-rerank' || args[i] === '-R') {
      // Reranking has been removed; flag accepted but ignored for compat
    } else {
      filteredArgs.push(args[i]);
    }
  }
  
  const query = filteredArgs.join(' ');
  if (!query) {
    console.log('Usage: node brain.js query [--threshold 0.3] [--recent] [-c] [-f node1,node2] "search terms"');
    console.log('  -c, --compact: Output compact JSON for LLM');
    console.log('  -f, --feedback: Comma-separated node IDs that were useful (tracks referenced)');
    process.exit(1);
  }
  
  const confidenceThreshold = customThreshold !== null ? customThreshold : 0.15;
  
  // Load brain (full, with embeddings) from SQLite
  const brain = loadBrain();
  if (!brain.nodes.length) {
    console.log('No brain data found. Run: node brain.js rebuild');
    process.exit(1);
  }
  
  // Nodes with embeddings for semantic search
  const nodesWithEmbeddings = brain.nodes.filter(node => node.embedding && node.embedding.length > 0);
  let useEmbeddings = nodesWithEmbeddings.length > 0;
  
  let results = [];
  let includedIds = new Set();
  let cachedQueryEmbedding = null;
  
  if (useEmbeddings) {
    if (!compactMode) console.log(`🔍 Query: "${query}" (using BM25+RRF hybrid + MMR + Ebbinghaus decay)\n`);
    
    try {
      // Use query directly (no LLM expansion — saves 1 API call)
      const queryEmbedding = await getEmbedding(query);
      cachedQueryEmbedding = queryEmbedding;
      const queryTokens = tokenize(query);
      
      // === DATE FILTER: detect date patterns and filter nodes ===
      const queryLower = query.toLowerCase();
      let dateFilter = null;
      
      // Check for YYYY-MM-DD
      const isoMatch = query.match(/(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) {
        dateFilter = isoMatch[1];
      }
      // Check for month + day
      const monthNames = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
        july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
        jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
      if (!dateFilter) {
        const monthMatch = queryLower.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/);
        if (monthMatch) {
          const mm = monthNames[monthMatch[1]];
          const dd = monthMatch[2].padStart(2, '0');
          dateFilter = `2026-${mm}-${dd}`;
        }
      }
      if (!dateFilter && queryLower.includes('yesterday')) {
        const d = new Date(); d.setDate(d.getDate() - 1);
        dateFilter = d.toISOString().split('T')[0];
      }
      if (!dateFilter && queryLower.includes('today')) {
        dateFilter = new Date().toISOString().split('T')[0];
      }
      
      if (dateFilter && !compactMode) {
        console.log(`📅 Date filter detected: ${dateFilter}\n`);
      }
      
      // === CATEGORY BOOST ===
      const categoryBoosts = new Map();
      const categoryKeywords = {
        lesson: ['lesson', 'lessons', 'learned', 'mistake', 'mistakes', 'error', 'errors', 'wrong', 'avoid', 'feedback', 'insight'],
        client: ['client', 'clients', 'account', 'accounts', 'brand', 'brands'],
        strategy: ['strategy', 'strategic', 'plan', 'roadmap', 'goal', 'goals', 'direction', 'wealth', 'scale', 'growth'],
        infrastructure: ['infrastructure', 'cron', 'server', 'setup', 'deploy', 'config', 'gateway', 'browser'],
        identity: ['who am i', 'who is', 'identity', 'agent', 'mother', 'sola', 'hunter'],
        relationship: ['relationship', 'contact', 'person', 'people', 'who', 'owner', 'designer']
      };
      
      Object.entries(categoryKeywords).forEach(([cat, keywords]) => {
        const matches = keywords.filter(kw => queryLower.includes(kw)).length;
        if (matches > 0) {
          categoryBoosts.set(cat, 0.08 * matches);
        }
      });
      
      if (categoryBoosts.size > 0 && !compactMode) {
        console.log(`🏷️  Category boost: ${[...categoryBoosts.entries()].map(([c,v]) => `${c} +${v.toFixed(2)}`).join(', ')}\n`);
      }
      
      // Helper function to parse date from source filename or created date
      const getNodeDate = (node) => {
        const dateMatch = (node.sourceFile || '').match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) return new Date(dateMatch[1]);
        if (node.usage?.firstSeen) return new Date(node.usage.firstSeen);
        return new Date('2020-01-01');
      };
      
      // === Build BM25 index and run BM25 search ===
      const bm25Index = buildBM25Index(nodesWithEmbeddings);
      const bm25Results = nodesWithEmbeddings.map(node => ({
        id: node.id,
        score: bm25Score(queryTokens, node.id, bm25Index)
      }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);
      
      // === Ebbinghaus temporal decay ===
      const now = new Date();
      const applyEbbinghausDecay = (node) => {
        if (node.sourceFile === 'MEMORY.md') return 1.0;
        const lastUsed = node.usage?.lastUsed ? new Date(node.usage.lastUsed) : new Date(0);
        const daysSinceAccess = (now - lastUsed) / (1000 * 60 * 60 * 24);
        const baseStability = node.core ? 10.0 : (node.tier === 'raptor' ? 5.0 : 1.0);
        const stability = Math.max(node.usage?.stability || 1.0, baseStability);
        return Math.exp(-daysSinceAccess / stability);
      };
      
      // === TEMPORAL SIGNAL DETECTION (Phase 3) ===
      const temporalSignals = ['today', 'recent', 'latest', 'this week', 'yesterday', 'last week', 'this month', 'last month', 'now', 'current'];
      const hasTemporalSignal = temporalSignals.some(signal => queryLower.includes(signal));
      const recencyWeight = hasTemporalSignal ? 0.35 : 0.20; // Phase 3: boost recency only for temporal queries
      
      if (hasTemporalSignal && !compactMode) {
        console.log(`⏰ Temporal signal detected — recency weight: ${recencyWeight}\n`);
      }
      
      // === SPREADING ACTIVATION: Build co-retrieval heat map ===
      // Edges that are frequently co-recalled together get higher weight
      // This makes "hot paths" (e.g., Klaviyo↔RS) boost each other in results
      const coRetrievalHeat = new Map(); // nodeId → total heat from co-retrieval edges
      const sqliteDb = require('./db').getDb();
      
      try {
        // Get top co-recall edges (sorted by hits, limit 500 for perf)
        const hotEdges = sqliteDb.prepare(`
          SELECT source, target, hits, weight
          FROM edges
          WHERE type = 'co_recall' AND hits >= 3
          ORDER BY hits DESC
          LIMIT 500
        `).all();
        
        // Build heat map: nodes on hot co-recall paths get a boost
        hotEdges.forEach(edge => {
          const heat = Math.min(edge.hits * 0.01, 0.15); // Cap at +0.15 boost
          coRetrievalHeat.set(edge.source, (coRetrievalHeat.get(edge.source) || 0) + heat);
          coRetrievalHeat.set(edge.target, (coRetrievalHeat.get(edge.target) || 0) + heat);
        });
        
        if (coRetrievalHeat.size > 0 && !compactMode) {
          console.log(`🔥 Spreading activation: ${coRetrievalHeat.size} nodes on hot paths (${hotEdges.length} co-recall edges)\n`);
        }
      } catch (e) {
        // Silent fail — DB might not have co_recall edges yet
      }

      // Score all nodes with embeddings (cosine similarity)
      // Phase 3: Raised relevance floor from 0.1 to 0.3 to filter garbage
      const cosineResults = nodesWithEmbeddings.map(node => {
        const similarity = cosineSimilarity(queryEmbedding, node.embedding);
        return { id: node.id, score: similarity };
      })
      .filter(r => r.score > 0.3)
      .sort((a, b) => b.score - a.score);
      
      // Apply Reciprocal Rank Fusion (RRF)
      const fusedResults = reciprocalRankFusion([cosineResults, bm25Results], 60);
      
      // Build scored nodes from fused results
      let scoredNodes = fusedResults.map(fusedItem => {
        const node = nodesWithEmbeddings.find(n => n.id === fusedItem.id);
        if (!node) return null;
        
        const similarity = cosineResults.find(r => r.id === node.id)?.score || 0;
        const bm25 = bm25Results.find(r => r.id === node.id)?.score || 0;
        
        const hits = node.usage?.hits || 0;
        const referenced = node.usage?.referenced || 0;
        const maxHits = Math.max(...brain.nodes.map(n => (n.usage?.hits || 0) + (n.usage?.referenced || 0) * 3), 1);
        const usageScore = Math.min((hits + referenced * 3) / maxHits, 1);
        
        const recencyScore = applyEbbinghausDecay(node);
        
        const normalizedBm25 = bm25Results.length > 0 ? bm25 / (bm25Results[0]?.score || 1) : 0;
        // Phase 3: Use dynamic recencyWeight (20% default, 35% for temporal queries)
        let totalScore = (similarity * 0.45 + normalizedBm25 * 0.25 + recencyScore * recencyWeight) * (1.0 + usageScore * 0.15);
        
        // New node boost: nodes created in last 48h get a relevance boost
        // so they aren't buried by old nodes with accumulated usage history
        const createdAt = node.createdAt ? new Date(node.createdAt).getTime() : 0;
        const ageHours = createdAt ? (Date.now() - createdAt) / (1000 * 60 * 60) : Infinity;
        if (ageHours < 48) {
          const freshness = 1 - (ageHours / 48); // 1.0 at birth → 0.0 at 48h
          totalScore *= (1.0 + freshness * 0.20); // up to 20% boost
        }
        
        // Hit rate scoring
        const queryAppearances = node.usage?.queryAppearances || 0;
        if (queryAppearances >= 5) {
          const hitRate = (node.usage?.referenced || 0) / Math.max(queryAppearances, 1);
          const hitRateMultiplier = 0.85 + hitRate * 0.3;
          totalScore *= hitRateMultiplier;
        }
        
        // Spreading activation: boost nodes on frequently co-recalled paths
        // Cap total heat at 0.15 to prevent co-recall popularity from drowning relevance
        const activationHeat = Math.min(coRetrievalHeat.get(node.id) || 0, 0.15);
        if (activationHeat > 0) {
          totalScore += activationHeat;
        }
        
        // Feedback weight
        if (node.feedback) {
          totalScore += (node.feedback.good * 0.05) - (node.feedback.bad * 0.03);
        }
        
        // Category boost
        const catBoost = categoryBoosts.get(node.category) || 0;
        totalScore += catBoost;
        
        // Date filter boost/penalty
        let dateMatch = false;
        if (dateFilter) {
          const nodeSourceDate = (node.sourceFile || '').match(/(\d{4}-\d{2}-\d{2})/);
          if (nodeSourceDate && nodeSourceDate[1] === dateFilter) {
            totalScore += 0.3;
            dateMatch = true;
          } else if (nodeSourceDate) {
            totalScore *= 0.5;
          }
        }
        
        return {
          ...node,
          similarity,
          bm25,
          usageScore,
          recencyScore,
          totalScore,
          dateMatch
        };
      }).filter(node => node !== null);
      
      // Apply temporal boost if --recent flag
      if (recentBoost) {
        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
        
        scoredNodes.forEach(node => {
          const nodeDate = getNodeDate(node);
          if (nodeDate >= sevenDaysAgo) {
            node.totalScore *= 2.0;
          } else if (nodeDate >= thirtyDaysAgo) {
            node.totalScore *= 1.3;
          }
        });
        
        if (!compactMode) console.log(`🕐 Recent boost applied (7d: 2x, 30d: 1.3x)\n`);
      }
      
      scoredNodes.sort((a, b) => b.totalScore - a.totalScore);
      
      // Apply MMR (Maximal Marginal Relevance) — lambda=0.85 (85% relevance, 15% diversity)
      const lambda = 0.85;
      const maxResults = 10;
      const selectedNodes = [];
      
      if (scoredNodes.length > 0) {
        selectedNodes.push(scoredNodes[0]);
        scoredNodes = scoredNodes.slice(1);
        
        while (selectedNodes.length < maxResults && scoredNodes.length > 0) {
          let bestIdx = 0;
          let bestScore = -Infinity;
          
          for (let i = 0; i < scoredNodes.length; i++) {
            const candidate = scoredNodes[i];
            let maxSimilarityToSelected = 0;
            for (const selected of selectedNodes) {
              const sim = cosineSimilarity(candidate.embedding, selected.embedding);
              maxSimilarityToSelected = Math.max(maxSimilarityToSelected, sim);
            }
            const mmrScore = lambda * candidate.totalScore - (1 - lambda) * maxSimilarityToSelected;
            if (mmrScore > bestScore) {
              bestScore = mmrScore;
              bestIdx = i;
            }
          }
          
          selectedNodes.push(scoredNodes[bestIdx]);
          scoredNodes.splice(bestIdx, 1);
        }
      }
      
      // Check confidence
      const bestConfidence = selectedNodes.length > 0 ? Math.max(selectedNodes[0].similarity || 0, selectedNodes[0].bm25 || 0, selectedNodes[0].totalScore || 0) : 0;
      if (selectedNodes.length > 0 && bestConfidence < confidenceThreshold) {
        if (!compactMode) {
          console.log(`⚠️  Low confidence — no strong matches found. Best match: ${selectedNodes[0].similarity.toFixed(3)}`);
          console.log(`💡 Try memory_search as fallback for broader coverage.\n`);
        }
        trackUsage(brain, selectedNodes.slice(0, 5).map(n => n.id));
        return;
      }
      
      // === DEDUP: remove near-duplicate results (cosine > 0.92) ===
      const dedupedNodes = [];
      for (const node of selectedNodes) {
        let isDupe = false;
        for (const kept of dedupedNodes) {
          if (node.embedding && kept.embedding) {
            const sim = cosineSimilarity(node.embedding, kept.embedding);
            if (sim > 0.92) { isDupe = true; break; }
          }
        }
        if (!isDupe) dedupedNodes.push(node);
      }

      // === SOURCE DIVERSITY: max 3 results from same sourceFile ===
      const sourceCounts = new Map();
      const diverseNodes = [];
      for (const node of dedupedNodes) {
        const src = node.sourceFile || 'unknown';
        const count = sourceCounts.get(src) || 0;
        if (count < 3) {
          diverseNodes.push(node);
          sourceCounts.set(src, count + 1);
        }
      }

      // === ☄️ COMET RERANKING (local Ollama LLM, ~200-500ms) ===
      let finalNodes = diverseNodes;
      try {
        const { execSync } = require('child_process');
        const cometInput = diverseNodes.map(n => ({
          id: n.id,
          d: (n.distilled || n.text || '').substring(0, 200),
          sc: n.totalScore
        }));
        const result = execSync(
          `node ${path.join(__dirname, '..', 'comet.js')} rerank ${JSON.stringify(query).replace(/'/g, "\\'")} '${JSON.stringify(cometInput).replace(/'/g, "\\'")}'`,
          { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const parsed = JSON.parse(result.trim());
        if (parsed.reranked && parsed.results?.length > 0) {
          // Map back to full nodes in comet's order
          const idOrder = parsed.results.map(r => r.id);
          const nodeMap = new Map(diverseNodes.map(n => [n.id, n]));
          const reranked = idOrder.map(id => nodeMap.get(id)).filter(Boolean);
          // Add any nodes comet didn't rank
          diverseNodes.forEach(n => { if (!idOrder.includes(n.id)) reranked.push(n); });
          finalNodes = reranked;
          if (!compactMode) console.log(`☄️  Comet reranked ${idOrder.length} results\n`);
        }
      } catch (e) {
        // Comet unavailable (Ollama down) — silent fallback to embedding order
      }

      // Build results with connections (gate 2-hop: connected must have cosine > 0.25)
      const adjMap = buildAdjacencyMap(brain);
      for (const node of finalNodes) {
        if (!includedIds.has(node.id)) {
          const connected = getConnectedNodes(brain, node.id, 2, adjMap)
            .filter(c => {
              if (c.embedding && queryEmbedding) {
                return cosineSimilarity(queryEmbedding, c.embedding) > 0.25;
              }
              return true;
            })
            .sort((a, b) => b.connectionWeight - a.connectionWeight)
            .slice(0, 2);
          
          results.push({
            ...node,
            type: 'primary',
            connectedNodes: connected
          });
          
          includedIds.add(node.id);
          connected.forEach(c => includedIds.add(c.id));
        }
      }
    } catch (error) {
      if (!compactMode) {
        console.log(`⚠️  Embeddings search failed: ${error.message}`);
        console.log('Falling back to keyword search...\n');
      }
      useEmbeddings = false;
    }
  }
  
  // Fallback to keyword search
  if (!useEmbeddings || results.length === 0) {
    if (!compactMode) console.log(`🔍 Query: "${query}" (using keywords)\n`);
    
    const terms = query.split(/\s+/).filter(t => t.length > 2);
    
    const scoredNodes = brain.nodes.map(node => {
      const relevanceScore = calculateRelevance(node, terms);
      const importanceScore = calculateImportance(node, brain.nodes);
      
      return {
        ...node,
        relevanceScore,
        importanceScore,
        totalScore: relevanceScore * importanceScore
      };
    }).filter(node => node.relevanceScore > 0);
    
    scoredNodes.sort((a, b) => b.totalScore - a.totalScore);
    
    results = [];
    includedIds = new Set();
    const adjMap2 = buildAdjacencyMap(brain);
    
    for (const node of scoredNodes.slice(0, 10)) {
      if (!includedIds.has(node.id)) {
        const connected = getConnectedNodes(brain, node.id, 2, adjMap2)
          .sort((a, b) => b.connectionWeight - a.connectionWeight)
          .slice(0, 3);
        
        results.push({
          ...node,
          type: 'primary',
          connectedNodes: connected
        });
        
        includedIds.add(node.id);
        connected.forEach(c => includedIds.add(c.id));
      }
    }
  }
  
  // === AUTO-TRACK QUERY APPEARANCES ===
  results.forEach(result => {
    const node = brain.nodes.find(n => n.id === result.id);
    if (node) {
      if (!node.usage) {
        node.usage = { hits: 0, referenced: 0, stability: 1.0, lastUsed: null, firstSeen: new Date().toISOString(), recallIntervals: [] };
      }
      if (!node.usage.queryAppearances) node.usage.queryAppearances = 0;
      node.usage.queryAppearances++;
    }
  });
  
  // Increment total queries tracked
  brain.totalQueriesTracked = (brain.totalQueriesTracked || 0) + 1;
  
  // === AUTO-NEGATIVE SIGNAL: Track query misses ===
  const bestScore = results.length > 0 ? (results[0].totalScore || results[0].similarity || 0) : 0;
  if (results.length === 0 || bestScore < 0.3) {
    // Insert directly into DB (bypass brain.queryMisses to avoid count drift)
    addQueryMiss({
      query: query,
      timestamp: new Date().toISOString(),
      topScore: bestScore,
      resultCount: results.length,
    });
  }
  
  // === PHASE 3: LOG MISS PATTERNS ===
  // Log when query returns <3 results above 0.4 relevance threshold
  const highRelevanceResults = results.filter(r => (r.similarity || 0) > 0.4);
  if (highRelevanceResults.length < 3 && !compactMode) {
    console.log(`⚠️  MISS PATTERN: Only ${highRelevanceResults.length} results above 0.4 relevance threshold`);
    console.log(`   Query: "${query}"`);
    console.log(`   Best score: ${results.length > 0 ? results[0].similarity?.toFixed(3) : 'N/A'}`);
    console.log(`   💡 Consider ingesting more content on this topic\n`);
    
    // Log to file for analysis
    const fs = require('fs');
    const logPath = require('path').join(require('./core').MEMORY_DIR, 'query-misses.log');
    const logEntry = `${new Date().toISOString()} | Query: "${query}" | Results: ${results.length} | Above 0.4: ${highRelevanceResults.length} | Best: ${results.length > 0 ? results[0].similarity?.toFixed(3) : 'N/A'}\n`;
    try {
      fs.appendFileSync(logPath, logEntry);
    } catch (e) {
      // Silent fail if log write fails
    }
  }
  
  // Save (includes queryAppearances + totalQueriesTracked)
  saveBrain(brain);
  
  // Auto-track usage
  trackUsage(brain, Array.from(includedIds), feedbackNodeIds);
  
  // === EPISODIC MEMORY CHECK ===
  let episodeResults = [];
  if (brain.episodes && brain.episodes.length > 0 && useEmbeddings && cachedQueryEmbedding) {
    const epTexts = brain.episodes.map(ep => ep.events.map(e => e.summary).join(' '));
    try {
      const epEmbeddings = await getEmbeddings(epTexts);
      for (let i = 0; i < brain.episodes.length; i++) {
        if (!epEmbeddings[i] || epEmbeddings[i].length === 0) continue;
        const similarity = cosineSimilarity(cachedQueryEmbedding, epEmbeddings[i]);
        if (similarity > 0.5) {
          episodeResults.push({ ...brain.episodes[i], similarity });
        }
      }
    } catch (error) {
      // Skip episodes if batch embed fails
    }
    episodeResults.sort((a, b) => b.similarity - a.similarity);
    episodeResults = episodeResults.slice(0, 2);
  }
  
  // Format output
  if (!results.length && episodeResults.length === 0) {
    if (compactMode) {
      console.log(JSON.stringify({ results: [], episodes: [], query: query }));
    } else {
      console.log(`\n❌ No relevant memories found.\n`);
    }
    return;
  }
  
  // Compact mode: dense JSON for LLM consumption
  if (compactMode) {
    const compact = results.map(r => {
      const entry = {
        id: r.id,
        d: r.distilled || truncateText(r.text, 300),
        s: r.sourceFile || '?',
        sc: Math.round((r.similarity || 0) * 1000) / 1000,
        cat: r.category || '?'
      };
      if (isCore(r)) entry.core = true;
      if (r.dateMatch) entry.dateMatch = true;
      if (r.connectedNodes?.length) {
        entry.cx = r.connectedNodes.map(c => ({
          d: truncateText(c.distilled || c.text, 120),
          s: c.sourceFile || '?'
        }));
      }
      return entry;
    });
    
    const compactEpisodes = episodeResults.map(ep => ({
      theme: ep.theme,
      events: ep.events.map(e => e.summary),
      date: ep.timespan.start.split('T')[0],
      sc: Math.round(ep.similarity * 1000) / 1000
    }));
    
    console.log(JSON.stringify({ results: compact, episodes: compactEpisodes }));
    return;
  }

  console.log(`📊 Found ${results.length} relevant memories\n`);
  console.log('─'.repeat(80) + '\n');
  
  results.forEach((result, index) => {
    const score = useEmbeddings ? Math.round(result.totalScore * 1000) / 1000 : Math.round(result.totalScore * 100) / 100;
    const tags = result.tags?.length ? result.tags.join(', ') : 'none';
    const source = result.sourceFile || 'unknown';
    const coreFlag = isCore(result) ? ' 🔴' : '';
    const displayText = result.distilled || truncateText(result.text, 200);
    
    console.log(`${index + 1}. ${truncateText(displayText, 60)}${coreFlag}\n`);
    
    if (useEmbeddings) {
      console.log(`   📁 ${source} | 🏷️  ${tags} | 🎯 ${Math.round(result.similarity * 1000)/1000} | ⭐ ${score}`);
    } else {
      console.log(`   📁 ${source} | 🏷️  ${tags} | ⭐ ${score}`);
    }
    
    console.log(`   💬 ${displayText}\n`);
    
    if (result.connectedNodes?.length > 0) {
      console.log(`   🔗 Connected:\n`);
      result.connectedNodes.forEach(conn => {
        const connTags = conn.tags?.length ? conn.tags.join(', ') : 'none';
        const connText = conn.distilled || truncateText(conn.text, 120);
        console.log(`      • ${conn.sourceFile || 'unknown'} (${connTags}): ${connText}`);
      });
      console.log('');
    }
    
    console.log('─'.repeat(80) + '\n');
  });
  
  // Display episodes if found
  if (episodeResults.length > 0) {
    console.log(`\n📖 Related Episodes:\n`);
    
    episodeResults.forEach((episode, idx) => {
      const date = episode.timespan.start.split('T')[0];
      const score = Math.round(episode.similarity * 1000) / 1000;
      
      console.log(`${idx + 1}. Episode: "${episode.theme}" (${date}) | similarity: ${score}\n`);
      
      episode.events.forEach((event, eventIdx) => {
        let icon = '➡️';
        if (event.action === 'because') icon = '↪️';
        if (event.action === 'led_to') icon = '↪️';
        console.log(`   ${eventIdx + 1}. ${icon} ${event.summary}`);
      });
      
      console.log('\n' + '─'.repeat(80) + '\n');
    });
  }
  
  console.log(`✅ Tracked usage for ${includedIds.size} nodes\n`);
}

module.exports = {
  getConnectedNodes,
  queryCommand
};
