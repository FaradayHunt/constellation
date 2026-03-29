const { cosineSimilarity } = require('./embeddings');
const { isCore, buildAdjacencyMap } = require('./core');

function parseMemoryContent(text) {
  const entities = new Set();
  const tags = new Set();
  
  // Noise words to filter out (common verbs, articles, generic words)
  const noiseWords = new Set([
    'Fixed', 'Phase', 'Run', 'Set', 'Email', 'Emails', 'Feb', 'Jan', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'Who', 'What', 'When', 'Where', 'Why', 'How', 'Has', 'Had', 'Have', 'Was', 'Were', 'Been', 'Being',
    'Based', 'Goal', 'Mindset', 'Note', 'Notes', 'Added', 'Update', 'Updated', 'Build', 'Built', 'Create', 'Created',
    'Use', 'Used', 'Using', 'Make', 'Made', 'Making', 'Get', 'Got', 'Getting', 'Need', 'Needs', 'Needed'
  ]);
  
  // Entity patterns - much more specific
  const patterns = {
    // Only capture company names we know
    companies: /\b(?:Apple|Google|Microsoft|Amazon|Meta|Tesla|OpenAI|Anthropic|GitHub|Discord|Slack|Zoom|AWS|Azure|GCP|Ecomhero|Klaviyo|Shopify|Supabase|Vercel|Telegram|WhatsApp|Twitter|Facebook|Instagram|LinkedIn)\b/gi,
    
    // Only capture known tech/tools
    tech: /\b(?:Node\.js|React|Vue|Angular|Python|JavaScript|TypeScript|HTML|CSS|API|REST|GraphQL|SQL|MongoDB|PostgreSQL|Redis|Docker|Kubernetes|OpenClaw|Cursor|VSCode|Git|npm|yarn|Webpack|Vite)\b/gi,
    
    // Capture proper nouns (but will filter with noise list)
    names: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g,
  };
  
  // Extract companies and tech (these are always good)
  Object.entries(patterns).forEach(([type, pattern]) => {
    const matches = text.match(pattern) || [];
    matches.forEach(match => {
      const cleaned = match.trim();
      
      // Filter noise
      if (cleaned.length < 3) return;
      if (noiseWords.has(cleaned)) return;
      
      // Filter out if it's just a common word
      if (type === 'names' && cleaned.length < 4 && !/[A-Z]{2,}/.test(cleaned)) return;
      
      // Add entity and tag
      entities.add(cleaned);
      if (type !== 'names') tags.add(type);
    });
  });
  
  // Deduplicate case-insensitive
  const uniqueEntities = new Map();
  Array.from(entities).forEach(entity => {
    const lower = entity.toLowerCase();
    if (!uniqueEntities.has(lower) || entity === entity.toUpperCase()) {
      uniqueEntities.set(lower, entity);
    }
  });
  
  return {
    entities: Array.from(uniqueEntities.values()),
    tags: Array.from(tags)
  };
}

function categorizeNode(text, tags) {
  const textLower = text.toLowerCase();
  
  // Identity patterns
  if (textLower.match(/\b(vlad|mother|sola|hunter)\b/) && textLower.match(/who is|i am|identity|agent|role/i)) {
    return 'identity';
  }
  
  // Client patterns
  if (tags.includes('client') || textLower.match(/\b(rs|best|judaica|cocreate|co:create)\b/i)) {
    return 'client';
  }
  
  // Strategy patterns
  if (textLower.match(/strategy|roadmap|phase \d|service-wrapped|saas|goal|plan/i)) {
    return 'strategy';
  }
  
  // Infrastructure patterns
  if (textLower.match(/cron|telegram|slack|github|mac mini|gateway|browser|api|skill|deployment/i)) {
    return 'infrastructure';
  }
  
  // Relationship patterns
  if (textLower.match(/\b(arik|john|designer|owner|contact|client)\b/i) && !textLower.match(/cron|infrastructure/i)) {
    return 'relationship';
  }
  
  // Lesson patterns
  if (textLower.match(/lesson|learned|mistake|don't|avoid|saved.*tokens/i)) {
    return 'lesson';
  }
  
  return 'general';
}

function calculateRelevance(node, searchTerms) {
  const text = (node.text || node.distilled || node.d || '').toLowerCase();
  const tags = (node.tags || []).join(' ').toLowerCase();
  const source = (node.sourceFile || '').toLowerCase();
  
  let score = 0;
  
  searchTerms.forEach(term => {
    const termLower = term.toLowerCase();
    
    // Exact matches
    if (text.includes(termLower)) {
      score += (text.split(termLower).length - 1) * 3;
    }
    
    if (tags.includes(termLower)) {
      score += 5;
    }
    
    if (source.includes(termLower)) {
      score += 2;
    }
    
    // Word boundary matches
    const wordRegex = new RegExp(`\\b${termLower}`, 'gi');
    const wordMatches = (text.match(wordRegex) || []).length;
    score += wordMatches * 2;
  });
  
  return score;
}

function calculateImportance(node, allNodes) {
  const now = Date.now();
  const dayInMs = 24 * 60 * 60 * 1000;
  
  // Recency score
  const lastUsed = node.usage?.lastUsed ? new Date(node.usage.lastUsed).getTime() : now - 90 * dayInMs;
  const timeSinceAccess = now - lastUsed;
  const recencyScore = Math.max(0, 1 - (timeSinceAccess / (90 * dayInMs)));
  
  // Core nodes get bonus
  const coreBonus = isCore(node) ? 0.3 : 0;
  
  // Usage bonus
  const usageBonus = Math.min((node.usage?.hits || 0) * 0.02, 0.3);
  
  return (recencyScore * 0.4) + coreBonus + usageBonus + 0.3;
}

function findMatchingNodes(snippet, brain) {
  const snipLower = snippet.toLowerCase().trim();
  if (snipLower.length < 10) return [];
  
  const matches = [];
  
  for (const node of brain.nodes) {
    const nodeLower = (node.text || '').toLowerCase();
    if (nodeLower.length < 10) continue;
    
    // Check for substring match
    const shortNode = nodeLower.substring(0, 50);
    const shortSnip = snipLower.substring(0, 60);
    
    if (shortSnip.includes(shortNode.substring(0, 30)) || shortNode.includes(shortSnip.substring(0, 30))) {
      matches.push(node.id);
    }
  }
  
  return matches;
}

function calculateTextSimilarity(text1, text2) {
  // Handle null/undefined text inputs
  if (!text1 || !text2) return 0;
  
  const words1 = new Set(text1.toLowerCase().match(/\w+/g) || []);
  const words2 = new Set(text2.toLowerCase().match(/\w+/g) || []);
  
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  
  return union.size > 0 ? intersection.size / union.size : 0;
}

function findConnections(newNode, existingNodes) {
  let connections = [];
  
  // If embeddings available, use cosine similarity (much better than text overlap)
  if (newNode.embedding && newNode.embedding.length > 0) {
    existingNodes.forEach(existingNode => {
      if (existingNode.id === newNode.id) return;
      if (!existingNode.embedding || existingNode.embedding.length === 0) return;
      
      const similarity = cosineSimilarity(newNode.embedding, existingNode.embedding);
      
      // Only create edges for nodes with similarity > 0.92 (high threshold to avoid mesh)
      if (similarity > 0.92) {
        connections.push({
          targetId: existingNode.id,
          weight: Math.round(similarity * 100) / 100,
          similarity
        });
      }
    });
    // Cap at 15 strongest edges per node
    connections.sort((a, b) => b.similarity - a.similarity);
    connections = connections.slice(0, 15);
  } else {
    // Fallback to old method if no embeddings (but with higher threshold)
    existingNodes.forEach(existingNode => {
      if (existingNode.id === newNode.id) return;
      
      let connectionWeight = 0;
      
      // Entity overlap
      const newEntities = new Set(newNode.entities || []);
      const existingEntities = new Set(existingNode.entities || []);
      const entityOverlap = new Set([...newEntities].filter(e => existingEntities.has(e)));
      connectionWeight += entityOverlap.size * 0.5;
      
      // Tag overlap
      const newTags = new Set(newNode.tags || []);
      const existingTags = new Set(existingNode.tags || []);
      const tagOverlap = new Set([...newTags].filter(t => existingTags.has(t)));
      connectionWeight += tagOverlap.size * 0.3;
      
      // Text similarity
      const textSimilarity = calculateTextSimilarity(newNode.text, existingNode.text);
      connectionWeight += textSimilarity * 0.2;
      
      // Same source file
      if (newNode.sourceFile === existingNode.sourceFile) {
        connectionWeight += 0.1;
      }
      
      // Create connection if significant (increased threshold from 0.15 to 0.5)
      if (connectionWeight > 0.5) {
        connections.push({
          targetId: existingNode.id,
          weight: Math.round(connectionWeight * 100) / 100
        });
      }
    });
  }
  
  return connections;
}

module.exports = {
  parseMemoryContent,
  categorizeNode,
  calculateRelevance,
  calculateImportance,
  findMatchingNodes,
  calculateTextSimilarity,
  findConnections
};
