// ============================================================================
// BM25 FUNCTIONS (Upgrade 1)
// ============================================================================
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'will', 'with'
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[\s\.,;:!?\(\)\[\]{}"']+/)
    .filter(token => token.length > 2 && !STOPWORDS.has(token));
}

function buildBM25Index(nodes) {
  const index = new Map(); // term -> [{nodeId, tf}]
  const docFreq = new Map(); // term -> number of docs containing term
  const docLengths = new Map(); // nodeId -> doc length
  let avgDocLength = 0;
  
  // Build term frequency and document frequency
  nodes.forEach(node => {
    // Index BOTH raw text AND distilled text so BM25 catches opaque IDs/codes
    const text = [node.text || '', node.distilled || ''].join(' ');
    const tokens = tokenize(text);
    docLengths.set(node.id, tokens.length);
    avgDocLength += tokens.length;
    
    const termFreq = new Map();
    tokens.forEach(token => {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    });
    
    termFreq.forEach((tf, term) => {
      if (!index.has(term)) {
        index.set(term, []);
      }
      index.get(term).push({ nodeId: node.id, tf });
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    });
  });
  
  avgDocLength = nodes.length > 0 ? avgDocLength / nodes.length : 0;
  
  return { index, docFreq, docLengths, avgDocLength, totalDocs: nodes.length };
}

function bm25Score(queryTokens, nodeId, bm25Index, k1 = 1.5, b = 0.75) {
  const { index, docFreq, docLengths, avgDocLength, totalDocs } = bm25Index;
  const docLength = docLengths.get(nodeId) || 0;
  
  let score = 0;
  queryTokens.forEach(term => {
    if (!index.has(term)) return;
    
    const df = docFreq.get(term) || 0;
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    
    const termDocs = index.get(term) || [];
    const doc = termDocs.find(d => d.nodeId === nodeId);
    if (!doc) return;
    
    const tf = doc.tf;
    const norm = 1 - b + b * (docLength / avgDocLength);
    const tfScore = (tf * (k1 + 1)) / (tf + k1 * norm);
    
    score += idf * tfScore;
  });
  
  return score;
}

function reciprocalRankFusion(rankings, k = 60) {
  // rankings is array of arrays: [[{id, score}], [{id, score}], ...]
  // RRF score: sum(1 / (k + rank_i)) for each ranking
  const rrfScores = new Map();
  
  rankings.forEach(ranking => {
    ranking.forEach((item, rank) => {
      const currentScore = rrfScores.get(item.id) || 0;
      rrfScores.set(item.id, currentScore + 1 / (k + rank + 1));
    });
  });
  
  return Array.from(rrfScores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  STOPWORDS,
  tokenize,
  buildBM25Index,
  bm25Score,
  reciprocalRankFusion
};
