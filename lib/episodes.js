/**
 * lib/episodes.js
 * Episodic memory: extraction, querying, auto-creation of event sequences
 */

const fs = require('fs');
const path = require('path');
const { 
  MEMORY_DIR,
  loadBrain, 
  saveBrain, 
  generateStableId, 
  sleep 
} = require('./core');
const { OPENAI_API_KEY, getEmbedding, getEmbeddings, cosineSimilarity } = require('./embeddings');

// ============================================================================
// EXTRACT EPISODES FROM TEXT
// ============================================================================
async function extractEpisodesFromText(text, sourceFile, brain) {
  const prompt = `Extract event sequences from this daily log. For each sequence, identify:
- Events in chronological order
- Causal links (decided→because→led_to)
- Overall theme

Return a JSON array of episodes. Each episode should have:
{
  "events": [
    {"action": "decided", "summary": "brief event description"},
    {"action": "because", "summary": "reasoning or cause"},
    {"action": "led_to", "summary": "consequence or outcome"}
  ],
  "theme": "brief theme name (e.g., 'strategic direction', 'client work')",
  "timespan": {"start": "YYYY-MM-DDTHH:mm:ssZ", "end": "YYYY-MM-DDTHH:mm:ssZ"}
}

Text:
${text}

Return ONLY valid JSON array, no explanation.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You extract event sequences from narrative text. Return valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    // Parse JSON — strip markdown fences if present
    let extractedEpisodes;
    try {
      const cleaned = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      extractedEpisodes = JSON.parse(cleaned);
      if (!Array.isArray(extractedEpisodes)) {
        extractedEpisodes = [extractedEpisodes];
      }
    } catch (e) {
      console.log(`   ⚠️  Failed to parse episode JSON: ${e.message}`);
      return [];
    }

    // Link events to existing constellation nodes by matching content
    const episodes = [];
    for (const ep of extractedEpisodes) {
      if (!ep.events || ep.events.length === 0) continue;

      // Try to link each event to an existing node
      const linkedEvents = [];
      for (const event of ep.events) {
        const eventText = event.summary || '';
        
        // Find best matching node by text similarity
        let bestNode = null;
        let bestScore = 0;
        
        for (const node of brain.nodes) {
          if (node.mergedInto || !node.distilled) continue;
          
          const nodeText = (node.distilled || '').toLowerCase();
          const eventLower = eventText.toLowerCase();
          
          // Simple word overlap scoring
          const eventWords = new Set(eventLower.split(/\W+/).filter(w => w.length > 3));
          const nodeWords = new Set(nodeText.split(/\W+/).filter(w => w.length > 3));
          const overlap = [...eventWords].filter(w => nodeWords.has(w)).length;
          const score = overlap / Math.max(eventWords.size, 1);
          
          if (score > bestScore && score > 0.3) {
            bestScore = score;
            bestNode = node;
          }
        }

        linkedEvents.push({
          nodeId: bestNode ? bestNode.id : null,
          timestamp: ep.timespan?.start || new Date().toISOString(),
          action: event.action || 'event',
          summary: eventText
        });
      }

      const episodeId = generateStableId(`episode-${ep.theme}-${linkedEvents.map(e => e.summary).join('')}`);
      
      episodes.push({
        id: episodeId,
        events: linkedEvents,
        theme: ep.theme || 'general',
        timespan: ep.timespan || {
          start: new Date().toISOString(),
          end: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        sourceFile: sourceFile
      });
    }

    return episodes;
  } catch (error) {
    console.log(`   ❌ Episode extraction failed: ${error.message}`);
    return [];
  }
}

// ============================================================================
// EPISODE COMMAND — extract episodes from daily memory files
// ============================================================================
async function episodeCommand(args) {
  const dateFilter = args.find(a => a.match(/^\d{4}-\d{2}-\d{2}$/));
  
  console.log(`📖 Extracting episodes from daily memory files${dateFilter ? ` (date: ${dateFilter})` : ''}...\n`);
  
  const brain = loadBrain();
  
  // Find daily memory files
  const memoryFiles = [];
  if (fs.existsSync(MEMORY_DIR)) {
    const dailyFiles = fs.readdirSync(MEMORY_DIR)
      .filter(file => file.match(/^\d{4}-\d{2}-\d{2}.*\.md$/))
      .filter(file => !dateFilter || file.startsWith(dateFilter))
      .sort();
    
    dailyFiles.forEach(file => {
      memoryFiles.push({ path: path.join(MEMORY_DIR, file), name: `memory/${file}` });
    });
  }

  if (memoryFiles.length === 0) {
    console.log('❌ No daily memory files found');
    return;
  }

  console.log(`📂 Processing ${memoryFiles.length} file(s)...\n`);
  
  let extracted = 0;
  let skipped = 0;

  for (const file of memoryFiles) {
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      
      // Skip if too short
      if (content.length < 100) {
        console.log(`   ⏭️  ${file.name}: too short, skipping`);
        continue;
      }

      console.log(`   🔄 Processing ${file.name}...`);
      
      const episodes = await extractEpisodesFromText(content, file.name, brain);
      
      if (episodes.length === 0) {
        console.log(`      No episodes found\n`);
        continue;
      }

      // Dedup: skip if episode with same theme+timespan already exists
      for (const episode of episodes) {
        const exists = brain.episodes.some(e => 
          e.theme === episode.theme &&
          e.timespan.start === episode.timespan.start &&
          e.timespan.end === episode.timespan.end
        );

        if (exists) {
          console.log(`      ⚠️  Episode "${episode.theme}" already exists, skipping`);
          skipped++;
          continue;
        }

        brain.episodes.push(episode);
        extracted++;
        
        console.log(`      ✅ Episode "${episode.theme}": ${episode.events.length} events`);
      }

      console.log('');
      
      // Rate limit
      await sleep(1000);
    } catch (error) {
      console.log(`   ❌ Error processing ${file.name}: ${error.message}\n`);
    }
  }

  saveBrain(brain);
  
  console.log(`✅ Episode extraction complete!`);
  console.log(`   📖 Extracted: ${extracted} episodes`);
  console.log(`   ⏭️  Skipped: ${skipped} duplicates`);
  console.log(`   📊 Total episodes: ${brain.episodes.length}\n`);
}

// ============================================================================
// EPISODE-QUERY COMMAND — query episodic memory
// ============================================================================
async function episodeQueryCommand(args) {
  const query = args.join(' ');
  
  if (!query) {
    console.log('Usage: node brain.js episode-query "why did we decide X?"');
    process.exit(1);
  }

  console.log(`🔍 Searching episodes for: "${query}"\n`);
  
  const brain = loadBrain();
  
  if (!brain.episodes || brain.episodes.length === 0) {
    console.log('❌ No episodes found. Run: node brain.js episode');
    return;
  }

  // Embed the query
  let queryEmbedding;
  try {
    queryEmbedding = await getEmbedding(query);
  } catch (error) {
    console.log(`❌ Failed to embed query: ${error.message}`);
    return;
  }

  // Score episodes by:
  // (a) cosine similarity against event summaries
  // (b) theme matching
  // (c) time range if query contains dates
  
  const scoredEpisodes = [];
  
  // Batch embed all episode texts at once for speed
  const episodeTexts = brain.episodes.map(ep => ep.events.map(e => e.summary).join(' '));
  let episodeEmbeddings = [];
  try {
    episodeEmbeddings = await getEmbeddings(episodeTexts);
  } catch (error) {
    console.log(`⚠️  Batch embed failed, falling back to BM25-only: ${error.message}`);
  }
  
  const queryLower = query.toLowerCase();
  const dateMatch = query.match(/\d{4}-\d{2}-\d{2}/);
  
  for (let i = 0; i < brain.episodes.length; i++) {
    const episode = brain.episodes[i];
    let score = 0;
    
    // (a) Cosine similarity against event summaries (pre-computed)
    if (episodeEmbeddings[i] && episodeEmbeddings[i].length > 0) {
      const similarity = cosineSimilarity(queryEmbedding, episodeEmbeddings[i]);
      score += similarity * 0.7;
    }

    // (b) Theme matching (keyword overlap)
    const themeLower = episode.theme.toLowerCase();
    if (queryLower.includes(themeLower) || themeLower.includes(queryLower)) {
      score += 0.2;
    }
    
    // (b2) BM25-style keyword match on event summaries
    const eventText = episodeTexts[i].toLowerCase();
    const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 2);
    const matchCount = queryTokens.filter(t => eventText.includes(t)).length;
    score += (matchCount / Math.max(queryTokens.length, 1)) * 0.15;

    // (c) Date matching (if query contains date)
    if (dateMatch) {
      const queryDate = dateMatch[0];
      const episodeStart = (episode.timespan?.start || '').split('T')[0];
      const episodeEnd = (episode.timespan?.end || '').split('T')[0];
      if (queryDate >= episodeStart && queryDate <= episodeEnd) {
        score += 0.3;
      }
    }

    if (score > 0.3) {
      scoredEpisodes.push({ ...episode, score });
    }
  }

  scoredEpisodes.sort((a, b) => b.score - a.score);

  if (scoredEpisodes.length === 0) {
    console.log('❌ No matching episodes found\n');
    return;
  }

  console.log(`📊 Found ${scoredEpisodes.length} matching episode(s)\n`);
  console.log('─'.repeat(80) + '\n');

  scoredEpisodes.slice(0, 5).forEach((episode, idx) => {
    const date = episode.timespan.start.split('T')[0];
    
    console.log(`${idx + 1}. 📖 Episode: "${episode.theme}" (${date})`);
    console.log(`   Score: ${episode.score.toFixed(3)}\n`);
    
    episode.events.forEach((event, eventIdx) => {
      let icon = '➡️';
      if (event.action === 'because') icon = '↪️';
      if (event.action === 'led_to') icon = '↪️';
      
      console.log(`   ${eventIdx + 1}. ${icon} ${event.summary}`);
      if (event.nodeId) {
        console.log(`      (linked to node ${event.nodeId})`);
      }
    });
    
    console.log('\n' + '─'.repeat(80) + '\n');
  });
}

// ============================================================================
// CAUSAL LANGUAGE DETECTION
// ============================================================================
function containsCausalLanguage(text) {
  const causalKeywords = [
    'decided', 'because', 'switched to', 'realized', 'led to', 
    'changed from', 'pivoted', 'chose', 'concluded', 'resulted in',
    'caused', 'triggered', 'drove', 'prompted'
  ];
  
  const textLower = text.toLowerCase();
  return causalKeywords.some(keyword => textLower.includes(keyword));
}

// ============================================================================
// AUTO-CREATE EPISODE from single node
// ============================================================================
async function autoCreateEpisode(node, brain) {
  if (!containsCausalLanguage(node.text)) {
    return null;
  }

  console.log(`   🔍 Causal language detected, creating mini-episode...`);

  // Extract the causal chain from this node
  const prompt = `Extract a causal event sequence from this text. Return JSON:
{
  "events": [
    {"action": "decided/because/led_to", "summary": "brief description"}
  ],
  "theme": "brief theme"
}

Text: ${node.distilled || node.text}

Return ONLY valid JSON, no explanation.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You extract causal event chains. Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    const parsed = JSON.parse(content);
    
    if (!parsed.events || parsed.events.length === 0) {
      return null;
    }

    // Link all events to this node
    const linkedEvents = parsed.events.map(e => ({
      nodeId: node.id,
      timestamp: node.usage?.firstSeen || new Date().toISOString(),
      action: e.action || 'event',
      summary: e.summary
    }));

    const episodeId = generateStableId(`episode-auto-${node.id}-${parsed.theme}`);
    
    const episode = {
      id: episodeId,
      events: linkedEvents,
      theme: parsed.theme || 'general',
      timespan: {
        start: node.usage?.firstSeen || new Date().toISOString(),
        end: node.usage?.firstSeen || new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      sourceFile: node.sourceFile
    };

    // Check for duplicates
    const exists = brain.episodes.some(e => e.id === episodeId);
    if (exists) {
      return null;
    }

    brain.episodes.push(episode);
    console.log(`   ✅ Auto-episode "${episode.theme}": ${episode.events.length} events`);
    
    return episode;
  } catch (error) {
    console.log(`   ⚠️  Auto-episode creation failed: ${error.message}`);
    return null;
  }
}

module.exports = {
  extractEpisodesFromText,
  episodeCommand,
  episodeQueryCommand,
  containsCausalLanguage,
  autoCreateEpisode
};
