#!/usr/bin/env node
/**
 * tag-enforcer.js — Ensure all daily MD entries have importance tags (🔴🟡⚪)
 * 
 * Usage:
 *   node tag-enforcer.js                 # scan today, suggest tags
 *   node tag-enforcer.js --apply         # auto-apply tags and re-ingest
 *   node tag-enforcer.js 2026-02-18      # specific date
 *   node tag-enforcer.js --dry-run       # just show suggestions
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || require('path').resolve(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const CONSTELLATION = path.join(MEMORY_DIR, 'constellation.js');

// ============================================================================
// TAG DETECTION & SUGGESTION
// ============================================================================
const TAGS = { critical: '🔴', notable: '🟡', routine: '⚪' };

const CRITICAL_PATTERNS = [
  /\$\d+/i,                          // money amounts
  /closed?\s+\$|revenue|invoice|paid|payment/i,
  /decision|decided|chose|committed/i,
  /migration|migrated|deployed|launched/i,
  /major|breakthrough|proof|validation/i,
  /contract|agreement|signed/i,
  /critical|urgent|important|deadline/i,
];

const NOTABLE_PATTERNS = [
  /client|arik|judaica|bodyrok|residence/i,  // client mentions
  /upwork|lead|prospect|outreach/i,
  /setup|config|started|progress/i,
  /strategy|plan|roadmap|approach/i,
  /meeting|call|sync|discuss/i,
  /bug|fix|issue|error/i,
  /email|campaign|flow|klaviyo/i,
  /update|status|check/i,
];

function suggestTag(heading, content) {
  const combined = `${heading} ${content}`;
  
  // Already tagged?
  if (/[🔴🟡⚪]/.test(heading)) return null;
  
  // Check critical patterns
  for (const pat of CRITICAL_PATTERNS) {
    if (pat.test(combined)) return TAGS.critical;
  }
  
  // Check notable patterns
  for (const pat of NOTABLE_PATTERNS) {
    if (pat.test(combined)) return TAGS.notable;
  }
  
  // Default to routine
  return TAGS.routine;
}

// ============================================================================
// PARSE & PROCESS
// ============================================================================
function processFile(filePath, apply) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const suggestions = [];
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.match(/^## /)) continue;
    
    const heading = line.replace(/^## /, '').trim();
    
    // Collect content until next heading
    let entryContent = '';
    for (let j = i + 1; j < lines.length && !lines[j].match(/^## /); j++) {
      entryContent += lines[j] + '\n';
    }
    
    const tag = suggestTag(heading, entryContent);
    if (!tag) continue; // already tagged
    
    suggestions.push({ line: i + 1, heading, tag });
    
    if (apply) {
      // Insert tag at end of heading
      lines[i] = `## ${heading} ${tag}`;
      modified = true;
    }
  }

  return { suggestions, lines, modified };
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const dateArg = args.find(a => a.match(/^\d{4}-\d{2}-\d{2}$/));
  const today = dateArg || new Date().toISOString().split('T')[0];
  
  const mdPath = path.join(MEMORY_DIR, `${today}.md`);
  if (!fs.existsSync(mdPath)) {
    console.log(`❌ No daily file: ${mdPath}`);
    process.exit(1);
  }

  console.log(`🏷️  Tag Enforcer — scanning ${today}`);
  const { suggestions, lines, modified } = processFile(mdPath, apply && !dryRun);

  if (suggestions.length === 0) {
    console.log('✅ All entries already tagged!');
    return;
  }

  console.log(`\n📋 ${suggestions.length} entries need tags:\n`);
  for (const s of suggestions) {
    const action = (apply && !dryRun) ? 'Applied' : 'Suggest';
    console.log(`  ${s.tag} ${action}: "${s.heading}" (line ${s.line})`);
  }

  if (apply && !dryRun && modified) {
    fs.writeFileSync(mdPath, lines.join('\n'));
    console.log(`\n✅ Tags applied to ${mdPath}`);
    
    // Re-ingest tagged entries
    console.log('\n🔄 Re-ingesting tagged entries...');
    try {
      execSync(`node "${path.join(MEMORY_DIR, 'session-ingest.js')}" ${today}`, {
        cwd: WORKSPACE,
        stdio: 'inherit',
        timeout: 120000
      });
    } catch (err) {
      console.log(`⚠️  Re-ingest had issues: ${err.message.split('\n')[0]}`);
    }
  }

  console.log(`\n📊 Summary: ${suggestions.length} entries ${apply && !dryRun ? 'tagged' : 'need tags'}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
