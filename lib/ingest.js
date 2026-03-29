/**
 * lib/ingest.js
 * Memory ingestion, distillation, embedding, and entity extraction
 */

const { 
  loadBrain, 
  saveBrain, 
  generateStableId, 
  buildAdjacencyMap, 
  sleep 
} = require('./core');
const { callOpenAI, OPENAI_API_KEY, getEmbedding, getEmbeddings } = require('./embeddings');
const { parseMemoryContent, categorizeNode } = require('./parsing');
const { cosineSimilarity } = require('./embeddings');

// ============================================================================
// AUTO IMPORTANCE SCORING
// ============================================================================
/**
 * LLM rates memory importance on ingest: returns stability multiplier.
 * Scale: 1 (ephemeral) → 3 (notable) → 10 (critical/permanent)
 * Uses gpt-4o-mini for speed/cost. Single API call adds ~200ms.
 */
async function scoreImportance(text) {
  const prompt = `Rate the importance of this memory for a personal AI assistant. Consider:
- Will this be needed in 3 days? 30 days? 6 months?
- Is this a decision, lesson, or relationship info (high value)?
- Is this a routine log entry or transient status update (low value)?

Memory: "${text.substring(0, 500)}"

Reply with ONLY a JSON object: {"score": <1-10>, "reason": "<10 words max>"}
Scale: 1-2=ephemeral (forget in days), 3-4=routine (weeks), 5-6=notable (months), 7-8=important (long-term), 9-10=critical (permanent)`;

  try {
    let response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You rate memory importance. Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1, max_tokens: 60
      })
    });

    if (!response.ok) {
      const orKey = process.env.OPENROUTER_API_KEY;
      if ((response.status === 429 || response.status >= 500) && orKey) {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai/gpt-4o-mini',
            messages: [
              { role: 'system', content: 'You rate memory importance. Return valid JSON only.' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.1, max_tokens: 60
          })
        });
      }
      if (!response.ok) return { score: 5, reason: 'API error, default score' };
    }

    const data = await response.json();
    const raw = data.choices[0].message.content.trim();
    // Parse JSON from response (handle markdown fences)
    const jsonStr = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(jsonStr);
    const score = Math.max(1, Math.min(10, parseInt(result.score) || 5));
    return { score, reason: result.reason || '' };
  } catch (e) {
    return { score: 5, reason: 'parse error, default score' };
  }
}

/**
 * Map importance score (1-10) to initial stability for Ebbinghaus decay.
 * Higher stability = slower decay = memory persists longer.
 */
function importanceToStability(score) {
  // 1-2: 0.5 (decays in ~1 day)
  // 3-4: 1.5 (decays in ~3 days)
  // 5-6: 4.0 (decays in ~1 week)
  // 7-8: 12.0 (decays in ~2 weeks)
  // 9-10: 30.0 (decays in ~1 month)
  const map = { 1: 0.5, 2: 0.8, 3: 1.5, 4: 2.5, 5: 4.0, 6: 6.0, 7: 10.0, 8: 15.0, 9: 25.0, 10: 40.0 };
  return map[score] || 4.0;
}

// ============================================================================
// PROPOSITION DECOMPOSITION
// ============================================================================
async function decomposeIntoPropositions(text) {
  // Skip if text is already short/atomic (< 100 words)
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 100) {
    return [text]; // Return as-is
  }
  
  // Scale target propositions based on word count
  // 100-200 words → 3 props, 200-400 → 4-5, 400-600 → 6-8, 600+ → 8-12
  let minPropositions = 3;
  if (wordCount > 200) minPropositions = 4;
  if (wordCount > 400) minPropositions = 6;
  if (wordCount > 600) minPropositions = 8;
  
  const prompt = `Break the following text into ${minPropositions}-${minPropositions + 3} atomic facts, one per line. Each fact should be a single, self-contained statement.

Text: "${text}"

Return only the facts, one per line, no numbering or bullets. Aim for ${minPropositions}-${minPropositions + 3} distinct propositions.`;
  
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
          { role: 'system', content: 'You decompose text into atomic facts. Always produce the requested number of propositions.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 800
      })
    });
    
    if (!response.ok) {
      const orKey = process.env.OPENROUTER_API_KEY;
      if ((response.status === 429 || response.status >= 500) && orKey) {
        console.log(`   🔄 OpenAI ${response.status}, falling back to OpenRouter...`);
        const orResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai/gpt-4o-mini',
            messages: [
              { role: 'system', content: 'You decompose text into atomic facts. Always produce the requested number of propositions.' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.2, max_tokens: 800
          })
        });
        if (orResp.ok) {
          const orData = await orResp.json();
          const result = orData.choices[0].message.content.trim();
          const props = result.split('\n').map(l => l.replace(/^[\d\.\-\*\+]\s*/, '').trim()).filter(l => l.length > 10);
          if (props.length >= minPropositions) return props;
        }
      }
      console.log(`   ⚠️  Proposition decomposition failed: ${response.status}`);
      return [text];
    }
    
    const data = await response.json();
    const result = data.choices[0].message.content.trim();
    const propositions = result.split('\n')
      .map(line => line.replace(/^[\d\.\-\*\+]\s*/, '').trim())
      .filter(line => line.length > 10);
    
    // Validate we got enough propositions
    if (propositions.length < minPropositions) {
      console.log(`   ⚠️  Only got ${propositions.length} propositions (wanted ${minPropositions}+), using fallback`);
      return [text];
    }
    
    return propositions.length > 0 ? propositions : [text];
  } catch (error) {
    console.log(`   ⚠️  Proposition decomposition error: ${error.message}`);
    return [text];
  }
}

// ============================================================================
// ENTITY EXTRACTION
// ============================================================================
async function extractEntities(distilledText) {
  const prompt = `Extract structured entities and relationships from this text. Return valid JSON only.
Text: "${distilledText}"
Return JSON with this structure:
{
  "people": [{"name": "Full Name", "role": "their role/title"}],
  "companies": [{"name": "Company Name", "type": "company type"}],
  "tools": [{"name": "Tool Name", "purpose": "what it's for"}],
  "topics": ["topic1", "topic2"],
  "dates": [{"date": "YYYY-MM-DD or description", "event": "what happened"}],
  "decisions": [{"decision": "what was decided", "context": "why"}],
  "relationships": [
    {"from": "Entity A", "rel": "relationship", "to": "Entity B"}
  ]
}
Extract real entities only. For topics, include specific subject areas, technologies, strategies, or domains mentioned (e.g., "Klaviyo", "email automation", "SaaS strategy"). For decisions, capture any choices made or conclusions reached. For relationships, use verbs like: owns, works-for, uses, manages, built-by, client-of, contains, related-to`;
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
          content: 'You are an expert entity extractor. Return valid JSON only, no explanation.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 500
    })
  });
  if (!response.ok) {
    const orKey = process.env.OPENROUTER_API_KEY;
    if ((response.status === 429 || response.status >= 500) && orKey) {
      console.log(`   🔄 OpenAI ${response.status}, falling back to OpenRouter for extraction...`);
      const orResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are an expert entity extractor. Return valid JSON only, no explanation.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1, max_tokens: 500
        })
      });
      if (orResp.ok) {
        const orData = await orResp.json();
        const orJson = orData.choices[0].message.content.trim();
        try { return JSON.parse(orJson); } catch(e) {}
      }
    }
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const jsonStr = data.choices[0].message.content.trim();
  
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.log(`   ⚠️  JSON parse error for: ${distilledText.substring(0, 50)}...`);
    return { people: [], companies: [], tools: [], topics: [], dates: [], decisions: [], relationships: [] };
  }
}

// ============================================================================
// DISTILL COMMAND
// ============================================================================
async function distillCommand() {
  console.log('🧠 Starting distillation process (with proposition-level chunking)...\n');
  
  const brain = loadBrain();
  const nodesToDistill = brain.nodes.filter(node => 
    !node.distilled || node.distilled.trim() === ''
  ).filter(node => !node.parentId); // Only process parent chunks, not propositions
  
  if (nodesToDistill.length === 0) {
    console.log('✅ All nodes already have distilled content!');
    return;
  }
  
  console.log(`📝 Processing ${nodesToDistill.length} nodes in batches of 5...\n`);
  
  let processed = 0;
  let propositionsCreated = 0;
  const batchSize = 5;
  const nodeMap = new Map();
  brain.nodes.forEach(n => nodeMap.set(n.id, n));
  const existingIds = new Set(brain.nodes.map(n => n.id));
  
  for (let i = 0; i < nodesToDistill.length; i += batchSize) {
    const batch = nodesToDistill.slice(i, i + batchSize);
    
    console.log(`🔄 Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(nodesToDistill.length/batchSize)}:`);
    
    for (const node of batch) {
      try {
        console.log(`   Processing node ${node.id}...`);
        
        // === UPGRADE 2: Decompose into propositions BEFORE distillation ===
        const propositions = await decomposeIntoPropositions(node.text);
        
        if (propositions.length > 1) {
          console.log(`   📄 Decomposed into ${propositions.length} propositions`);
          
          // Create child nodes for each proposition
          for (const propText of propositions) {
            const propId = generateStableId(propText + node.id); // Hash includes parent ID for uniqueness
            
            if (existingIds.has(propId)) {
              console.log(`   ⚠️  Proposition ${propId} already exists, skipping`);
              continue;
            }
            
            // Distill the proposition
            const propDistilled = await callOpenAI(propText);
            
            const propNode = {
              id: propId,
              text: propText,
              distilled: propDistilled,
              category: node.category,
              sourceFile: node.sourceFile,
              tags: node.tags,
              parentId: node.id, // Link to parent chunk
              usage: { hits: 0, referenced: 0, stability: 1.0, lastUsed: null, firstSeen: new Date().toISOString() },
              tier: 'synapse'
            };
            
            brain.nodes.push(propNode);
            nodeMap.set(propId, propNode);
            existingIds.add(propId);
            propositionsCreated++;
            
            await sleep(200);
          }
          
          // Still distill the parent for backward compatibility
          const distilled = await callOpenAI(node.text);
          node.distilled = distilled;
          processed++;
          console.log(`   ✅ Parent distilled + ${propositions.length} propositions created`);
        } else {
          // Single proposition or short text — just distill normally
          const distilled = await callOpenAI(node.text);
          node.distilled = distilled;
          processed++;
          console.log(`   ✅ Distilled: ${distilled.substring(0, 80)}${distilled.length > 80 ? '...' : ''}`);
        }
        
        // Small delay between individual calls
        await sleep(200);
      } catch (error) {
        console.log(`   ❌ Failed to distill node ${node.id}: ${error.message}`);
      }
    }
    
    // Save progress after each batch
    saveBrain(brain);
    console.log(`   💾 Saved progress (${processed}/${nodesToDistill.length} parent nodes, ${propositionsCreated} propositions)\n`);
    
    // Delay between batches to avoid rate limits
    if (i + batchSize < nodesToDistill.length) {
      await sleep(1000);
    }
  }
  
  console.log(`\n✅ Distillation complete!`);
  console.log(`   📦 ${processed} parent nodes distilled`);
  console.log(`   📄 ${propositionsCreated} propositions created`);
}

// ============================================================================
// EMBED COMMAND
// ============================================================================
async function embedCommand() {
  console.log('🚀 Starting embedding process...\n');
  
  const brain = loadBrain();
  const nodesToEmbed = brain.nodes.filter(node => (node.distilled || node.d) && (!node.embedding || node.embedding.length === 0));
  
  if (nodesToEmbed.length === 0) {
    console.log('✅ All nodes with distilled content already have embeddings!');
    return;
  }
  
  console.log(`🔢 Processing ${nodesToEmbed.length} nodes in batches of 20...\n`);
  
  let processed = 0;
  const batchSize = 20;
  
  for (let i = 0; i < nodesToEmbed.length; i += batchSize) {
    const batch = nodesToEmbed.slice(i, i + batchSize);
    const texts = batch.map(node => node.distilled || node.d);
    
    try {
      console.log(`🔄 Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(nodesToEmbed.length/batchSize)}: ${batch.length} nodes...`);
      
      const embeddings = await getEmbeddings(texts);
      
      batch.forEach((node, idx) => {
        node.embedding = embeddings[idx];
        processed++;
      });
      
      // Save progress after each batch
      saveBrain(brain);
      console.log(`   ✅ Generated embeddings for ${batch.length} nodes`);
      console.log(`   💾 Saved progress (${processed}/${nodesToEmbed.length} completed)\n`);
      
      // Delay between batches
      if (i + batchSize < nodesToEmbed.length) {
        await sleep(500);
      }
    } catch (error) {
      console.log(`   ❌ Failed to embed batch: ${error.message}`);
    }
  }
  
  console.log(`\n✅ Embedding complete! Processed ${processed}/${nodesToEmbed.length} nodes.`);
}

// ============================================================================
// EXTRACT COMMAND
// ============================================================================
async function extractCommand() {
  console.log('🔍 Starting entity extraction process...\n');
  
  const brain = loadBrain();
  const nodesToExtract = brain.nodes.filter(node => 
    node.distilled && 
    node.distilled.trim() !== '' && 
    !node.extractedEntities
  );
  
  if (nodesToExtract.length === 0) {
    console.log('✅ All distilled nodes already have extracted entities!');
    return;
  }
  
  console.log(`🏗️  Processing ${nodesToExtract.length} nodes in batches of 5...\n`);
  
  let processed = 0;
  const batchSize = 5;
  
  for (let i = 0; i < nodesToExtract.length; i += batchSize) {
    const batch = nodesToExtract.slice(i, i + batchSize);
    
    console.log(`🔄 Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(nodesToExtract.length/batchSize)}:`);
    
    for (const node of batch) {
      try {
        console.log(`   Processing node ${node.id}...`);
        const extracted = await extractEntities(node.distilled);
        node.extractedEntities = extracted;
        processed++;
        
        const entityCount = (extracted.people?.length || 0) + 
                           (extracted.companies?.length || 0) + 
                           (extracted.tools?.length || 0);
        console.log(`   ✅ Extracted ${entityCount} entities, ${extracted.relationships?.length || 0} relationships`);
        
        // Small delay between individual calls
        await sleep(300);
      } catch (error) {
        console.log(`   ❌ Failed to extract entities for node ${node.id}: ${error.message}`);
      }
    }
    
    // Save progress after each batch
    saveBrain(brain);
    console.log(`   💾 Saved progress (${processed}/${nodesToExtract.length} completed)\n`);
    
    // Delay between batches to avoid rate limits
    if (i + batchSize < nodesToExtract.length) {
      await sleep(1500);
    }
  }
  
  console.log(`\n✅ Entity extraction complete! Processed ${processed}/${nodesToExtract.length} nodes.`);
}

// ============================================================================
// INGEST COMMAND
// ============================================================================
async function ingestCommand(args) {
  let text = args.join(' ').trim();
  // If argument looks like a file path, read file content instead
  const fs = require('fs');
  const path = require('path');
  if (text && !text.includes('\n') && text.length < 500) {
    const resolved = path.resolve(text);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      console.log(`📂 Detected file path: ${text} — reading content...`);
      text = fs.readFileSync(resolved, 'utf-8').trim();
      console.log(`   Read ${text.length} chars from file`);
    }
  }
  if (!text || text.length < 10) {
    console.log('Usage: node brain.js ingest "memory text to add"');
    console.log('  Adds a single memory: decompose → distill → embed → wire → save');
    process.exit(1);
  }
  const brain = loadBrain();
  const id = generateStableId(text);
  // Check if already exists
  if (brain.nodes.find(n => n.id === id)) {
    console.log(`⚠️  Node ${id} already exists, skipping.`);
    return;
  }
  console.log(`🧠 Ingesting memory (${text.length} chars)...`);
  
  // 1. Parse entities/tags
  const parsed = parseMemoryContent(text);
  const category = categorizeNode(text, parsed.tags);
  
  // === UPGRADE 2: Decompose into propositions BEFORE distillation ===
  const propositions = await decomposeIntoPropositions(text);
  console.log(`   📄 Decomposed into ${propositions.length} proposition(s)`);
  
  // 2. Distill parent
  let distilled;
  try {
    distilled = await callOpenAI(text);
    console.log(`   ✅ Distilled parent: ${distilled.substring(0, 80)}...`);
  } catch (e) {
    console.log(`   ❌ Distill failed: ${e.message}. Using raw text.`);
    distilled = text.substring(0, 300);
  }
  // 3. Embed
  let embedding = [];
  try {
    embedding = await getEmbedding(distilled);
    console.log(`   ✅ Embedded (${embedding.length} dims)`);
  } catch (e) {
    console.log(`   ❌ Embed failed: ${e.message}`);
  }
  
  // === DEDUP-ON-INGEST: Check for near-exact duplicates (>0.95) ===
  // Threshold raised from 0.88→0.95 to prevent merging related-but-different content
  // (e.g. two health entries, two supplement lists). Only true duplicates get merged.
  if (embedding.length > 0) {
    let bestMatch = null;
    let bestSim = 0;
    
    for (const existing of brain.nodes) {
      if (existing.mergedInto || !existing.embedding?.length) continue;
      const sim = cosineSimilarity(embedding, existing.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = existing;
      }
    }
    
    if (bestSim > 0.95) {
      console.log(`   🔀 DUPLICATE DETECTED: ${bestMatch.id} (similarity: ${bestSim.toFixed(3)})`);
      console.log(`   📝 Existing: ${bestMatch.distilled?.substring(0, 80)}...`);
      console.log(`   📝 New:      ${distilled.substring(0, 80)}...`);
      
      // Merge: update existing node if new text is longer/more informative
      if (text.length > (bestMatch.text?.length || 0)) {
        console.log(`   🔄 Merging into existing node (new text is longer)`);
        bestMatch.text = text;
        bestMatch.distilled = distilled;
        bestMatch.usage.referenced++;
        bestMatch.usage.lastUsed = new Date().toISOString();
      } else {
        console.log(`   ✅ Keeping existing node (original is more complete)`);
        bestMatch.usage.referenced++;
        bestMatch.usage.lastUsed = new Date().toISOString();
      }
      
      saveBrain(brain);
      console.log(`   ✅ Merged into ${bestMatch.id}`);
      return; // Exit early, don't create new node
    } else if (bestSim > 0.88) {
      console.log(`   ℹ️  Similar node found: ${bestMatch.id} (${bestSim.toFixed(3)}) — creating separate node (threshold: 0.95)`);
    }
  }
  // 4. Extract entities from distilled text
  let extractedEntities = { people: [], companies: [], tools: [], dates: [], relationships: [] };
  if (distilled) {
    try {
      extractedEntities = await extractEntities(distilled);
      console.log(`   ✅ Extracted entities: ${(extractedEntities.people?.length || 0) + (extractedEntities.companies?.length || 0) + (extractedEntities.tools?.length || 0)} entities, ${extractedEntities.relationships?.length || 0} relationships`);
    } catch (e) {
      console.log(`   ❌ Entity extraction failed: ${e.message}`);
    }
  }
  // 5. Create parent node
  // Auto importance scoring: LLM rates the memory, sets initial stability
  let importanceResult = { score: 5, reason: 'default' };
  try {
    importanceResult = await scoreImportance(text);
    console.log(`   🎯 Importance: ${importanceResult.score}/10 (${importanceResult.reason})`);
  } catch (e) {
    console.log(`   ⚠️  Importance scoring failed: ${e.message}`);
  }
  
  let initialStability = importanceToStability(importanceResult.score);
  
  // Entity count can still boost stability on top of LLM score
  const entityCount = (extractedEntities.people?.length || 0) + 
                      (extractedEntities.companies?.length || 0) + 
                      (extractedEntities.tools?.length || 0);
  if (entityCount >= 5) {
    initialStability = Math.max(initialStability, initialStability * 1.3);
  } else if (entityCount >= 3) {
    initialStability = Math.max(initialStability, initialStability * 1.15);
  }
  
  const node = {
    id,
    text,
    distilled,
    embedding,
    category,
    sourceFile: 'ingest',
    tags: [...parsed.tags, category].filter((t, i, a) => t && a.indexOf(t) === i),
    extractedEntities,
    importanceScore: importanceResult.score,
    importanceReason: importanceResult.reason,
    usage: { hits: 0, referenced: 0, stability: initialStability, lastUsed: null, firstSeen: new Date().toISOString(), recallIntervals: [] },
    tier: 'synapse',
  };
  
  brain.nodes.push(node);
  
  // 5b. Create proposition child nodes (Upgrade 2)
  let propCount = 0;
  if (propositions.length > 1) {
    // Filter out already-existing propositions
    const newProps = propositions.filter(p => !brain.nodes.find(n => n.id === generateStableId(p + id)));
    
    if (newProps.length > 0) {
      try {
        // Batch distill: one LLM call for all propositions
        const distillPrompt = newProps.map((p, i) => `[${i}] ${p}`).join('\n');
        const batchDistilled = await callOpenAI(
          `Distill each numbered proposition into a concise summary with keywords. Return one summary per line, numbered [0], [1], etc.\n\n${distillPrompt}`,
          'gpt-4o-mini'
        );
        const distilledLines = batchDistilled.split('\n').filter(l => l.trim());
        
        // Batch embed: one API call for all
        const propDistilleds = newProps.map((_, i) => {
          const line = distilledLines.find(l => l.includes(`[${i}]`));
          return line ? line.replace(/^\[?\d+\]?\s*/, '').trim() : newProps[i];
        });
        const propEmbeddings = await getEmbeddings(propDistilleds);
        
        // Batch extract entities: parallel calls (3 concurrent max)
        const CONCURRENCY = 3;
        const propEntitiesArr = new Array(newProps.length).fill(null);
        for (let i = 0; i < newProps.length; i += CONCURRENCY) {
          const batch = newProps.slice(i, i + CONCURRENCY);
          const results = await Promise.all(
            batch.map((_, j) => extractEntities(propDistilleds[i + j]).catch(() => ({ people: [], companies: [], tools: [], dates: [], relationships: [] })))
          );
          results.forEach((r, j) => { propEntitiesArr[i + j] = r; });
        }
        
        // Create nodes
        for (let i = 0; i < newProps.length; i++) {
          const propId = generateStableId(newProps[i] + id);
          const propNode = {
            id: propId,
            text: newProps[i],
            distilled: propDistilleds[i],
            embedding: propEmbeddings[i] || [],
            category,
            sourceFile: 'ingest',
            tags: [...parsed.tags, category].filter((t, idx, a) => t && a.indexOf(t) === idx),
            extractedEntities: propEntitiesArr[i] || { people: [], companies: [], tools: [], dates: [], relationships: [] },
            parentId: id,
            usage: { hits: 0, referenced: 0, stability: initialStability, lastUsed: null, firstSeen: new Date().toISOString(), recallIntervals: [] },
            tier: 'synapse'
          };
          brain.nodes.push(propNode);
          propCount++;
        }
      } catch (e) {
        console.log(`   ⚠️  Batch proposition processing failed: ${e.message}`);
      }
    }
    console.log(`   ✅ Created ${propCount} proposition nodes`);
  }
  // 6. Wire — find edges via cosine similarity (>0.7) and entities
  let edgeCount = 0;
  if (embedding.length > 0) {
    brain.nodes.forEach(existing => {
      if (existing.mergedInto || !existing.embedding?.length) return;
      const sim = cosineSimilarity(embedding, existing.embedding);
      if (sim > 0.92) {
        brain.edges.push({
          source: id,
          target: existing.id,
          weight: Math.round(sim * 100) / 100,
          usage: { hits: 0, lastUsed: null }
        });
        edgeCount++;
      }
    });
    
    // Auto-wire orphans: if got 0 edges, lower threshold to 0.5 and connect to top 3
    if (edgeCount === 0) {
      const candidates = brain.nodes
        .filter(existing => !existing.mergedInto && existing.embedding?.length > 0)
        .map(existing => ({
          id: existing.id,
          sim: cosineSimilarity(embedding, existing.embedding)
        }))
        .filter(c => c.sim > 0.5)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 3);
      
      candidates.forEach(c => {
        brain.edges.push({
          source: id,
          target: c.id,
          weight: Math.round(c.sim * 100) / 100,
          usage: { hits: 0, lastUsed: null }
        });
        edgeCount++;
      });
      
      if (candidates.length > 0) {
        console.log(`   🔗 Orphan auto-wired to ${candidates.length} nodes (threshold 0.5)`);
      }
    }
  }
  // Entity-based edge creation (like rewire does for single node)
  if (extractedEntities && brain.nodes.length > 0) {
    const nodeEntities = [
      ...(extractedEntities.people || []).map(p => p.name),
      ...(extractedEntities.companies || []).map(c => c.name),
      ...(extractedEntities.tools || []).map(t => t.name),
      ...(extractedEntities.topics || [])
    ].map(e => e.toLowerCase().trim());
    brain.nodes.forEach(existing => {
      if (existing.id === id || existing.mergedInto || !existing.extractedEntities) return;
      
      const existingEntities = [
        ...(existing.extractedEntities.people || []).map(p => p.name),
        ...(existing.extractedEntities.companies || []).map(c => c.name),
        ...(existing.extractedEntities.tools || []).map(t => t.name),
        ...(existing.extractedEntities.topics || [])
      ].map(e => e.toLowerCase().trim());
      // Find entity overlap
      const overlap = nodeEntities.filter(e => existingEntities.includes(e));
      
      // Create edge if 2-5 shared entities (frequency range from the spec)
      if (overlap.length >= 2 && overlap.length <= 5) {
        // Check if edge doesn't already exist
        const edgeExists = brain.edges.some(edge =>
          (edge.source === id && edge.target === existing.id) ||
          (edge.source === existing.id && edge.target === id)
        );
        
        if (!edgeExists) {
          brain.edges.push({
            source: id,
            target: existing.id,
            type: 'shared_entity',
            weight: 0.5 * overlap.length,
            sharedEntities: overlap,
            usage: { hits: 0, lastUsed: null }
          });
          edgeCount++;
        }
      }
    });
  }
  
  // SAFETY SAVE: persist the node BEFORE the expensive contradiction check
  // This ensures the node exists even if conflict detection times out or crashes
  saveBrain(brain);
  console.log(`   💾 Node ${id} persisted (pre-conflict save)`);
  
  // Auto-check for contradictions with existing nodes
  // Limited to top 5 similar nodes and 10s timeout per check to prevent hangs
  if (embedding.length > 0) {
    console.log(`   🔍 Checking for contradictions...`);
    let conflictFound = false;
    
    // Collect top 5 similar nodes instead of scanning all
    const similarNodes = brain.nodes
      .filter(n => n.id !== id && !n.mergedInto && n.embedding?.length > 0)
      .map(n => ({ node: n, sim: cosineSimilarity(embedding, n.embedding) }))
      .filter(x => x.sim > 0.75)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5);
    
    for (const { node: existing } of similarNodes) {
        try {
          const conflictBody = JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: 'You are a fact-checking assistant. Respond with YES or NO, then explain briefly.' },
                { role: 'user', content: `Do these two memories contradict each other?\n\nMemory A: ${distilled}\n\nMemory B: ${existing.distilled || existing.text}\n\nReply YES or NO, then explain briefly.` }
              ],
              temperature: 0.1, max_tokens: 150
          });
          
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout per check
          
          let response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: conflictBody,
            signal: controller.signal
          });
          if (!response.ok && (response.status === 429 || response.status >= 500) && process.env.OPENROUTER_API_KEY) {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
              body: conflictBody.replace('"gpt-4o-mini"', '"openai/gpt-4o-mini"')
            });
          }
          
          clearTimeout(timeout);
          
          if (response.ok) {
            const data = await response.json();
            const answer = data.choices[0].message.content.trim();
            
            if (answer.toUpperCase().startsWith('YES')) {
              const now = new Date().toISOString();
              if (!node.conflicts) node.conflicts = [];
              if (!existing.conflicts) existing.conflicts = [];
              
              node.conflicts.push({
                nodeId: existing.id,
                explanation: answer,
                detectedAt: now,
                resolved: false
              });
              
              existing.conflicts.push({
                nodeId: id,
                explanation: answer,
                detectedAt: now,
                resolved: false
              });
              
              console.log(`   ⚠️  CONFLICT with ${existing.id}: ${answer.substring(0, 100)}...`);
              conflictFound = true;
            }
          }
          
          await sleep(300);
        } catch (error) {
          console.log(`   ⚠️  Conflict check skipped: ${error.message?.substring(0, 50)}`);
        }
    }
    
    if (!conflictFound) {
      console.log(`   ✅ No contradictions detected`);
    }
  }
  
  // 7. Run mini-infer for just this new node (check 2-hop shortcuts)
  console.log(`   🧠 Running mini-inference for new node...`);
  let inferredCount = 0;
  
  if (embedding.length > 0) {
    const adjMap = buildAdjacencyMap(brain);
    const neighborsB = (adjMap.get(id) || []).map(n => n.id);
    const inferCandidates = [];
    
    neighborsB.forEach(nodeBId => {
      const nodeB = brain.nodes.find(n => n.id === nodeBId);
      if (!nodeB) return;
      
      const edgeAB = brain.edges.find(e =>
        (e.source === id && e.target === nodeBId) ||
        (e.source === nodeBId && e.target === id)
      );
      const weightAB = edgeAB?.weight || 0.5;
      
      const neighborsC = (adjMap.get(nodeBId) || []).map(n => n.id);
      
      neighborsC.forEach(nodeCId => {
        if (nodeCId === id) return;
        const nodeC = brain.nodes.find(n => n.id === nodeCId);
        if (!nodeC || !nodeC.embedding) return;
        
        // Check if direct edge exists
        const directExists = brain.edges.some(e =>
          (e.source === id && e.target === nodeCId) ||
          (e.source === nodeCId && e.target === id)
        );
        if (directExists) return;
        
        const edgeBC = brain.edges.find(e =>
          (e.source === nodeBId && e.target === nodeCId) ||
          (e.source === nodeCId && e.target === nodeBId)
        );
        const weightBC = edgeBC?.weight || 0.5;
        
        const baseConfidence = Math.min(weightAB, weightBC) * 0.7;
        const cosineSim = cosineSimilarity(embedding, nodeC.embedding);
        
        let confidence = baseConfidence;
        if (cosineSim > 0.5) {
          confidence *= 1.3;
        } else if (cosineSim < 0.2) {
          return;
        }
        
        if (confidence > 0.3) {
          inferCandidates.push({
            target: nodeCId,
            via: nodeBId,
            confidence,
            cosineSim
          });
        }
      });
    });
    
    // Limit to top 5
    inferCandidates.sort((a, b) => b.confidence - a.confidence);
    inferCandidates.slice(0, 5).forEach(c => {
      brain.edges.push({
        source: id,
        target: c.target,
        type: 'inferred_transitive',
        weight: c.confidence,
        metadata: {
          via: c.via,
          confidence: c.confidence,
          cosineSim: c.cosineSim,
          createdAt: new Date().toISOString()
        },
        usage: { hits: 0, lastUsed: null }
      });
      inferredCount++;
    });
    
    if (inferredCount > 0) {
      console.log(`   ✅ Inferred ${inferredCount} transitive edges`);
    }
  }
  
  // === AUTO-EPISODE: Check if content contains causal language ===
  // If detected, create a mini-episode linking the new node to its causal context
  // (Note: containsCausalLanguage and autoCreateEpisode are in lib/episodes.js)
  // We'll call them conditionally if they exist
  try {
    // Check if episodes module is available
    const { containsCausalLanguage, autoCreateEpisode } = require('./episodes');
    if (containsCausalLanguage(text)) {
      await autoCreateEpisode(node, brain);
    }
  } catch (error) {
    // Episodes module not loaded yet, skip this step
  }
  
  saveBrain(brain);
  console.log(`   ✅ Added node ${id} (${category}) with ${edgeCount} edges${propCount > 0 ? ` + ${propCount} propositions` : ''}${inferredCount > 0 ? ` + ${inferredCount} inferred` : ''}`);
  console.log(`   📊 Brain: ${brain.nodes.filter(n => !n.mergedInto).length} nodes, ${brain.edges.length} edges, ${(brain.episodes || []).length} episodes`);
}

module.exports = {
  decomposeIntoPropositions,
  extractEntities,
  scoreImportance,
  importanceToStability,
  distillCommand,
  embedCommand,
  extractCommand,
  ingestCommand
};
