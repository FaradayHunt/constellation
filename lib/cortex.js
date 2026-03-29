/**
 * lib/cortex.js — Local LLM Cortex for Constellation
 * 
 * Uses Ollama (llama3.1:8b) for:
 * 1. Query-time reranking (inline, ~200ms)
 * 2. Deep linking (nightly crawl — finds meaningful connections)
 * 3. Dedup detection (nightly — merges near-duplicates)
 * 4. Gap detection (nightly — finds missing knowledge)
 * 
 * Zero API cost — all local on Mac mini M4.
 */

'use strict';

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';

// ============================================================================
// OLLAMA INTERFACE
// ============================================================================

async function ollamaGenerate(prompt, options = {}) {
  const model = options.model || MODEL;
  const ollamaOpts = {
    temperature: options.temperature || 0.1,
    num_predict: options.maxTokens || 256,
    ...options.ollamaOptions
  };

  try {
    // Use chat API with think:false for models that support it (qwen3)
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      think: false,
      options: ollamaOpts
    };

    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
    const data = await resp.json();
    return data.message?.content?.trim() || '';
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('⚠️  Ollama not running. Start with: brew services start ollama');
      return null;
    }
    throw err;
  }
}

// ============================================================================
// 1. QUERY-TIME RERANKING
// ============================================================================

/**
 * Rerank search results using local LLM.
 * Takes top N candidates and asks which ones actually answer the query.
 * Returns reordered array with cortexScore added.
 * 
 * @param {string} query - User's search query
 * @param {Array} candidates - Top N results from embedding search [{id, d, totalScore, ...}]
 * @param {number} topK - How many to return (default 7)
 * @returns {Array} Reranked candidates with cortexScore
 */
async function rerank(query, candidates, topK = 7) {
  if (!candidates || candidates.length === 0) return candidates;
  
  // Feed max 15 candidates to LLM
  const toRerank = candidates.slice(0, 15);
  
  const nodeList = toRerank.map((c, i) => 
    `[${i + 1}] ${(c.distilled || c.d || c.description || '').substring(0, 200)}`
  ).join('\n');

  const prompt = `You are a reranking judge. Given a query and search results, rank ONLY the results that actually answer the query.

Query: "${query}"

Results:
${nodeList}

Return ONLY a comma-separated list of result numbers (e.g., "3,1,7,5") ordered by relevance to the query. Only include results that are genuinely relevant. If none are relevant, return "NONE".

Ranking:`;

  const response = await ollamaGenerate(prompt, { maxTokens: 64, temperature: 0.0 });
  
  if (!response || response === 'NONE') {
    // Fall back to original ordering
    return candidates.slice(0, topK);
  }

  // Parse response: extract numbers
  const numbers = response.match(/\d+/g);
  if (!numbers || numbers.length === 0) {
    return candidates.slice(0, topK);
  }

  const reranked = [];
  const seen = new Set();
  
  for (const numStr of numbers) {
    const idx = parseInt(numStr) - 1;
    if (idx >= 0 && idx < toRerank.length && !seen.has(idx)) {
      seen.add(idx);
      reranked.push({
        ...toRerank[idx],
        cortexScore: 1.0 - (reranked.length * 0.05), // 1.0, 0.95, 0.90, ...
        cortexRanked: true
      });
    }
    if (reranked.length >= topK) break;
  }

  // Append any unreranked candidates below
  if (reranked.length < topK) {
    for (let i = 0; i < toRerank.length && reranked.length < topK; i++) {
      if (!seen.has(i)) {
        reranked.push({
          ...toRerank[i],
          cortexScore: 0.3, // Low confidence — wasn't picked by LLM
          cortexRanked: false
        });
      }
    }
  }

  return reranked;
}


// ============================================================================
// 2. DEEP LINKING (Nightly)
// ============================================================================

/**
 * Crawl node pairs that share entities but have no edge.
 * Ask LLM: "How are these related? Strength 1-10?"
 * Create edges only for strength >= 7.
 * 
 * @param {Object} db - Database module
 * @param {number} batchSize - Nodes to process per run
 * @returns {Object} { checked, created, skipped }
 */
async function deepLink(db, batchSize = 50) {
  const sqliteDb = db.getDb();
  const stats = { checked: 0, created: 0, skipped: 0 };

  // Strategy: use embedding cosine similarity to find LIKELY-related pairs,
  // then let LLM confirm. Much better hit rate than random same-category.
  // Step 1: sample random anchor nodes
  // Step 2: for each anchor, find top-K nearest by embedding that have no edge yet
  const anchors = sqliteDb.prepare(`
    SELECT n.id, e.vector FROM nodes n
    JOIN embeddings e ON e.node_id = n.id
    WHERE n.merged_into IS NULL AND n.distilled IS NOT NULL
    ORDER BY RANDOM()
    LIMIT ?
  `).all(Math.min(batchSize, 50));

  // Cosine similarity helper (vectors are Float32 BLOBs)
  function cosineSim(a, b) {
    if (!a || !b) return 0;
    const vecA = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
    const vecB = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      magA += vecA[i] * vecA[i];
      magB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
  }

  // For each anchor, find close neighbors with no existing edge
  const getNeighborCandidates = sqliteDb.prepare(`
    SELECT n.id, e.vector FROM nodes n
    JOIN embeddings e ON e.node_id = n.id
    LEFT JOIN edges e1 ON (e1.source = ? AND e1.target = n.id)
    LEFT JOIN edges e2 ON (e2.source = n.id AND e2.target = ?)
    WHERE n.merged_into IS NULL AND n.distilled IS NOT NULL
      AND n.id != ?
      AND e1.source IS NULL AND e2.source IS NULL
    ORDER BY RANDOM()
    LIMIT 100
  `);

  const candidates = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const neighbors = getNeighborCandidates.all(anchor.id, anchor.id, anchor.id);
    // Score by cosine similarity, take top matches
    const scored = neighbors.map(n => ({
      id1: anchor.id < n.id ? anchor.id : n.id,
      id2: anchor.id < n.id ? n.id : anchor.id,
      sim: cosineSim(anchor.vector, n.vector)
    })).filter(p => p.sim > 0.5) // only worth checking if embeddings are somewhat close
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5);
    
    for (const s of scored) {
      const key = `${s.id1}|${s.id2}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(s);
      }
    }
    if (candidates.length >= batchSize) break;
  }
  candidates.splice(batchSize); // trim to batchSize

  if (candidates.length === 0) {
    console.log('✅ No unlinked entity pairs found. Graph is well-connected.');
    return stats;
  }

  console.log(`🔗 Found ${candidates.length} candidate pairs to evaluate...`);

  // Get node descriptions
  const getNode = sqliteDb.prepare('SELECT id, distilled FROM nodes WHERE id = ?');
  
  const insertEdge = sqliteDb.prepare(`
    INSERT OR IGNORE INTO edges (source, target, weight, type, metadata)
    VALUES (?, ?, ?, 'cortex', ?)
  `);

  for (const pair of candidates) {
    const node1 = getNode.get(pair.id1);
    const node2 = getNode.get(pair.id2);
    if (!node1 || !node2) continue;

    const desc1 = (node1.distilled || '').substring(0, 200);
    const desc2 = (node2.distilled || '').substring(0, 200);

    const prompt = `Rate how strongly these two memories are connected. Answer with JUST a number 1-10.

A: ${desc1}
B: ${desc2}

Scale:
1-3 = unrelated or only vaguely same domain
4-5 = loosely related, share a topic but no direct connection
6-7 = clearly connected, one provides context for the other
8-9 = strongly linked, directly reference the same thing or decision
10 = essentially the same event/topic from different angles

Be strict. Most random pairs from the same category are 3-5. Reserve 7+ for genuine connections.
Answer (one number):`;

    const response = await ollamaGenerate(prompt, { maxTokens: 32, temperature: 0.0 });
    stats.checked++;

    if (!response) continue;

    // Extract first number found anywhere in response, clamp to 1-10
    const ratingMatch = response.match(/(\d+)/);
    if (!ratingMatch) { stats.skipped++; continue; }

    const rating = Math.min(10, Math.max(1, parseInt(ratingMatch[1])));
    if (rating >= 6) {
      const weight = rating / 10;
      insertEdge.run(pair.id1, pair.id2, weight, JSON.stringify(`cortex:${rating}/10`));
      stats.created++;
      console.log(`  ✓ ${pair.id1} ↔ ${pair.id2} (${rating}/10)`);
      if (process.env.CORTEX_DEBUG) console.log(`  ✓ ${pair.id1.substring(0,8)} ↔ ${pair.id2.substring(0,8)} = ${rating}/10 → STORED`);
    } else {
      stats.skipped++;
      if (process.env.CORTEX_DEBUG) console.log(`  ✗ ${pair.id1.substring(0,8)} ↔ ${pair.id2.substring(0,8)} = ${rating}/10 → skipped`);
    }

    // Rate limit: ~1 req/sec to not thrash the GPU
    await new Promise(r => setTimeout(r, 200));
  }

  return stats;
}


// ============================================================================
// 2b. CROSS-CATEGORY DEEP LINKING
// ============================================================================

/**
 * Find connections ACROSS categories and time periods.
 * This catches cause→effect, decision→outcome, and cross-domain links
 * that same-category embedding search misses.
 * 
 * Strategy: pick anchor from one category, find neighbors from DIFFERENT categories
 * with moderate embedding similarity (0.3-0.6 range — too similar = same topic,
 * too different = noise). These are the high-value "bridge" connections.
 */
async function deepLinkCross(db, batchSize = 50) {
  const sqliteDb = db.getDb();
  const stats = { checked: 0, created: 0, skipped: 0 };

  // Sample anchors
  const anchors = sqliteDb.prepare(`
    SELECT n.id, n.category, e.vector FROM nodes n
    JOIN embeddings e ON e.node_id = n.id
    WHERE n.merged_into IS NULL AND n.distilled IS NOT NULL
    ORDER BY RANDOM()
    LIMIT ?
  `).all(Math.min(batchSize, 40));

  // Cosine similarity helper (vectors are Float32 BLOBs)
  function cosineSim(a, b) {
    if (!a || !b) return 0;
    const vecA = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
    const vecB = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      magA += vecA[i] * vecA[i];
      magB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
  }

  // Find neighbors from DIFFERENT categories
  const getCrossCandidates = sqliteDb.prepare(`
    SELECT n.id, n.category, e.vector FROM nodes n
    JOIN embeddings e ON e.node_id = n.id
    LEFT JOIN edges e1 ON (e1.source = ? AND e1.target = n.id)
    LEFT JOIN edges e2 ON (e2.source = n.id AND e2.target = ?)
    WHERE n.merged_into IS NULL AND n.distilled IS NOT NULL
      AND n.id != ?
      AND n.category != ?
      AND e1.source IS NULL AND e2.source IS NULL
    ORDER BY RANDOM()
    LIMIT 80
  `);

  const candidates = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const neighbors = getCrossCandidates.all(anchor.id, anchor.id, anchor.id, anchor.category || '');
    // Cross-category: look for moderate similarity (0.35-0.65)
    // Too high = basically same topic (embedding handles that)
    // Too low = truly unrelated
    const scored = neighbors.map(n => ({
      id1: anchor.id < n.id ? anchor.id : n.id,
      id2: anchor.id < n.id ? n.id : anchor.id,
      sim: cosineSim(anchor.vector, n.vector)
    })).filter(p => p.sim > 0.35 && p.sim < 0.65)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 4);
    
    for (const s of scored) {
      const key = `${s.id1}|${s.id2}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(s);
      }
    }
    if (candidates.length >= batchSize) break;
  }
  candidates.splice(batchSize);

  if (candidates.length === 0) {
    console.log('✅ No cross-category candidates found.');
    return stats;
  }

  console.log(`🌉 Found ${candidates.length} cross-category pairs to evaluate...`);

  const getNode = sqliteDb.prepare('SELECT id, distilled, category FROM nodes WHERE id = ?');
  const insertEdge = sqliteDb.prepare(`
    INSERT OR IGNORE INTO edges (source, target, weight, type, metadata)
    VALUES (?, ?, ?, 'cortex-cross', ?)
  `);

  for (const pair of candidates) {
    const node1 = getNode.get(pair.id1);
    const node2 = getNode.get(pair.id2);
    if (!node1 || !node2) continue;

    const desc1 = (node1.distilled || '').substring(0, 200);
    const desc2 = (node2.distilled || '').substring(0, 200);

    const prompt = `These two memories are from different areas. Rate if there's a causal or contextual connection. Answer with JUST a number 1-10.

A [${node1.category || 'general'}]: ${desc1}
B [${node2.category || 'general'}]: ${desc2}

Scale:
1-3 = no real connection despite surface similarity
4-5 = weak thematic overlap
6-7 = one influenced or led to the other
8-9 = direct cause-effect or decision-outcome link
10 = same event seen from different angles

Cross-domain connections are rare. Most pairs are 2-4. Only rate 6+ if there's a genuine link.
Answer (one number):`;

    const response = await ollamaGenerate(prompt, { maxTokens: 32, temperature: 0.0 });
    stats.checked++;

    if (!response) continue;

    const ratingMatch = response.match(/(\d+)/);
    if (!ratingMatch) { stats.skipped++; continue; }

    const rating = Math.min(10, Math.max(1, parseInt(ratingMatch[1])));
    if (rating >= 6) {
      const weight = rating / 10;
      insertEdge.run(pair.id1, pair.id2, weight, JSON.stringify(`cortex-cross:${rating}/10`));
      stats.created++;
      console.log(`  🌉 ${pair.id1.substring(0,8)} ↔ ${pair.id2.substring(0,8)} (${rating}/10) [${node1.category}↔${node2.category}]`);
    } else {
      stats.skipped++;
      if (process.env.CORTEX_DEBUG) console.log(`  ✗ ${pair.id1.substring(0,8)} ↔ ${pair.id2.substring(0,8)} = ${rating}/10 → skipped`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return stats;
}


// ============================================================================
// 3. DEDUP DETECTION (Nightly)
// ============================================================================

/**
 * Find nodes with very similar content and suggest merges.
 * Uses LLM to confirm — cosine alone misses semantic dupes.
 * 
 * @param {Object} db - Database module
 * @param {number} batchSize - Pairs to check per run
 * @returns {Object} { checked, merged, kept }
 */
async function detectDuplicates(db, batchSize = 30) {
  const sqliteDb = db.getDb();
  const stats = { checked: 0, merged: 0, kept: 0 };

  // Find high-similarity pairs (cosine > 0.88 based on precomputed edges)
  const candidates = sqliteDb.prepare(`
    SELECT source, target, weight
    FROM edges
    WHERE (type = '' OR type = 'classic') AND weight > 0.85 AND weight <= 1.0
    ORDER BY RANDOM()
    LIMIT ?
  `).all(batchSize);

  if (candidates.length === 0) {
    console.log('✅ No high-similarity pairs found.');
    return stats;
  }

  console.log(`🔍 Checking ${candidates.length} potential duplicates...`);

  const getNode = sqliteDb.prepare('SELECT id, distilled, source_file, category FROM nodes WHERE id = ? AND merged_into IS NULL');

  for (const pair of candidates) {
    const node1 = getNode.get(pair.source);
    const node2 = getNode.get(pair.target);
    if (!node1 || !node2) continue;

    const prompt = `Are these the same information? Answer DUPLICATE or DISTINCT (one word only).

A: ${(node1.distilled || '').substring(0, 200)}
B: ${(node2.distilled || '').substring(0, 200)}

Answer:`;

    const response = await ollamaGenerate(prompt, { maxTokens: 8, temperature: 0.0 });
    stats.checked++;

    if (!response) continue;

    if (response.toUpperCase().includes('DUPLICATE')) {
      stats.merged++;
      console.log(`  🔄 DUPLICATE: ${node1.id} ≈ ${node2.id} (${pair.weight.toFixed(2)})`);
      // Don't auto-merge — just log. Merge is destructive.
      // Future: write to cortex-dedup-log.json for review
    } else {
      stats.kept++;
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return stats;
}


// ============================================================================
// 4. GAP DETECTION (Nightly)
// ============================================================================

/**
 * Look at clusters of related nodes and ask: what's missing?
 * Generates "ghost nodes" — questions the graph can't answer.
 * 
 * @param {Object} db - Database module
 * @returns {Array} gaps found
 */
async function detectGaps(db) {
  const sqliteDb = db.getDb();
  
  // Get the top 5 most-queried categories
  const topCategories = sqliteDb.prepare(`
    SELECT category, COUNT(*) as cnt 
    FROM nodes 
    WHERE merged_into IS NULL AND category IS NOT NULL
    GROUP BY category 
    ORDER BY cnt DESC 
    LIMIT 5
  `).all();

  const gaps = [];

  for (const cat of topCategories) {
    // Get sample nodes from this category
    const sampleNodes = sqliteDb.prepare(`
      SELECT distilled FROM nodes 
      WHERE category = ? AND merged_into IS NULL AND distilled IS NOT NULL
      ORDER BY RANDOM() 
      LIMIT 8
    `).all(cat.category);

    if (sampleNodes.length < 3) continue;

    const nodeList = sampleNodes.map((n, i) => `${i + 1}. ${(n.distilled || '').substring(0, 150)}`).join('\n');

    const prompt = `Memory entries (${cat.category}):
${nodeList}

What info is missing? Write 2 short questions, one per line. No explanation.`;

    const response = await ollamaGenerate(prompt, { maxTokens: 60, temperature: 0.3 });
    if (!response) continue;

    const lines = response.split('\n').filter(l => l.trim().length > 10).slice(0, 3);
    for (const line of lines) {
      gaps.push({ category: cat.category, gap: line.trim() });
    }
  }

  return gaps;
}


// ============================================================================
// MAIN CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    console.log(`
🧠 Constellation Cortex — Local LLM Brain Enhancement

Commands:
  rerank <query>     Test reranking on a query (for debugging)
  deep-link [N]      Find and create meaningful connections (default: 50 pairs)
  dedup [N]          Detect duplicate nodes (default: 30 pairs)  
  gaps               Detect missing knowledge gaps
  nightly            Run all nightly jobs (deep-link + dedup + gaps)
  status             Check Ollama connection

Usage:
  node lib/cortex.js rerank "Monica architecture"
  node lib/cortex.js nightly
  node lib/cortex.js deep-link 100
`);
    return;
  }

  if (command === 'status') {
    const result = await ollamaGenerate('Say OK', { maxTokens: 4 });
    if (result) {
      console.log(`✅ Ollama connected. Model: ${MODEL}. Response: ${result}`);
    } else {
      console.log('❌ Ollama not reachable.');
    }
    return;
  }

  if (command === 'rerank') {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.log('Usage: node lib/cortex.js rerank "your query"');
      return;
    }

    // Load some nodes to test with
    const db = require('./db');
    const { getEmbedding, cosineSimilarity } = require('./embeddings');
    
    console.log(`🔍 Testing rerank for: "${query}"\n`);
    
    // Quick embedding search
    const queryEmb = await getEmbedding(query);
    const sqliteDb = db.getDb();
    const nodes = sqliteDb.prepare(`
      SELECT n.id, n.distilled, e.vector 
      FROM nodes n
      JOIN embeddings e ON e.node_id = n.id
      WHERE n.merged_into IS NULL AND e.vector IS NOT NULL
    `).all();

    const { blobToVector } = require('./db');
    const scored = nodes.map(n => {
      const emb = blobToVector(n.vector);
      if (!emb) return null;
      const sim = cosineSimilarity(queryEmb, emb);
      return { id: n.id, d: n.distilled, totalScore: sim, similarity: sim };
    }).filter(Boolean).sort((a, b) => b.totalScore - a.totalScore).slice(0, 15);

    console.log('--- Before rerank (embedding order) ---');
    scored.slice(0, 7).forEach((n, i) => {
      console.log(`  ${i + 1}. [${n.id}] (${n.totalScore.toFixed(3)}) ${(n.d || '').substring(0, 80)}`);
    });

    console.log('\n--- After Cortex rerank ---');
    const reranked = await rerank(query, scored);
    if (reranked) {
      reranked.forEach((n, i) => {
        const tag = n.cortexRanked ? '🧠' : '  ';
        console.log(`  ${tag} ${i + 1}. [${n.id}] (cortex:${n.cortexScore?.toFixed(2)}) ${(n.d || '').substring(0, 80)}`);
      });
    }
    return;
  }

  if (command === 'deep-link') {
    const db = require('./db');
    const batchSize = parseInt(args[1]) || 50;
    console.log(`🔗 Deep linking (batch: ${batchSize})...\n`);
    const stats = await deepLink(db, batchSize);
    console.log(`\n📊 Deep link complete: ${stats.checked} checked, ${stats.created} created, ${stats.skipped} skipped`);
    return;
  }

  if (command === 'dedup') {
    const db = require('./db');
    const batchSize = parseInt(args[1]) || 30;
    console.log(`🔍 Detecting duplicates (batch: ${batchSize})...\n`);
    const stats = await detectDuplicates(db, batchSize);
    console.log(`\n📊 Dedup complete: ${stats.checked} checked, ${stats.merged} duplicates, ${stats.kept} distinct`);
    return;
  }

  if (command === 'gaps') {
    const db = require('./db');
    console.log('🕳️  Detecting knowledge gaps...\n');
    const gaps = await detectGaps(db);
    if (gaps.length === 0) {
      console.log('No gaps detected.');
    } else {
      gaps.forEach(g => console.log(`  [${g.category}] ${g.gap}`));
    }
    return;
  }

  if (command === 'nightly') {
    console.log('🌙 Running nightly Cortex jobs...\n');
    const db = require('./db');
    
    console.log('=== Phase 1: Deep Linking ===');
    const linkStats = await deepLink(db, 50);
    console.log(`  → ${linkStats.created} new edges\n`);
    
    console.log('=== Phase 2: Dedup Detection ===');
    const dedupStats = await detectDuplicates(db, 30);
    console.log(`  → ${dedupStats.merged} duplicates found\n`);
    
    console.log('=== Phase 3: Gap Detection ===');
    const gaps = await detectGaps(db);
    console.log(`  → ${gaps.length} gaps found`);
    gaps.forEach(g => console.log(`    [${g.category}] ${g.gap}`));
    
    console.log('\n🌙 Nightly complete.');
    return;
  }

  if (command === 'marathon') {
    // Marathon mode: run continuously from 2AM-9AM (or until --hours limit)
    // Cycles through deep-link → dedup → gaps in large batches
    const hours = parseFloat(args[1]) || 7;
    const endTime = Date.now() + (hours * 60 * 60 * 1000);
    const db = require('./db');
    let cycle = 0;
    let totalLinks = 0, totalDedup = 0, totalGaps = 0;

    console.log(`🏃 Marathon mode: running for ${hours}h (until ${new Date(endTime).toLocaleTimeString()})\n`);

    while (Date.now() < endTime) {
      cycle++;
      const elapsed = ((Date.now() - (endTime - hours * 3600000)) / 3600000).toFixed(1);
      console.log(`\n━━━ Cycle ${cycle} (${elapsed}h elapsed) ━━━`);

      // Phase 1: Deep linking — big batches
      console.log('🔗 Deep linking (200 pairs)...');
      try {
        const linkStats = await deepLink(db, 200);
        totalLinks += linkStats.created;
        console.log(`  → ${linkStats.created} new edges (total: ${totalLinks})`);
      } catch(e) { console.log(`  ⚠️ Deep link error: ${e.message}`); }

      if (Date.now() >= endTime) break;

      // Phase 2: Dedup — larger batch
      console.log('🔍 Dedup (100 pairs)...');
      try {
        const dedupStats = await detectDuplicates(db, 100);
        totalDedup += dedupStats.merged;
        console.log(`  → ${dedupStats.merged} merged (total: ${totalDedup})`);
      } catch(e) { console.log(`  ⚠️ Dedup error: ${e.message}`); }

      if (Date.now() >= endTime) break;

      // Phase 3: Gaps — every 5 cycles
      if (cycle % 5 === 0) {
        console.log('🕳️  Gap detection...');
        try {
          const gaps = await detectGaps(db);
          totalGaps += gaps.length;
          console.log(`  → ${gaps.length} gaps found (total: ${totalGaps})`);
        } catch(e) { console.log(`  ⚠️ Gap error: ${e.message}`); }
      }

      // Brief pause between cycles
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`\n🏁 Marathon complete after ${cycle} cycles:`);
    console.log(`   🔗 ${totalLinks} new edges created`);
    console.log(`   🔍 ${totalDedup} duplicates merged`);
    console.log(`   🕳️  ${totalGaps} gaps detected`);
    return;
  }

  console.log(`Unknown command: ${command}. Run with --help.`);
}

module.exports = { rerank, deepLink, deepLinkCross, detectDuplicates, detectGaps, ollamaGenerate };

if (require.main === module) {
  main().catch(err => {
    console.error('Cortex error:', err);
    process.exit(1);
  });
}
