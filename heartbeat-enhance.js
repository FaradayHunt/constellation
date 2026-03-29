#!/usr/bin/env node
/**
 * heartbeat-enhance.js — Smarter heartbeat checks for constellation
 * 
 * Usage:
 *   node heartbeat-enhance.js              # run all checks
 *   node heartbeat-enhance.js --ingest     # only auto-ingest
 *   node heartbeat-enhance.js --gaps       # only gap tracking
 *   node heartbeat-enhance.js --prune      # only prune orphans
 *   node heartbeat-enhance.js --capture    # only session capture
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || require('path').resolve(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const CONSTELLATION = path.join(MEMORY_DIR, 'constellation.js');
const GAPS_FILE = path.join(MEMORY_DIR, 'constellation-gaps.md');
const INGEST_STATE = path.join(MEMORY_DIR, 'session-ingest-state.json');

// ============================================================================
// CHECK 1: Auto-ingest if daily MD has significant new content
// ============================================================================
function checkAutoIngest() {
  const today = new Date().toISOString().split('T')[0];
  const mdPath = path.join(MEMORY_DIR, `${today}.md`);
  
  if (!fs.existsSync(mdPath)) {
    console.log('📝 No daily file yet — skipping ingest check');
    return;
  }

  const content = fs.readFileSync(mdPath, 'utf8');
  const currentHash = require('crypto').createHash('md5').update(content).digest('hex').substring(0, 12);
  
  // Check if we already ingested this version
  let state = {};
  try { state = JSON.parse(fs.readFileSync(INGEST_STATE, 'utf8')); } catch {}
  
  const dayState = state.ingested?.[today];
  if (dayState?.fileHash === currentHash) {
    console.log('📝 Daily file unchanged since last ingest — skipping');
    return;
  }

  // Check if file is substantial enough (> 500 chars of content)
  if (content.length < 500) {
    console.log('📝 Daily file too small for ingest — skipping');
    return;
  }

  console.log('📝 Daily file has new content — running session-ingest...');
  try {
    execSync(`node "${path.join(MEMORY_DIR, 'session-ingest.js')}" ${today}`, {
      cwd: WORKSPACE,
      stdio: 'inherit',
      timeout: 120000
    });
    // Update file hash
    if (!state.ingested) state.ingested = {};
    if (!state.ingested[today]) state.ingested[today] = { entries: [] };
    state.ingested[today].fileHash = currentHash;
    fs.writeFileSync(INGEST_STATE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.log(`⚠️  Auto-ingest error: ${err.message.split('\n')[0]}`);
  }
}

// ============================================================================
// CHECK 2: Track poor query results (gaps)
// ============================================================================
function checkQueryGaps() {
  console.log('\n🔍 Checking for query gaps...');
  
  try {
    const statsOut = execSync(`node "${CONSTELLATION}" stats`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 10000
    });
    
    // Extract query miss info from feedback-stats
    const fbOut = execSync(`node "${CONSTELLATION}" feedback-stats`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 10000
    });

    // Parse for misses
    const missMatch = fbOut.match(/(\d+)\s*misses/);
    const misses = missMatch ? parseInt(missMatch[1]) : 0;
    
    if (misses > 0) {
      const timestamp = new Date().toISOString();
      const entry = `\n## ${timestamp}\n- ${misses} query misses detected\n- Review queries returning < 3 results\n`;
      fs.appendFileSync(GAPS_FILE, entry);
      console.log(`  ⚠️  ${misses} query gaps logged to constellation-gaps.md`);
    } else {
      console.log('  ✅ No query gaps detected');
    }
  } catch (err) {
    console.log(`  ⚠️  Gap check error: ${err.message.split('\n')[0]}`);
  }
}

// ============================================================================
// CHECK 3: Prune orphan/dead nodes (not accessed in 30+ days)
// ============================================================================
function checkPruneOrphans() {
  console.log('\n🧹 Checking for stale nodes...');
  
  try {
    const { loadBrain, saveBrain } = require('./constellation.js');
    const brain = loadBrain();
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    
    const staleNodes = brain.nodes.filter(n => {
      if (n.core || n.merged) return false; // never prune core or merged
      const lastUsed = n.usage?.lastUsed ? new Date(n.usage.lastUsed).getTime() : 0;
      const created = n.created ? new Date(n.created).getTime() : 0;
      const lastActive = Math.max(lastUsed, created);
      return (now - lastActive) > THIRTY_DAYS;
    });

    if (staleNodes.length === 0) {
      console.log('  ✅ No stale nodes (all accessed within 30 days)');
      return;
    }

    // Don't auto-delete — just report. Use archive command for actual cleanup.
    console.log(`  📊 ${staleNodes.length} nodes inactive for 30+ days`);
    console.log(`  💡 Run: node constellation.js archive --dry-run to review`);
    
    // Log to gaps file
    const entry = `\n## ${new Date().toISOString()} — Stale Nodes\n- ${staleNodes.length} nodes inactive 30+ days\n- Consider running: node constellation.js archive\n`;
    fs.appendFileSync(GAPS_FILE, entry);
  } catch (err) {
    console.log(`  ⚠️  Prune check error: ${err.message.split('\n')[0]}`);
  }
}

// ============================================================================
// CHECK 4: Auto-capture uncaptured sessions
// ============================================================================
function checkSessionCapture() {
  console.log('\n📋 Checking for uncaptured sessions...');
  
  try {
    const output = execSync(`node "${path.join(MEMORY_DIR, 'session-capture.js')}"`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 60000
    });
    console.log(output);
  } catch (err) {
    console.log(`  ⚠️  Session capture error: ${err.message.split('\n')[0]}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
function main() {
  const args = process.argv.slice(2);
  const doAll = args.length === 0;
  
  console.log('💓 Constellation Heartbeat Enhancements\n');
  console.log('═'.repeat(50));

  if (doAll || args.includes('--ingest')) checkAutoIngest();
  if (doAll || args.includes('--gaps')) checkQueryGaps();
  if (doAll || args.includes('--prune')) checkPruneOrphans();
  if (doAll || args.includes('--capture')) checkSessionCapture();

  console.log('\n' + '═'.repeat(50));
  console.log('✅ Heartbeat checks complete');
}

main();
