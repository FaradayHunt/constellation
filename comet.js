#!/usr/bin/env node
/**
 * ☄️ Comet — Local LLM that travels between constellation nodes
 * 
 * Comet crawls the knowledge graph using a local Ollama model,
 * discovering meaningful connections, reranking query results,
 * merging duplicates, and detecting gaps.
 * 
 * Jobs:
 *   rerank   — Query-time: rerank top N results using local LLM (fast, inline)
 *   link     — Background: discover deep connections between nodes
 *   merge    — Background: find and merge duplicate nodes  
 *   gaps     — Background: detect missing knowledge
 *   sweep    — Background: run all background jobs (link + merge + gaps)
 * 
 * Usage:
 *   node comet.js rerank "query text" '[{json results}]'
 *   node comet.js link [--batch 20] [--min-score 0.5]
 *   node comet.js merge [--dry-run]
 *   node comet.js gaps
 *   node comet.js sweep
 */

'use strict';

const http = require('http');
const path = require('path');
const db = require('./lib/db');
const { loadBrain, saveBrain, generateStableId, isProtected } = require('./lib/core');
const { cosineSimilarity } = require('./lib/embeddings');

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'nemotron-3-nano:4b';

// ============================================================================
// OLLAMA INTERFACE
// ============================================================================

async function ollamaGenerate(prompt, options = {}) {
  const body = JSON.stringify({
    model: MODEL,
    prompt,
    stream: false,
    think: false,
    options: {
      temperature: options.temperature || 0.05,
      num_predict: options.maxTokens || 64,
      top_p: 0.9,
    }
  });

  return new Promise((resolve, reject) => {
    const req = http.request(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || '');
        } catch (e) {
          reject(new Error(`Ollama parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 30000, () => {
      req.destroy();
      reject(new Error('Ollama timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function ollamaHealthCheck() {
  return new Promise((resolve) => {
    http.get(`${OLLAMA_URL}/api/tags`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const hasModel = parsed.models?.some(m => m.name.startsWith('llama3.1'));
          resolve(hasModel);
        } catch { resolve(false); }
      });
    }).on('error', () => resolve(false));
  });
}

// ============================================================================
// JOB 1: RERANK — Query-time reranking
// ============================================================================

async function rerankCommand(args) {
  const query = args[0];
  const resultsJson = args[1];
  
  if (!query || !resultsJson) {
    console.error('Usage: node comet.js rerank "query" \'[{id,d,sc}...]\'');
    process.exit(1);
  }
  
  let results;
  try {
    results = JSON.parse(resultsJson);
  } catch (e) {
    console.error('Invalid JSON results');
    process.exit(1);
  }
  
  if (results.length === 0) {
    console.log(JSON.stringify({ results: [], reranked: false }));
    return;
  }
  
  // Build prompt with numbered results
  const numbered = results.slice(0, 15).map((r, i) => 
    `[${i + 1}] ${(r.d || r.distilled || r.text || '').substring(0, 200)}`
  ).join('\n');
  
  const prompt = `Given this search query: "${query}"

Here are ${results.length} search results. Rank the TOP 5 most relevant by number, most relevant first. Only return numbers separated by commas. No explanation.

${numbered}

Most relevant (top 5):`;

  try {
    const response = await ollamaGenerate(prompt, { maxTokens: 50, temperature: 0.0 });
    const numbers = response.match(/\d+/g)?.map(Number).filter(n => n >= 1 && n <= results.length) || [];
    const uniqueNumbers = [...new Set(numbers)].slice(0, 5);
    
    if (uniqueNumbers.length === 0) {
      console.log(JSON.stringify({ results, reranked: false, reason: 'no valid ranking' }));
      return;
    }
    
    // Reorder: ranked items first, then rest in original order
    const reranked = [];
    const usedIndices = new Set();
    
    uniqueNumbers.forEach(n => {
      const idx = n - 1;
      if (results[idx]) {
        reranked.push({ ...results[idx], comet_rank: reranked.length + 1 });
        usedIndices.add(idx);
      }
    });
    
    // Append remaining in original order
    results.forEach((r, i) => {
      if (!usedIndices.has(i)) {
        reranked.push(r);
      }
    });
    
    console.log(JSON.stringify({ results: reranked, reranked: true, model: MODEL }));
  } catch (e) {
    // Graceful fallback — return original order
    console.log(JSON.stringify({ results, reranked: false, reason: e.message }));
  }
}

// ============================================================================
// JOB 2: LINK — Deep connection discovery
// ============================================================================

async function linkCommand(args) {
  let batchSize = 20;
  let minScore = 0.5;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch' && args[i + 1]) batchSize = parseInt(args[i + 1]);
    if (args[i] === '--min-score' && args[i + 1]) minScore = parseFloat(args[i + 1]);
  }
  
  console.log(`☄️  Comet LINK — discovering connections (batch=${batchSize}, min=${minScore})`);
  
  const sqliteDb = db.getDb();
  
  // Get active nodes with embeddings that have few edges
  const nodes = sqliteDb.prepare(`
    SELECT n.id, n.distilled, n.category, n.source_file,
           (SELECT COUNT(*) FROM edges WHERE source = n.id OR target = n.id) as edge_count
    FROM nodes n
    WHERE n.merged_into IS NULL
      AND n.distilled IS NOT NULL
      AND n.id IN (SELECT node_id FROM embeddings WHERE vector IS NOT NULL)
    ORDER BY edge_count ASC
    LIMIT ?
  `).all(batchSize * 2);
  
  if (nodes.length < 2) {
    console.log('Not enough nodes to link.');
    return;
  }
  
  // Pick pairs: low-edge nodes that share entities but aren't connected
  const pairs = [];
  for (let i = 0; i < Math.min(nodes.length, batchSize); i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (pairs.length >= batchSize) break;
      
      // Check if already connected
      const existing = sqliteDb.prepare(
        `SELECT 1 FROM edges WHERE (source = ? AND target = ?) OR (source = ? AND target = ?)`
      ).get(nodes[i].id, nodes[j].id, nodes[j].id, nodes[i].id);
      
      if (!existing) {
        pairs.push([nodes[i], nodes[j]]);
      }
    }
    if (pairs.length >= batchSize) break;
  }
  
  console.log(`  Found ${pairs.length} unconnected pairs to evaluate`);
  
  let newLinks = 0;
  const insertEdge = sqliteDb.prepare(`
    INSERT OR IGNORE INTO edges (source, target, weight, type, metadata)
    VALUES (?, ?, ?, 'comet', ?)
  `);
  
  for (const [nodeA, nodeB] of pairs) {
    const textA = (nodeA.distilled || '').substring(0, 150);
    const textB = (nodeB.distilled || '').substring(0, 150);
    
    const prompt = `Are these two memory entries related? Rate 1-10 (1=unrelated, 10=strongly connected). Reply with ONLY a number.

Entry A: ${textA}
Entry B: ${textB}

Rating:`;

    try {
      const response = await ollamaGenerate(prompt, { maxTokens: 10, temperature: 0.0 });
      const score = parseInt(response.match(/\d+/)?.[0] || '0');
      
      if (score >= 7) {
        insertEdge.run(nodeA.id, nodeB.id, score / 10, JSON.stringify({ comet_score: score, created: new Date().toISOString() }));
        newLinks++;
        console.log(`  ✅ Linked [${score}/10]: "${textA.substring(0, 50)}..." ↔ "${textB.substring(0, 50)}..."`);
      }
    } catch (e) {
      // Skip on timeout/error
    }
  }
  
  console.log(`\n☄️  Comet created ${newLinks} new connections from ${pairs.length} pairs`);
}

// ============================================================================
// JOB 3: MERGE — Duplicate detection and merge
// ============================================================================

async function mergeCommand(args) {
  const dryRun = args.includes('--dry-run');
  console.log(`☄️  Comet MERGE — finding duplicates ${dryRun ? '(DRY RUN)' : ''}`);
  
  const sqliteDb = db.getDb();
  
  // Get nodes with embeddings
  const rows = sqliteDb.prepare(`
    SELECT n.id, n.distilled, n.category, ne.vector
    FROM nodes n
    JOIN embeddings ne ON n.id = ne.node_id
    WHERE n.merged_into IS NULL
      AND n.distilled IS NOT NULL
      AND ne.vector IS NOT NULL
  `).all();
  
  // Parse embeddings
  const nodes = rows.map(r => ({
    id: r.id,
    distilled: r.distilled,
    category: r.category,
    embedding: blobToVector(r.vector || r.embedding)
  }));
  
  // Find high-similarity pairs (cosine > 0.92)
  const candidates = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!nodes[i].embedding.length || !nodes[j].embedding.length) continue;
      const sim = cosineSimilarity(nodes[i].embedding, nodes[j].embedding);
      if (sim > 0.92) {
        candidates.push({ a: nodes[i], b: nodes[j], similarity: sim });
      }
    }
    // Progress for large graphs
    if (i > 0 && i % 500 === 0) {
      console.log(`  Scanned ${i}/${nodes.length} nodes, found ${candidates.length} candidates...`);
    }
  }
  
  console.log(`  Found ${candidates.length} potential duplicates (cosine > 0.92)`);
  
  // Ask LLM to confirm top candidates
  let merged = 0;
  const mergeStmt = sqliteDb.prepare(`UPDATE nodes SET merged_into = ? WHERE id = ?`);
  
  for (const { a, b, similarity } of candidates.slice(0, 30)) {
    // Never merge away protected nodes (family, health, core)
    const aProtected = isProtected(a);
    const bProtected = isProtected(b);
    if (aProtected && bProtected) continue; // both protected — skip entirely
    
    const prompt = `Are these two entries saying the same thing? Reply YES or NO only.

Entry A: ${a.distilled.substring(0, 200)}
Entry B: ${b.distilled.substring(0, 200)}

Same thing?`;

    try {
      const response = await ollamaGenerate(prompt, { maxTokens: 10, temperature: 0.0 });
      const isYes = response.trim().toUpperCase().startsWith('YES');
      
      if (isYes) {
        if (!dryRun) {
          // Protected node always survives — merge the non-protected one away
          if (bProtected) {
            mergeStmt.run(b.id, a.id); // a merges into b (b is protected, survives)
          } else {
            mergeStmt.run(a.id, b.id); // b merges into a (default)
          }
        }
        merged++;
        console.log(`  ${dryRun ? '🔍' : '🔗'} Merged (${similarity.toFixed(3)}): "${a.distilled.substring(0, 60)}..."`);
      }
    } catch (e) {
      // Skip
    }
  }
  
  console.log(`\n☄️  Comet ${dryRun ? 'would merge' : 'merged'} ${merged} duplicate pairs`);
}

// ============================================================================
// JOB 4: GAPS — Missing knowledge detection
// ============================================================================

async function gapsCommand() {
  console.log(`☄️  Comet GAPS — detecting missing knowledge`);
  
  const sqliteDb = db.getDb();
  
  // Get recent query misses
  const misses = sqliteDb.prepare(`
    SELECT query, top_score, result_count, timestamp
    FROM query_misses
    ORDER BY timestamp DESC
    LIMIT 20
  `).all();
  
  if (misses.length === 0) {
    console.log('  No query misses found — knowledge looks complete!');
    return;
  }
  
  // Get node categories for context
  const categories = sqliteDb.prepare(`
    SELECT category, COUNT(*) as count
    FROM nodes
    WHERE merged_into IS NULL
    GROUP BY category
    ORDER BY count DESC
  `).all();
  
  const catSummary = categories.map(c => `${c.category}: ${c.count}`).join(', ');
  const missQueries = misses.map(m => `- "${m.query}" (best score: ${m.top_score?.toFixed(2) || 'N/A'})`).join('\n');
  
  const prompt = `You are analyzing a knowledge graph's weak spots. 

Current categories: ${catSummary}

These queries had poor results (low scores or no matches):
${missQueries}

List the top 3 knowledge GAPS — topics this brain should know about but doesn't. Be specific and actionable. Format: one gap per line, starting with "GAP:".`;

  try {
    const response = await ollamaGenerate(prompt, { maxTokens: 300, temperature: 0.3 });
    
    console.log('\n📋 Knowledge Gaps Detected:\n');
    const gaps = response.split('\n')
      .filter(line => line.trim().startsWith('GAP:') || line.trim().match(/^\d+\./))
      .map(line => line.trim());
    
    if (gaps.length > 0) {
      gaps.forEach(gap => console.log(`  ${gap}`));
    } else {
      console.log(response.trim());
    }
    
    // Save gaps to file
    const fs = require('fs');
    const gapFile = path.join(__dirname, 'comet-gaps.md');
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `\n## ${timestamp} — Comet Gap Scan\n${gaps.length > 0 ? gaps.join('\n') : response.trim()}\n`;
    fs.appendFileSync(gapFile, entry);
    console.log(`\n  Saved to comet-gaps.md`);
    
  } catch (e) {
    console.error(`  Error: ${e.message}`);
  }
}

// ============================================================================
// JOB 5: SWEEP — Run all background jobs
// ============================================================================

async function sweepCommand(args) {
  console.log('☄️  Comet SWEEP — full background pass\n');
  const start = Date.now();
  
  await linkCommand(['--batch', '50', ...args]);
  console.log('');
  await mergeCommand(args); // real merge — dedupes the graph
  console.log('');
  await gapsCommand();
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n☄️  Sweep complete in ${elapsed}s`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const [command, ...args] = process.argv.slice(2);
  
  if (!command) {
    console.log(`☄️  Comet — Local LLM that travels between constellation nodes

Commands:
  rerank "query" '[results]'  — Rerank search results (query-time, fast)
  link [--batch N]            — Discover deep connections between nodes
  merge [--dry-run]           — Find and merge duplicate nodes
  gaps                        — Detect missing knowledge
  sweep                       — Run all background jobs

Model: ${MODEL} via Ollama (local, $0 cost)
`);
    return;
  }
  
  // Health check
  if (command !== 'rerank') {
    const healthy = await ollamaHealthCheck();
    if (!healthy) {
      console.error('❌ Ollama not running or model not available. Run: brew services start ollama && ollama pull llama3.1:8b');
      process.exit(1);
    }
  }
  
  switch (command) {
    case 'rerank': await rerankCommand(args); break;
    case 'link': await linkCommand(args); break;
    case 'merge': await mergeCommand(args); break;
    case 'gaps': await gapsCommand(); break;
    case 'sweep': await sweepCommand(args); break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// blobToVector fallback if not exported from db
function blobToVector(blob) {
  if (!blob || blob.length === 0) return [];
  const len = blob.length / 4;
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = blob.readFloatLE(i * 4);
  }
  return result;
}

main().catch(e => {
  console.error(`☄️  Comet error: ${e.message}`);
  process.exit(1);
});
