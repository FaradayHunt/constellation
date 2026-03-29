#!/usr/bin/env node
/**
 * session-capture.js — Auto-capture session summaries + handoffs
 * 
 * Pulls recent session history via OpenClaw CLI, summarizes key points,
 * appends to daily MD, ingests into constellation, and creates a handoff node.
 * 
 * Usage:
 *   node session-capture.js                    # capture all recent unsummarized sessions
 *   node session-capture.js --dry-run          # show what would be captured
 *   node session-capture.js --handoff "text"   # create manual handoff
 * 
 * Designed to run:
 *   1. On heartbeat (via heartbeat-enhance.js)
 *   2. Manually at session end
 *   3. Via cron for safety net
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || require('path').resolve(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const CAPTURE_STATE = path.join(MEMORY_DIR, 'session-capture-state.json');
const CONSTELLATION = path.join(MEMORY_DIR, 'constellation.js');
const GAPS_FILE = path.join(MEMORY_DIR, 'constellation-gaps.md');

// ============================================================================
// STATE — track which sessions we've already captured
// ============================================================================
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CAPTURE_STATE, 'utf8'));
  } catch {
    return { captured: {}, lastRun: null };
  }
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(CAPTURE_STATE, JSON.stringify(state, null, 2));
}

// ============================================================================
// GET RECENT SESSIONS via openclaw CLI
// ============================================================================
function getRecentSessions() {
  try {
    // Get sessions active in the last 480 minutes (8h) — covers a work session
    const output = execSync('openclaw sessions --active 480 --json 2>/dev/null || echo "{}"', {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 15000
    });
    
    try {
      const parsed = JSON.parse(output.trim());
      // openclaw sessions returns { sessions: [...] }
      return (parsed.sessions || []).filter(s => {
        // Only capture direct/telegram sessions, skip cron/subagent/run sessions
        const key = s.key || '';
        return key.includes('telegram:') || s.kind === 'direct';
      });
    } catch {
      console.log('⚠️  Could not parse sessions list as JSON');
      return [];
    }
  } catch (err) {
    console.log(`⚠️  Could not list sessions: ${err.message.split('\n')[0]}`);
    return [];
  }
}

// ============================================================================
// EXTRACT KEY POINTS from session messages
// ============================================================================
function extractKeyPoints(messages) {
  if (!messages || messages.length === 0) return null;

  const keyPoints = [];
  const decisions = [];
  const todos = [];
  const topics = new Set();

  for (const msg of messages) {
    const text = msg.content || msg.text || msg.message || '';
    if (!text || text.length < 20) continue;
    
    // Skip system/heartbeat messages
    if (text.includes('HEARTBEAT_OK') || text.includes('heartbeat')) continue;
    if (text.includes('Session Startup sequence')) continue;
    
    const lower = text.toLowerCase();
    
    // Detect decisions
    if (lower.includes('decided') || lower.includes('going with') || lower.includes('let\'s do') || 
        lower.includes('approved') || lower.includes('declined') || lower.includes('confirmed')) {
      decisions.push(text.substring(0, 200));
    }
    
    // Detect todos/next steps
    if (lower.includes('todo') || lower.includes('next step') || lower.includes('need to') || 
        lower.includes('should') || lower.includes('will do') || lower.includes('remind me')) {
      todos.push(text.substring(0, 200));
    }
    
    // Extract topic keywords (crude but effective)
    const topicPatterns = [
      /(?:about|regarding|for)\s+(\w+(?:\s+\w+)?)/gi,
      /(?:client|project|agent|email|campaign|flow)\s*:?\s*(\w+)/gi
    ];
    for (const pat of topicPatterns) {
      let m;
      while ((m = pat.exec(text)) !== null) {
        if (m[1].length > 2 && m[1].length < 30) topics.add(m[1].toLowerCase());
      }
    }
  }

  // Count substantive messages (not just short acks)
  const substantive = messages.filter(m => {
    const t = m.content || m.text || m.message || '';
    return t.length > 50 && !t.includes('HEARTBEAT') && !t.includes('NO_REPLY');
  });

  if (substantive.length < 2) return null; // Not worth capturing

  return {
    messageCount: messages.length,
    substantiveCount: substantive.length,
    decisions,
    todos,
    topics: [...topics].slice(0, 10)
  };
}

// ============================================================================
// FORMAT SUMMARY for daily MD
// ============================================================================
function formatSummary(sessionKey, analysis, timestamp) {
  const time = new Date(timestamp).toLocaleTimeString('en-GB', { 
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kiev' 
  });
  
  let summary = `## ${time} — Session Summary (auto-captured)\n`;
  summary += `⚪ Session \`${sessionKey.substring(0, 8)}\`: ${analysis.substantiveCount} substantive messages`;
  
  if (analysis.topics.length > 0) {
    summary += ` · Topics: ${analysis.topics.join(', ')}`;
  }
  summary += '\n';
  
  if (analysis.decisions.length > 0) {
    summary += `- **Decisions:** ${analysis.decisions.map(d => d.substring(0, 100)).join('; ')}\n`;
  }
  
  if (analysis.todos.length > 0) {
    summary += `- **Open threads:** ${analysis.todos.map(t => t.substring(0, 100)).join('; ')}\n`;
  }

  return summary;
}

// ============================================================================
// CREATE HANDOFF NODE
// ============================================================================
function createHandoff(summary) {
  try {
    const escaped = summary.replace(/"/g, '\\"').replace(/\n/g, ' ').substring(0, 500);
    execSync(`node "${CONSTELLATION}" handoff "${escaped}"`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 30000
    });
    console.log('✅ Handoff node created');
    return true;
  } catch (err) {
    console.log(`⚠️  Handoff creation failed: ${err.message.split('\n')[0]}`);
    return false;
  }
}

// ============================================================================
// APPEND TO DAILY MD + INGEST
// ============================================================================
function appendToDaily(text) {
  const today = new Date().toISOString().split('T')[0];
  const mdPath = path.join(MEMORY_DIR, `${today}.md`);
  
  let existing = '';
  try { existing = fs.readFileSync(mdPath, 'utf8'); } catch {}
  
  if (!existing) {
    existing = `# Memory — ${today}\n\n`;
  }
  
  fs.writeFileSync(mdPath, existing + '\n' + text + '\n');
  console.log(`📝 Appended to ${today}.md`);
  
  // Ingest
  try {
    execSync(`node "${CONSTELLATION}" ingest "${mdPath}"`, {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 60000
    });
    console.log('🧠 Ingested into constellation');
  } catch (err) {
    console.log(`⚠️  Ingest failed: ${err.message.split('\n')[0]}`);
  }
}

// ============================================================================
// MANUAL HANDOFF (--handoff "summary text")
// ============================================================================
function manualHandoff(text) {
  console.log('📋 Creating manual handoff...');
  createHandoff(text);
  
  const time = new Date().toLocaleTimeString('en-GB', { 
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kiev' 
  });
  
  const mdEntry = `## ${time} — Session Handoff\n🟡 ${text}\n`;
  appendToDaily(mdEntry);
  console.log('✅ Manual handoff complete');
}

// ============================================================================
// MAIN
// ============================================================================
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const handoffIdx = args.indexOf('--handoff');
  
  if (handoffIdx !== -1) {
    const text = args.slice(handoffIdx + 1).filter(a => !a.startsWith('--')).join(' ');
    if (!text) {
      console.log('Usage: node session-capture.js --handoff "summary text"');
      process.exit(1);
    }
    if (dryRun) {
      console.log('[DRY RUN] Would create handoff:', text);
    } else {
      manualHandoff(text);
    }
    return;
  }

  console.log('🔍 Checking for uncaptured sessions...');
  const state = loadState();
  const sessions = getRecentSessions();
  
  if (sessions.length === 0) {
    console.log('No sessions found or unable to list');
    saveState(state);
    return;
  }

  let captured = 0;
  for (const session of sessions) {
    const key = session.key || session.sessionKey || session.id;
    if (!key) continue;
    
    // Skip if already captured
    if (state.captured[key]) {
      continue;
    }
    
    // Skip very recent sessions (might still be active)
    const lastActive = session.lastActive || session.updatedAt;
    if (lastActive) {
      const age = Date.now() - new Date(lastActive).getTime();
      if (age < 10 * 60 * 1000) { // Skip if active in last 10 minutes
        continue;
      }
    }

    console.log(`\n📋 Session: ${key.substring(0, 8)}...`);
    
    const tokens = session.totalTokens || 0;
    const model = session.model || 'unknown';
    
    // Skip tiny sessions (< 5K tokens = probably just boot + ack)
    if (tokens < 5000) {
      console.log(`  → Too small (${tokens} tokens), skipping`);
      state.captured[key] = { skipped: true, reason: 'too_small', at: new Date().toISOString() };
      continue;
    }

    // For sessions with enough tokens, log that they need a handoff
    // We can't extract message content from CLI — that's the agent's job during the session
    const ageMin = Math.round((session.ageMs || 0) / 60000);
    
    if (dryRun) {
      console.log(`  [DRY RUN] Session ${key.substring(0, 8)}: ${tokens} tokens, ${model}, ${ageMin}min ago — NEEDS HANDOFF`);
    } else {
      // Check if today's daily MD already mentions this session key
      const today = new Date().toISOString().split('T')[0];
      const mdPath = path.join(MEMORY_DIR, `${today}.md`);
      let dailyContent = '';
      try { dailyContent = fs.readFileSync(mdPath, 'utf8'); } catch {}
      
      const sessionShort = key.substring(0, 12);
      if (dailyContent.includes(sessionShort) || dailyContent.includes('Session Handoff') || dailyContent.includes('Session Summary')) {
        console.log(`  → Already has handoff/summary in daily MD, marking captured`);
        state.captured[key] = { at: new Date().toISOString(), tokens, note: 'found_in_daily' };
      } else {
        // Flag as uncaptured — will be reported
        console.log(`  ⚠️  ${tokens} tokens, ${model}, ${ageMin}min ago — NO HANDOFF FOUND`);
        console.log(`     → Agent should have created one. Logging gap.`);
        
        const gapEntry = `\n## ${new Date().toISOString()} — Missing Handoff\n- Session: ${key}\n- Tokens: ${tokens}, Model: ${model}\n- Age: ${ageMin} minutes\n- **Action needed:** Review and create manual handoff if significant\n`;
        fs.appendFileSync(GAPS_FILE, gapEntry);
        state.captured[key] = { at: new Date().toISOString(), tokens, flagged: true };
        captured++;
      }
    }
  }

  saveState(state);
  console.log(`\n✅ Done. Captured ${captured} session(s).`);
}

main();
