#!/usr/bin/env node
/**
 * session-ingest.js — Auto-ingest daily MD entries into constellation graph
 * 
 * Usage:
 *   node session-ingest.js                    # ingest today's MD
 *   node session-ingest.js 2026-02-18         # ingest specific date
 *   node session-ingest.js --dry-run          # show what would be ingested
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || require('path').resolve(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const INGEST_STATE = path.join(MEMORY_DIR, 'session-ingest-state.json');
const { ingestCommand } = require('./lib/ingest');

// ============================================================================
// STATE MANAGEMENT (deduplication)
// ============================================================================
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(INGEST_STATE, 'utf8'));
  } catch {
    return { ingested: {} }; // { "2026-02-18": { hash: "abc123", entries: ["hash1", ...] } }
  }
}

function saveState(state) {
  fs.writeFileSync(INGEST_STATE, JSON.stringify(state, null, 2));
}

// ============================================================================
// PARSE DAILY MD INTO ENTRIES
// ============================================================================
function parseDailyMd(content) {
  const entries = [];
  const lines = content.split('\n');
  let currentEntry = null;
  let currentLines = [];

  for (const line of lines) {
    // New entry starts with ## heading
    if (line.match(/^## /)) {
      if (currentEntry && currentLines.length > 0) {
        entries.push({
          heading: currentEntry,
          content: currentLines.join('\n').trim(),
          hash: crypto.createHash('md5').update(currentLines.join('\n').trim()).digest('hex').substring(0, 12)
        });
      }
      currentEntry = line.replace(/^## /, '').trim();
      currentLines = [];
    } else if (line.match(/^### /)) {
      // Sub-heading — append as continuation
      if (currentEntry) {
        currentLines.push(line);
      } else {
        currentEntry = line.replace(/^### /, '').trim();
        currentLines = [];
      }
    } else {
      currentLines.push(line);
    }
  }
  // Last entry
  if (currentEntry && currentLines.length > 0) {
    entries.push({
      heading: currentEntry,
      content: currentLines.join('\n').trim(),
      hash: crypto.createHash('md5').update(currentLines.join('\n').trim()).digest('hex').substring(0, 12)
    });
  }

  return entries;
}

// ============================================================================
// EXTRACT MEANINGFUL TEXT FOR INGESTION
// ============================================================================
function buildIngestText(entry) {
  // Combine heading + content, clean up markdown artifacts
  let text = `${entry.heading}\n${entry.content}`;
  // Remove empty lines, compress
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  // Skip very short entries (< 20 chars of actual content)
  const contentOnly = entry.content.replace(/[-*#\s]/g, '');
  if (contentOnly.length < 20) return null;
  return text;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dateArg = args.find(a => a.match(/^\d{4}-\d{2}-\d{2}$/));
  const today = dateArg || new Date().toISOString().split('T')[0];
  
  const mdPath = path.join(MEMORY_DIR, `${today}.md`);
  if (!fs.existsSync(mdPath)) {
    console.log(`❌ No daily file found: ${mdPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(mdPath, 'utf8');
  const entries = parseDailyMd(content);
  const state = loadState();
  const dayState = state.ingested[today] || { entries: [] };

  console.log(`📅 Processing ${today} — ${entries.length} entries found`);

  let ingested = 0;
  let skipped = 0;

  for (const entry of entries) {
    // Deduplicate by content hash
    if (dayState.entries.includes(entry.hash)) {
      skipped++;
      continue;
    }

    const text = buildIngestText(entry);
    if (!text) {
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  📝 Would ingest: "${entry.heading}" (${text.length} chars)`);
      ingested++;
      continue;
    }

    try {
      console.log(`  🔄 Ingesting: "${entry.heading}"...`);
      await ingestCommand([text]);
      dayState.entries.push(entry.hash);
      ingested++;
      console.log(`  ✅ Done`);
    } catch (err) {
      console.log(`  ❌ Failed: ${err.message.split('\n')[0]}`);
    }
  }

  if (!dryRun) {
    state.ingested[today] = dayState;
    saveState(state);
  }

  console.log(`\n📊 Results: ${ingested} ingested, ${skipped} skipped (dupes/empty)`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
