#!/usr/bin/env node
/**
 * ingest-verify.js — Wrapper around constellation.js ingest with verification
 * 
 * Runs ingest, parses output for success/failure, logs results to ingest-log.json,
 * and returns non-zero exit code on failure.
 * 
 * Usage:
 *   node ingest-verify.js "memory text"           # ingest text + verify
 *   node ingest-verify.js memory/2026-03-08.md     # ingest file + verify  
 *   node ingest-verify.js --check                  # show recent ingest stats
 * 
 * Output parsing looks for:
 *   ✅ Added node <id> (<category>) with <N> edges    → success
 *   ❌ or error text                                    → failure
 *   📄 Decomposed into <N> proposition(s)              → multi-node
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || require('path').resolve(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const CONSTELLATION = path.join(MEMORY_DIR, 'constellation.js');
const INGEST_LOG = path.join(MEMORY_DIR, 'ingest-log.json');

// ============================================================================
// INGEST LOG
// ============================================================================
function loadLog() {
  try {
    const data = JSON.parse(fs.readFileSync(INGEST_LOG, 'utf8'));
    return data;
  } catch {
    return { entries: [], stats: { total: 0, success: 0, failed: 0, noEdges: 0 } };
  }
}

function saveLog(log) {
  // Keep only last 200 entries
  if (log.entries.length > 200) {
    log.entries = log.entries.slice(-200);
  }
  fs.writeFileSync(INGEST_LOG, JSON.stringify(log, null, 2));
}

// ============================================================================
// PARSE INGEST OUTPUT
// ============================================================================
function parseIngestOutput(output) {
  const result = {
    success: false,
    nodeId: null,
    category: null,
    edges: 0,
    propositions: 1,
    entities: 0,
    relationships: 0,
    contradictions: false,
    error: null
  };

  // Check for success
  const nodeMatch = output.match(/✅ Added node (\w+) \((\w+)\) with (\d+) edges/);
  if (nodeMatch) {
    result.success = true;
    result.nodeId = nodeMatch[1];
    result.category = nodeMatch[2];
    result.edges = parseInt(nodeMatch[3]);
  }

  // Check for propositions (multi-node decomposition)
  const propMatch = output.match(/📄 Decomposed into (\d+) proposition/);
  if (propMatch) {
    result.propositions = parseInt(propMatch[1]);
  }

  // Check for entities
  const entMatch = output.match(/✅ Extracted entities: (\d+) entities, (\d+) relationships/);
  if (entMatch) {
    result.entities = parseInt(entMatch[1]);
    result.relationships = parseInt(entMatch[2]);
  }

  // Check for contradictions
  if (output.includes('⚠️') && output.includes('contradiction')) {
    result.contradictions = true;
  }

  // Check for errors
  if (output.includes('❌') || output.includes('Error') || output.includes('error')) {
    const errorLine = output.split('\n').find(l => l.includes('❌') || l.includes('Error'));
    result.error = errorLine?.trim() || 'Unknown error';
    result.success = false;
  }

  // Edge case: node added but 0 edges (orphan)
  if (result.success && result.edges === 0) {
    result.warning = 'Orphan node — 0 edges, will be disconnected from graph';
  }

  return result;
}

// ============================================================================
// RUN INGEST WITH VERIFICATION
// ============================================================================
function runIngest(input) {
  const isFile = fs.existsSync(input);
  const inputLabel = isFile ? path.basename(input) : input.substring(0, 60);
  
  console.log(`🧠 Ingesting: ${inputLabel}...`);
  
  const startTime = Date.now();
  let output = '';
  let result;
  
  try {
    const escaped = isFile ? `"${input}"` : `"${input.replace(/"/g, '\\"')}"`;
    output = execSync(`node "${CONSTELLATION}" ingest ${escaped}`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    result = parseIngestOutput(output);
  } catch (err) {
    output = err.stdout || err.stderr || err.message;
    result = parseIngestOutput(output);
    if (!result.error) {
      result.error = err.message.split('\n')[0];
    }
  }
  
  const elapsed = Date.now() - startTime;
  
  // Log result
  const log = loadLog();
  const entry = {
    timestamp: new Date().toISOString(),
    input: inputLabel,
    isFile,
    ...result,
    elapsedMs: elapsed
  };
  
  log.entries.push(entry);
  log.stats.total++;
  if (result.success) {
    log.stats.success++;
    if (result.edges === 0) log.stats.noEdges++;
  } else {
    log.stats.failed++;
  }
  saveLog(log);
  
  // Print verification
  console.log('');
  if (result.success) {
    console.log(`✅ VERIFIED — node ${result.nodeId} (${result.category})`);
    console.log(`   Edges: ${result.edges} | Entities: ${result.entities} | Time: ${elapsed}ms`);
    if (result.propositions > 1) {
      console.log(`   Decomposed into ${result.propositions} propositions`);
    }
    if (result.warning) {
      console.log(`   ⚠️  ${result.warning}`);
    }
    if (result.contradictions) {
      console.log(`   ⚠️  Contradictions detected — review manually`);
    }
  } else {
    console.log(`❌ FAILED — ${result.error || 'unknown error'}`);
    console.log(`   Time: ${elapsed}ms`);
    console.log(`   Raw output:\n${output.substring(0, 500)}`);
  }
  
  return result;
}

// ============================================================================
// SHOW STATS (--check)
// ============================================================================
function showStats() {
  const log = loadLog();
  const { stats, entries } = log;
  
  console.log('📊 Ingest Verification Stats\n');
  console.log(`Total ingests:     ${stats.total}`);
  console.log(`Successful:        ${stats.success} (${stats.total > 0 ? Math.round(stats.success / stats.total * 100) : 0}%)`);
  console.log(`Failed:            ${stats.failed}`);
  console.log(`Orphans (0 edges): ${stats.noEdges}`);
  
  // Recent entries
  const recent = entries.slice(-10);
  if (recent.length > 0) {
    console.log(`\nLast ${recent.length} ingests:`);
    for (const e of recent) {
      const status = e.success ? '✅' : '❌';
      const time = new Date(e.timestamp).toLocaleTimeString('en-GB', { 
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kiev' 
      });
      const edges = e.edges !== undefined ? `${e.edges}e` : '?e';
      console.log(`  ${status} ${time} — ${e.input?.substring(0, 40)} (${edges}, ${e.elapsedMs}ms)`);
    }
  }
  
  // Failure rate warning
  if (stats.total > 10 && stats.failed / stats.total > 0.2) {
    console.log(`\n⚠️  High failure rate (${Math.round(stats.failed / stats.total * 100)}%) — investigate!`);
  }
  if (stats.total > 10 && stats.noEdges / stats.success > 0.3) {
    console.log(`\n⚠️  High orphan rate (${Math.round(stats.noEdges / stats.success * 100)}%) — content may be too fragmented`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--check')) {
    showStats();
    return;
  }
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node ingest-verify.js "memory text"        # ingest + verify');
    console.log('  node ingest-verify.js memory/file.md       # ingest file + verify');
    console.log('  node ingest-verify.js --check              # show ingest stats');
    process.exit(1);
  }
  
  const input = args.join(' ');
  const result = runIngest(input);
  
  if (!result.success) {
    process.exit(1);
  }
}

main();
