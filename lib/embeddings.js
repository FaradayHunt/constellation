/**
 * lib/embeddings.js
 * OpenAI API functions with SQLite-backed embedding cache.
 * 
 * Changes:
 * - getEmbedding() and getEmbeddings() now check embedding_cache table first
 * - Cache misses call OpenAI API and store result in DB
 * - expandQuery() and rerankWithCrossEncoder() kept but expandQuery no longer called from search.js
 */

const crypto = require('crypto');
const { truncateText } = require('./core');
const dbModule = require('./db');

// ============================================================================
// OPENAI API FUNCTIONS
// ============================================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

async function callOpenAI(text, model = 'gpt-4o') {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: 'system',
          content: 'Condense this memory into 1-3 factual sentences. Preserve: WHO did it, WHAT happened, WHY it matters. If — and ONLY if — the text describes a mistake, failure, or explicit insight, add "Lesson: ..." at the end. Do NOT invent lessons that aren\'t in the source text.\nExample 1 (with lesson):\nMother oversold brain.js capabilities to Vlad before verifying them, causing a trust dip. Lesson: verify claims before making them.\nExample 2 (no lesson):\nArik Barel owns Judaica Web Store, an eCommerce platform since 1999 selling Jewish ritual items, jewelry, and home décor from Jerusalem.'
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0.3,
      max_tokens: 200
    })
  });
  if (!response.ok) {
    // Fallback to OpenRouter on 429 or 5xx
    const orKey = process.env.OPENROUTER_API_KEY;
    if ((response.status === 401 || response.status === 429 || response.status >= 500) && orKey) {
      const orResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${orKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Condense this memory into 1-3 factual sentences. Preserve: WHO did it, WHAT happened, WHY it matters. If — and ONLY if — the text describes a mistake, failure, or explicit insight, add "Lesson: ..." at the end. Do NOT invent lessons that aren\'t in the source text.' },
            { role: 'user', content: text }
          ],
          temperature: 0.3,
          max_tokens: 200
        })
      });
      if (!orResponse.ok) {
        throw new Error(`OpenRouter fallback also failed: ${orResponse.status} ${orResponse.statusText}`);
      }
      const orData = await orResponse.json();
      return orData.choices[0].message.content.trim();
    }
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const result = data.choices[0].message.content.trim();
  
  // Strip "Keywords:" suffix to prevent noise in embeddings
  const keywordsIndex = result.indexOf('\nKeywords:');
  if (keywordsIndex !== -1) {
    return result.substring(0, keywordsIndex).trim();
  }
  
  return result;
}

// ============================================================================
// EMBEDDING CACHE HELPERS
// ============================================================================

function getTextHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function _fetchEmbedding(text) {
  // Try OpenAI first, fall back to OpenRouter
  const providers = [
    { url: 'https://api.openai.com/v1/embeddings', key: OPENAI_API_KEY },
    { url: 'https://openrouter.ai/api/v1/embeddings', key: process.env.OPENROUTER_API_KEY }
  ];
  for (const provider of providers) {
    if (!provider.key) continue;
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${provider.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-large',
          input: text,
          dimensions: 1024,
          encoding_format: 'float'
        })
      });
      if (!response.ok) {
        const msg = `${response.status} ${response.statusText}`;
        if (response.status === 429 || response.status === 402) continue; // try next provider
        throw new Error(`Embedding API error: ${msg}`);
      }
      const data = await response.json();
      return data.data[0].embedding;
    } catch (e) {
      if (e.message?.includes('429') || e.message?.includes('402') || e.message?.includes('quota')) continue;
      throw e;
    }
  }
  throw new Error('All embedding providers failed (quota exhausted)');
}

async function _fetchEmbeddings(texts) {
  const providers = [
    { url: 'https://api.openai.com/v1/embeddings', key: OPENAI_API_KEY },
    { url: 'https://openrouter.ai/api/v1/embeddings', key: process.env.OPENROUTER_API_KEY }
  ];
  for (const provider of providers) {
    if (!provider.key) continue;
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${provider.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-large',
          input: texts,
          dimensions: 1024,
          encoding_format: 'float'
        })
      });
      if (!response.ok) {
        if (response.status === 429 || response.status === 402) continue;
        throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      return data.data.map(item => item.embedding);
    } catch (e) {
      if (e.message?.includes('429') || e.message?.includes('402') || e.message?.includes('quota')) continue;
      throw e;
    }
  }
  throw new Error('All embedding providers failed (quota exhausted)');
}

// ============================================================================
// PUBLIC EMBEDDING FUNCTIONS (with SQLite cache)
// ============================================================================

/**
 * Get embedding for a single text.
 * Checks SQLite embedding_cache first; calls OpenAI API on miss.
 */
async function getEmbedding(text) {
  // Check cache
  const cached = dbModule.getCachedEmbedding(text);
  if (cached && cached.length > 0) {
    return cached;
  }
  
  // Cache miss — call API
  const vector = await _fetchEmbedding(text);
  
  // Store in cache
  dbModule.setCachedEmbedding(text, vector);
  
  return vector;
}

/**
 * Get embeddings for multiple texts.
 * Checks cache for each text; only calls API for cache misses.
 */
async function getEmbeddings(texts) {
  if (!texts || texts.length === 0) return [];
  
  const results = new Array(texts.length).fill(null);
  const missIndices = [];
  const missTexts = [];
  
  // Check cache for all texts
  for (let i = 0; i < texts.length; i++) {
    const cached = dbModule.getCachedEmbedding(texts[i]);
    if (cached && cached.length > 0) {
      results[i] = cached;
    } else {
      missIndices.push(i);
      missTexts.push(texts[i]);
    }
  }
  
  // Fetch only cache misses
  if (missTexts.length > 0) {
    const vectors = await _fetchEmbeddings(missTexts);
    
    // Store in cache and fill results
    for (let j = 0; j < missTexts.length; j++) {
      const idx = missIndices[j];
      results[idx] = vectors[j];
      if (vectors[j]) {
        dbModule.setCachedEmbedding(missTexts[j], vectors[j]);
      }
    }
  }
  
  return results;
}

// ============================================================================
// QUERY EXPANSION (kept but no longer called from search.js)
// ============================================================================
async function expandQuery(query) {
  if (query.split(/\s+/).length > 12) return query;
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
            content: 'Expand this search query into a richer version for semantic search. Add related terms, synonyms, and context. Keep it to 1-2 sentences. Return ONLY the expanded query, nothing else.'
          },
          { role: 'user', content: query }
        ],
        temperature: 0.3,
        max_tokens: 100
      })
    });
    if (!response.ok) return query;
    const data = await response.json();
    const expanded = data.choices[0].message.content.trim();
    return `${query} ${expanded}`;
  } catch {
    return query;
  }
}

// ============================================================================
// CROSS-ENCODER RERANKING (kept but no longer called from search.js)
// ============================================================================
const rerankCache = new Map();
const RERANK_CACHE_TTL = 5 * 60 * 1000;

function getRerankCacheKey(query, nodeIds) {
  return crypto.createHash('sha256')
    .update(query + nodeIds.sort().join(','))
    .digest('hex')
    .substring(0, 16);
}

async function rerankWithCrossEncoder(query, candidates) {
  const cacheKey = getRerankCacheKey(query, candidates.map(c => c.id));
  const cached = rerankCache.get(cacheKey);
  const now = Date.now();
  
  if (cached && (now - cached.timestamp) < RERANK_CACHE_TTL) {
    candidates.forEach((c, idx) => {
      c.rerankScore = cached.scores[idx] || 0;
    });
    return candidates;
  }
  
  try {
    const docList = candidates.map((c, idx) => {
      const text = c.distilled || truncateText(c.text, 200);
      return `${idx + 1}. ${text}`;
    }).join('\n\n');
    
    const prompt = `Rate the relevance of each document to the query on a scale of 0.0 to 1.0.

Query: "${query}"

Documents:
${docList}

Return a JSON array of ${candidates.length} scores (0.0 to 1.0), one for each document in order. Example: [0.9, 0.7, 0.3, ...]`;
    
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
            content: 'You are a relevance scoring system. Return only a JSON array of scores, no explanation.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 200
      })
    });
    
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    
    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    let scores;
    try {
      scores = JSON.parse(content);
      if (!Array.isArray(scores) || scores.length !== candidates.length) {
        throw new Error('Invalid score array length');
      }
    } catch (e) {
      const nums = content.match(/0\.\d+|1\.0/g);
      if (nums && nums.length === candidates.length) {
        scores = nums.map(n => parseFloat(n));
      } else {
        throw new Error('Failed to parse rerank scores');
      }
    }
    
    candidates.forEach((c, idx) => {
      c.rerankScore = scores[idx] || 0;
    });
    
    rerankCache.set(cacheKey, { scores, timestamp: now });
    
    if (rerankCache.size > 100) {
      const oldestKey = Array.from(rerankCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
      rerankCache.delete(oldestKey);
    }
    
    return candidates;
  } catch (error) {
    console.error(`⚠️  Reranking failed: ${error.message}. Falling back to original ranking.`);
    candidates.forEach(c => {
      c.rerankScore = c.totalScore;
    });
    return candidates;
  }
}

function cosineSimilarity(vecA, vecB) {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

module.exports = {
  OPENAI_API_KEY,
  callOpenAI,
  getEmbedding,
  getEmbeddings,
  expandQuery,
  getRerankCacheKey,
  rerankWithCrossEncoder,
  cosineSimilarity
};
