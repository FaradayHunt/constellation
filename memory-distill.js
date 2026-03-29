#!/usr/bin/env node
/**
 * memory-distill.js — Detect MEMORY.md staleness and flag gaps
 * 
 * Compares recent daily MDs (last 7 days) against MEMORY.md to find:
 *   1. Significant topics in daily files not reflected in MEMORY.md
 *   2. Outdated info in MEMORY.md that contradicts recent entries
 *   3. Patterns worth distilling (recurring themes, evolving decisions)
 * 
 * Usage:
 *   node memory-distill.js                # full analysis, outputs report
 *   node memory-distill.js --days 14      # look back further
 *   node memory-distill.js --dry-run      # just show what needs updating
 *   node memory-distill.js --apply        # auto-append suggestions to MEMORY.md (TODO: future)
 * 
 * Designed to run weekly via cron.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || require('path').resolve(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const MEMORY_MD = path.join(WORKSPACE, 'MEMORY.md');
const DISTILL_STATE = path.join(MEMORY_DIR, 'distill-state.json');
const DISTILL_REPORT = path.join(MEMORY_DIR, 'distill-report.md');

// ============================================================================
// CONFIG
// ============================================================================
const DEFAULT_DAYS = 7;
const MIN_ENTRY_LENGTH = 80; // chars — skip trivial entries
const IMPORTANCE_TAGS = ['🔴', '🟡']; // only flag critical/notable entries

// Key sections in MEMORY.md we track
const MEMORY_SECTIONS = [
  'Who is Vlad', 'Financial Picture', 'Clients & Projects', 'Strategic Direction',
  'Infrastructure', 'Operational Lessons', 'Our Relationship', 'Sola Email System',
  'Constellation', 'Hunter', 'X/Twitter', 'Klaviyo', 'Critical Email Build Rules'
];

// ============================================================================
// PARSE DAILY MDs
// ============================================================================
function getDailyFiles(days) {
  const files = [];
  const now = new Date();
  
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const filePath = path.join(MEMORY_DIR, `${dateStr}.md`);
    
    if (fs.existsSync(filePath)) {
      files.push({ date: dateStr, path: filePath });
    }
  }
  
  return files;
}

function parseEntries(content) {
  const entries = [];
  const lines = content.split('\n');
  let currentHeading = null;
  let currentLines = [];
  let currentTag = '⚪';

  for (const line of lines) {
    if (line.match(/^## /)) {
      if (currentHeading && currentLines.length > 0) {
        const text = currentLines.join('\n').trim();
        if (text.length >= MIN_ENTRY_LENGTH) {
          entries.push({ heading: currentHeading, text, tag: currentTag });
        }
      }
      currentHeading = line.replace(/^## /, '').trim();
      currentLines = [];
      // Detect importance tag
      if (currentHeading.includes('🔴')) currentTag = '🔴';
      else if (currentHeading.includes('🟡')) currentTag = '🟡';
      else currentTag = '⚪';
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }
  
  // Last entry
  if (currentHeading && currentLines.length > 0) {
    const text = currentLines.join('\n').trim();
    if (text.length >= MIN_ENTRY_LENGTH) {
      entries.push({ heading: currentHeading, text, tag: currentTag });
    }
  }
  
  return entries;
}

// ============================================================================
// ANALYZE GAPS
// ============================================================================
function extractKeywords(text) {
  // Extract significant terms (client names, tools, decisions, numbers)
  const words = text.toLowerCase();
  const keywords = new Set();
  
  // Client names
  const clients = ['judaica', 'residence supply', 'best ideas', 'co:create', 'arik', 'rs', 'biuk'];
  for (const c of clients) {
    if (words.includes(c)) keywords.add(c);
  }
  
  // Tools/systems
  const tools = ['klaviyo', 'sola', 'constellation', 'hunter', 'monica', 'edison', 'ecomhero', 'instantly', 'apollo', 'supabase', 'vercel', 'shopify'];
  for (const t of tools) {
    if (words.includes(t)) keywords.add(t);
  }
  
  // Decision indicators
  const decisions = ['decided', 'approved', 'declined', 'switched', 'migrated', 'launched', 'built', 'fixed', 'killed', 'scrapped', 'replaced', 'upgraded'];
  for (const d of decisions) {
    if (words.includes(d)) keywords.add(`decision:${d}`);
  }
  
  // Financial
  const money = text.match(/\$[\d,]+/g);
  if (money) keywords.add('financial');
  
  return [...keywords];
}

function findGaps(dailyEntries, memoryContent) {
  const memoryLower = memoryContent.toLowerCase();
  const gaps = [];
  
  for (const entry of dailyEntries) {
    const keywords = extractKeywords(entry.text);
    
    // Check if this entry's core info is reflected in MEMORY.md
    const isDecision = keywords.some(k => k.startsWith('decision:'));
    const hasClient = keywords.some(k => !k.startsWith('decision:') && k !== 'financial');
    const isImportant = entry.tag === '🔴' || entry.tag === '🟡';
    
    // Skip routine entries unless they contain decisions
    if (!isImportant && !isDecision) continue;
    
    // Check if the entry's key info is already in MEMORY.md
    // Use a simple heuristic: check if the heading or key phrases appear
    const headingClean = entry.heading.replace(/[🔴🟡⚪\d:—–\-]/g, '').trim().toLowerCase();
    const headingWords = headingClean.split(/\s+/).filter(w => w.length > 3);
    
    // Count how many heading words appear in MEMORY.md
    const matchCount = headingWords.filter(w => memoryLower.includes(w)).length;
    const matchRatio = headingWords.length > 0 ? matchCount / headingWords.length : 0;
    
    // If less than 40% of heading words match, likely a gap
    if (matchRatio < 0.4) {
      gaps.push({
        heading: entry.heading,
        date: entry.date,
        tag: entry.tag,
        keywords,
        snippet: entry.text.substring(0, 150),
        matchRatio
      });
    }
  }
  
  return gaps;
}

// ============================================================================
// DETECT STALE SECTIONS in MEMORY.md
// ============================================================================
function findStaleSections(memoryContent, dailyEntries) {
  const stale = [];
  const memoryLines = memoryContent.split('\n');
  
  // Find sections with date references and check if they're outdated
  for (let i = 0; i < memoryLines.length; i++) {
    const line = memoryLines[i];
    
    // Look for date patterns like "as of Feb 2026", "Mar 6", etc.
    const dateMatch = line.match(/(?:as of|since|from)\s+(\w+\s+\d{1,2}(?:,?\s*\d{4})?)/i);
    if (dateMatch) {
      const dateRef = dateMatch[1];
      // If the date reference is > 14 days old and there's recent daily content about the same topic
      const sectionHeader = findPreviousHeader(memoryLines, i);
      if (sectionHeader) {
        stale.push({
          section: sectionHeader,
          line: i + 1,
          dateRef,
          reason: `Contains date reference "${dateRef}" — may need updating`
        });
      }
    }
  }
  
  return stale;
}

function findPreviousHeader(lines, fromLine) {
  for (let i = fromLine; i >= 0; i--) {
    if (lines[i].match(/^## /)) {
      return lines[i].replace(/^## /, '').trim();
    }
  }
  return null;
}

// ============================================================================
// GENERATE REPORT
// ============================================================================
function generateReport(gaps, stale, stats) {
  const now = new Date().toISOString();
  let report = `# Memory Distill Report — ${now.split('T')[0]}\n\n`;
  report += `Generated: ${now}\n`;
  report += `Daily files scanned: ${stats.filesScanned}\n`;
  report += `Total entries analyzed: ${stats.entriesAnalyzed}\n`;
  report += `Important entries (🔴🟡): ${stats.importantEntries}\n\n`;
  
  if (gaps.length === 0 && stale.length === 0) {
    report += `## ✅ MEMORY.md is up to date\nNo gaps or stale sections detected.\n`;
    return report;
  }
  
  if (gaps.length > 0) {
    report += `## 🔍 Gaps Found (${gaps.length})\n`;
    report += `These important daily entries may not be reflected in MEMORY.md:\n\n`;
    
    for (const gap of gaps) {
      report += `### ${gap.tag} ${gap.heading}\n`;
      if (gap.date) report += `- **Date:** ${gap.date}\n`;
      report += `- **Keywords:** ${gap.keywords.join(', ')}\n`;
      report += `- **Preview:** ${gap.snippet}...\n`;
      report += `- **Match ratio:** ${Math.round(gap.matchRatio * 100)}% (lower = more likely missing)\n\n`;
    }
  }
  
  if (stale.length > 0) {
    report += `## 📅 Potentially Stale Sections (${stale.length})\n`;
    report += `These MEMORY.md sections reference specific dates and may need updating:\n\n`;
    
    for (const s of stale) {
      report += `- **${s.section}** (line ${s.line}): ${s.reason}\n`;
    }
    report += '\n';
  }
  
  report += `## 📋 Suggested Actions\n`;
  if (gaps.length > 0) {
    report += `1. Review the ${gaps.length} gap(s) above and add relevant info to MEMORY.md\n`;
  }
  if (stale.length > 0) {
    report += `2. Check ${stale.length} stale section(s) for outdated information\n`;
  }
  report += `3. Remove any MEMORY.md entries that are no longer relevant\n`;
  
  return report;
}

// ============================================================================
// STATE
// ============================================================================
function loadState() {
  try { return JSON.parse(fs.readFileSync(DISTILL_STATE, 'utf8')); }
  catch { return { lastRun: null, lastGapCount: 0 }; }
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(DISTILL_STATE, JSON.stringify(state, null, 2));
}

// ============================================================================
// MAIN
// ============================================================================
function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1]) || DEFAULT_DAYS : DEFAULT_DAYS;
  const dryRun = args.includes('--dry-run');
  
  console.log(`📊 Memory Distill — scanning last ${days} days\n`);
  
  // Load MEMORY.md
  let memoryContent = '';
  try { memoryContent = fs.readFileSync(MEMORY_MD, 'utf8'); }
  catch { console.log('❌ Could not read MEMORY.md'); process.exit(1); }
  
  // Collect daily entries
  const dailyFiles = getDailyFiles(days);
  console.log(`📁 Found ${dailyFiles.length} daily file(s)`);
  
  let allEntries = [];
  for (const f of dailyFiles) {
    const content = fs.readFileSync(f.path, 'utf8');
    const entries = parseEntries(content);
    entries.forEach(e => e.date = f.date);
    allEntries.push(...entries);
  }
  
  const importantEntries = allEntries.filter(e => e.tag === '🔴' || e.tag === '🟡');
  console.log(`📝 ${allEntries.length} entries total, ${importantEntries.length} important (🔴🟡)\n`);
  
  // Find gaps
  const gaps = findGaps(allEntries, memoryContent);
  console.log(`🔍 ${gaps.length} potential gap(s) found`);
  
  // Find stale sections
  const stale = findStaleSections(memoryContent, allEntries);
  console.log(`📅 ${stale.length} potentially stale section(s)`);
  
  // Generate report
  const report = generateReport(gaps, stale, {
    filesScanned: dailyFiles.length,
    entriesAnalyzed: allEntries.length,
    importantEntries: importantEntries.length
  });
  
  if (dryRun) {
    console.log('\n' + report);
  } else {
    fs.writeFileSync(DISTILL_REPORT, report);
    console.log(`\n📄 Report saved to ${DISTILL_REPORT}`);
    
    // Save state
    const state = loadState();
    state.lastGapCount = gaps.length;
    state.lastStaleCount = stale.length;
    saveState(state);
  }
  
  // Exit with code 1 if gaps found (useful for cron alerting)
  if (gaps.length > 0 || stale.length > 0) {
    process.exit(1);
  }
}

main();
