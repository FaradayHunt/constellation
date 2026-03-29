/**
 * lib/summarize.js
 * Progressive Summarization: daily→weekly→monthly compression
 * 
 * Like human memory: raw daily notes compress into weekly summaries after 7 days,
 * weekly summaries compress into monthly after 30 days.
 * Raw files stay intact (source of truth), compressed versions used for recall.
 */

const fs = require('fs');
const path = require('path');
const { MEMORY_DIR, loadBrain, saveBrain, generateStableId, sleep } = require('./core');
const { callOpenAI, getEmbedding } = require('./embeddings');
const { extractEntities } = require('./ingest');

const SUMMARIES_DIR = path.join(MEMORY_DIR, 'summaries');

// ============================================================================
// HELPERS
// ============================================================================

function ensureSummariesDir() {
  if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
}

function getWeekNumber(date) {
  const d = new Date(date);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + yearStart.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getMonthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getDailyFiles() {
  return fs.readdirSync(MEMORY_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
}

function loadExistingSummaries() {
  ensureSummariesDir();
  const summaries = { weekly: {}, monthly: {} };
  
  fs.readdirSync(SUMMARIES_DIR).forEach(f => {
    if (f.startsWith('week-') && f.endsWith('.md')) {
      const weekKey = f.replace('week-', '').replace('.md', '');
      summaries.weekly[weekKey] = fs.readFileSync(path.join(SUMMARIES_DIR, f), 'utf8');
    }
    if (f.startsWith('month-') && f.endsWith('.md')) {
      const monthKey = f.replace('month-', '').replace('.md', '');
      summaries.monthly[monthKey] = fs.readFileSync(path.join(SUMMARIES_DIR, f), 'utf8');
    }
  });
  
  return summaries;
}

// ============================================================================
// COMPRESSION FUNCTIONS
// ============================================================================

async function compressDailyToWeekly(dailyFiles, weekKey) {
  const texts = dailyFiles.map(f => {
    const content = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8');
    return `## ${f.replace('.md', '')}\n${content}`;
  });
  
  const combined = texts.join('\n\n---\n\n');
  if (combined.trim().length < 50) return null;
  
  const prompt = `Compress these daily memory logs into a concise weekly summary. Preserve:
- Key decisions and their outcomes
- Important events and milestones
- Client/project updates
- Lessons learned
- Action items still open

Remove: routine heartbeats, redundant check-ins, low-value observations.
Format: Use ## sections for major themes. Keep it 30-50% of original length.

Daily logs:\n\n${combined}`;

  const summary = await callOpenAI(prompt, 'gpt-4o-mini');
  return summary;
}

async function compressWeeklyToMonthly(weeklySummaries, monthKey) {
  const combined = Object.entries(weeklySummaries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, content]) => `## ${week}\n${content}`)
    .join('\n\n---\n\n');
  
  if (combined.trim().length < 100) return null;
  
  const prompt = `Compress these weekly summaries into a monthly overview. Focus on:
- Major accomplishments and milestones
- Strategic decisions and direction changes
- Client/project status evolution
- Key lessons and patterns
- Open threads carrying into next month

Format: Use ## sections by theme (not by week). Keep it 20-40% of input length.

Weekly summaries:\n\n${combined}`;

  const summary = await callOpenAI(prompt, 'gpt-4o-mini');
  return summary;
}

// ============================================================================
// INGEST SUMMARIES INTO CONSTELLATION
// ============================================================================

async function ingestSummaryNode(brain, text, sourceFile, tier = 'synapse') {
  const id = generateStableId(text);
  
  // Skip if exists
  if (brain.nodes.find(n => n.id === id)) return null;
  
  // Distill
  let distilled;
  try {
    distilled = await callOpenAI(text.substring(0, 2000));
  } catch (e) {
    distilled = text.substring(0, 300);
  }
  
  // Embed
  let embedding = [];
  try {
    embedding = await getEmbedding(distilled);
  } catch (e) {
    console.log(`   ⚠️  Embed failed: ${e.message}`);
  }
  
  // Extract entities
  let extractedEntities = { people: [], companies: [], tools: [], dates: [], relationships: [] };
  try {
    extractedEntities = await extractEntities(distilled);
  } catch (e) {}
  
  const node = {
    id,
    text,
    distilled,
    embedding,
    category: 'summary',
    sourceFile,
    tags: ['summary', tier === 'raptor' ? 'monthly' : 'weekly'],
    extractedEntities,
    importanceScore: 7, // Summaries are inherently high-value
    usage: { hits: 0, referenced: 0, stability: 15.0, lastUsed: null, firstSeen: new Date().toISOString(), recallIntervals: [] },
    tier,
  };
  
  brain.nodes.push(node);
  
  // Wire to similar nodes
  if (embedding.length > 0) {
    const { cosineSimilarity } = require('./embeddings');
    let edgeCount = 0;
    brain.nodes.forEach(existing => {
      if (existing.id === id || existing.mergedInto || !existing.embedding?.length) return;
      const sim = cosineSimilarity(embedding, existing.embedding);
      if (sim > 0.7) {
        brain.edges.push({
          source: id, target: existing.id,
          type: 'summary_link',
          weight: Math.round(sim * 100) / 100,
          usage: { hits: 0, lastUsed: null }
        });
        edgeCount++;
      }
    });
    if (edgeCount > 0) console.log(`   🔗 Wired to ${edgeCount} nodes`);
  }
  
  return node;
}

// ============================================================================
// MAIN COMMAND
// ============================================================================

async function summarizeCommand(args = []) {
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  
  console.log(`📚 Progressive Summarization${dryRun ? ' (DRY RUN)' : ''}...\n`);
  ensureSummariesDir();
  
  const now = new Date();
  const dailyFiles = getDailyFiles();
  const existing = loadExistingSummaries();
  
  if (dailyFiles.length === 0) {
    console.log('❌ No daily memory files found.');
    return;
  }
  
  console.log(`📅 Found ${dailyFiles.length} daily files\n`);
  
  // === PHASE 1: Daily → Weekly (files older than 7 days) ===
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  
  // Group daily files by week
  const weekGroups = {};
  dailyFiles.forEach(f => {
    const dateStr = f.replace('.md', '');
    const fileDate = new Date(dateStr);
    
    // Only compress files older than 7 days (or force)
    if (fileDate > sevenDaysAgo && !force) return;
    
    const weekKey = getWeekNumber(dateStr);
    if (!weekGroups[weekKey]) weekGroups[weekKey] = [];
    weekGroups[weekKey].push(f);
  });
  
  let weekliesCreated = 0;
  for (const [weekKey, files] of Object.entries(weekGroups)) {
    if (existing.weekly[weekKey] && !force) {
      console.log(`   ⏭️  Week ${weekKey}: already summarized (${files.length} files)`);
      continue;
    }
    
    if (files.length < 2) {
      console.log(`   ⏭️  Week ${weekKey}: only ${files.length} file, skipping`);
      continue;
    }
    
    console.log(`   📝 Week ${weekKey}: compressing ${files.length} daily files...`);
    
    if (!dryRun) {
      const summary = await compressDailyToWeekly(files, weekKey);
      if (summary) {
        const outPath = path.join(SUMMARIES_DIR, `week-${weekKey}.md`);
        fs.writeFileSync(outPath, `# Weekly Summary: ${weekKey}\n\n${summary}`);
        console.log(`   ✅ Saved: ${outPath} (${summary.length} chars)`);
        weekliesCreated++;
        await sleep(500);
      }
    } else {
      console.log(`   🔍 Would compress: ${files.join(', ')}`);
      weekliesCreated++;
    }
  }
  
  // === PHASE 2: Weekly → Monthly (summaries older than 30 days) ===
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  
  // Reload weekly summaries (including any just created)
  const updatedExisting = dryRun ? existing : loadExistingSummaries();
  
  // Group weekly summaries by month
  const monthGroups = {};
  Object.entries(updatedExisting.weekly).forEach(([weekKey, content]) => {
    // Parse week to approximate date
    const [year, weekStr] = weekKey.split('-W');
    const weekNum = parseInt(weekStr);
    const approxDate = new Date(parseInt(year), 0, 1 + (weekNum - 1) * 7);
    
    // Only compress weeks older than 30 days (or force)
    if (approxDate > thirtyDaysAgo && !force) return;
    
    const monthKey = getMonthKey(approxDate);
    if (!monthGroups[monthKey]) monthGroups[monthKey] = {};
    monthGroups[monthKey][weekKey] = content;
  });
  
  let monthliesCreated = 0;
  for (const [monthKey, weeklies] of Object.entries(monthGroups)) {
    if (updatedExisting.monthly[monthKey] && !force) {
      console.log(`   ⏭️  Month ${monthKey}: already summarized`);
      continue;
    }
    
    const weekCount = Object.keys(weeklies).length;
    if (weekCount < 2) {
      console.log(`   ⏭️  Month ${monthKey}: only ${weekCount} week, skipping`);
      continue;
    }
    
    console.log(`   📝 Month ${monthKey}: compressing ${weekCount} weekly summaries...`);
    
    if (!dryRun) {
      const summary = await compressWeeklyToMonthly(weeklies, monthKey);
      if (summary) {
        const outPath = path.join(SUMMARIES_DIR, `month-${monthKey}.md`);
        fs.writeFileSync(outPath, `# Monthly Summary: ${monthKey}\n\n${summary}`);
        console.log(`   ✅ Saved: ${outPath} (${summary.length} chars)`);
        monthliesCreated++;
        await sleep(500);
      }
    } else {
      console.log(`   🔍 Would compress: ${Object.keys(weeklies).join(', ')}`);
      monthliesCreated++;
    }
  }
  
  // === PHASE 3: Ingest summaries into Constellation ===
  if (!dryRun && (weekliesCreated > 0 || monthliesCreated > 0)) {
    console.log(`\n🧠 Ingesting summaries into Constellation...`);
    
    const brain = loadBrain();
    const allSummaries = loadExistingSummaries();
    let ingested = 0;
    
    // Ingest weekly summaries
    for (const [weekKey, content] of Object.entries(allSummaries.weekly)) {
      const sourceFile = `summaries/week-${weekKey}.md`;
      // Check if already ingested
      if (brain.nodes.find(n => n.sourceFile === sourceFile)) continue;
      
      console.log(`   📝 Ingesting week ${weekKey}...`);
      const node = await ingestSummaryNode(brain, content, sourceFile);
      if (node) ingested++;
      await sleep(300);
    }
    
    // Ingest monthly summaries (higher tier)
    for (const [monthKey, content] of Object.entries(allSummaries.monthly)) {
      const sourceFile = `summaries/month-${monthKey}.md`;
      if (brain.nodes.find(n => n.sourceFile === sourceFile)) continue;
      
      console.log(`   📝 Ingesting month ${monthKey}...`);
      const node = await ingestSummaryNode(brain, content, sourceFile, 'raptor');
      if (node) ingested++;
      await sleep(300);
    }
    
    if (ingested > 0) {
      saveBrain(brain);
      console.log(`   ✅ Ingested ${ingested} summary nodes`);
    }
  }
  
  console.log(`\n✅ Progressive summarization complete!`);
  console.log(`   📅 Weekly summaries: ${weekliesCreated} new`);
  console.log(`   📆 Monthly summaries: ${monthliesCreated} new`);
  
  if (dryRun) console.log(`\n🔍 Dry run — no files written. Remove --dry-run to execute.`);
}

module.exports = { summarizeCommand };
