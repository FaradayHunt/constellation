#!/usr/bin/env node
/**
 * rag.js — RAG Document System for Constellation
 * 
 * Separate from constellation.js. Chunks documents, embeds them,
 * stores in its own JSON, and queries alongside brain nodes.
 * 
 * Usage:
 *   node rag.js ingest <file>              Chunk + embed a document
 *   node rag.js ingest-dir [dir]           Ingest all docs in memory/docs/
 *   node rag.js query "search terms"       Search doc chunks (+ brain nodes)
 *   node rag.js list                       List ingested documents
 *   node rag.js remove <docId>             Remove a document and its chunks
 *   node rag.js stats                      Show RAG stats
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadBrain, buildAdjacencyMap } = require('./lib/core');
const { getEmbedding, getEmbeddings, cosineSimilarity } = require('./lib/embeddings');

// ============================================================================
// CONSTANTS
// ============================================================================
const WORKSPACE = process.env.CONSTELLATION_WORKSPACE || require('path').resolve(__dirname, '..');
const RAG_PATH = path.join(WORKSPACE, 'memory/rag-store.json');
const DOCS_DIR = path.join(WORKSPACE, 'memory/docs');
const CHUNK_SIZE = 800;       // target tokens per chunk
const CHUNK_OVERLAP = 100;    // overlap tokens between chunks
const MAX_RESULTS = 8;

// ============================================================================
// RAG STORE
// ============================================================================
function loadStore() {
  if (!fs.existsSync(RAG_PATH)) {
    return { version: 1, documents: [], chunks: [] };
  }
  return JSON.parse(fs.readFileSync(RAG_PATH, 'utf8'));
}

function saveStore(store) {
  fs.writeFileSync(RAG_PATH, JSON.stringify(store, null, 2));
}

// ============================================================================
// TEXT EXTRACTION
// ============================================================================
function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  
  if (['.md', '.txt', '.csv', '.json', '.html', '.xml', '.yaml', '.yml', '.js', '.ts', '.py'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  
  // For PDF — try pdftotext if available
  if (ext === '.pdf') {
    try {
      const { execSync } = require('child_process');
      return execSync(`pdftotext "${filePath}" -`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      console.error('❌ pdftotext not found. Install poppler: brew install poppler');
      process.exit(1);
    }
  }
  
  // For DOCX — try pandoc
  if (ext === '.docx') {
    try {
      const { execSync } = require('child_process');
      return execSync(`pandoc "${filePath}" -t plain`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      console.error('❌ pandoc not found. Install: brew install pandoc');
      process.exit(1);
    }
  }
  
  throw new Error(`Unsupported file type: ${ext}`);
}

// ============================================================================
// CHUNKING
// ============================================================================
function chunkText(text, source) {
  // Split by paragraphs first, then merge into chunks
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
  const chunks = [];
  let current = '';
  let chunkIndex = 0;
  
  for (const para of paragraphs) {
    const words = para.split(/\s+/).length;
    const currentWords = current.split(/\s+/).length;
    
    if (currentWords + words > CHUNK_SIZE && current.trim()) {
      chunks.push({
        id: crypto.createHash('sha256').update(`${source}:${chunkIndex}`).digest('hex').substring(0, 10),
        text: current.trim(),
        index: chunkIndex,
        source
      });
      // Keep overlap
      const currentTokens = current.trim().split(/\s+/);
      current = currentTokens.slice(-CHUNK_OVERLAP).join(' ') + '\n\n' + para;
      chunkIndex++;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  
  // Last chunk
  if (current.trim()) {
    chunks.push({
      id: crypto.createHash('sha256').update(`${source}:${chunkIndex}`).digest('hex').substring(0, 10),
      text: current.trim(),
      index: chunkIndex,
      source
    });
  }
  
  // If text had no paragraph breaks, split by sentences
  if (chunks.length === 0 && text.trim().length > 20) {
    chunks.push({
      id: crypto.createHash('sha256').update(`${source}:0`).digest('hex').substring(0, 10),
      text: text.trim().substring(0, CHUNK_SIZE * 5), // rough char limit
      index: 0,
      source
    });
  }
  
  return chunks;
}

// ============================================================================
// INGEST
// ============================================================================
async function ingestFile(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`❌ File not found: ${absPath}`);
    process.exit(1);
  }
  
  const store = loadStore();
  const fileName = path.basename(absPath);
  const fileHash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').substring(0, 12);
  const docId = crypto.createHash('sha256').update(absPath).digest('hex').substring(0, 10);
  
  // Check if already ingested (same hash = skip)
  const existing = store.documents.find(d => d.id === docId);
  if (existing && existing.hash === fileHash) {
    console.log(`⏭️  ${fileName} already ingested (unchanged)`);
    return;
  }
  
  // Remove old chunks if re-ingesting
  if (existing) {
    store.chunks = store.chunks.filter(c => c.docId !== docId);
    store.documents = store.documents.filter(d => d.id !== docId);
    console.log(`🔄 Re-ingesting ${fileName} (content changed)`);
  }
  
  console.log(`📄 Extracting text from ${fileName}...`);
  const text = extractText(absPath);
  
  if (!text || text.trim().length < 20) {
    console.error('❌ No meaningful text extracted');
    return;
  }
  
  console.log(`✂️  Chunking (${text.split(/\s+/).length} words)...`);
  const rawChunks = chunkText(text, fileName);
  console.log(`   ${rawChunks.length} chunks created`);
  
  // Embed all chunks
  console.log(`🧠 Embedding ${rawChunks.length} chunks...`);
  const texts = rawChunks.map(c => c.text.substring(0, 2000)); // trim for embedding
  const embeddings = await getEmbeddings(texts);
  
  const docChunks = rawChunks.map((chunk, i) => ({
    ...chunk,
    docId,
    embedding: embeddings[i] || null
  }));
  
  // Register document
  store.documents.push({
    id: docId,
    name: fileName,
    path: absPath,
    hash: fileHash,
    chunks: rawChunks.length,
    words: text.split(/\s+/).length,
    ingestedAt: new Date().toISOString()
  });
  
  store.chunks.push(...docChunks);
  saveStore(store);
  
  console.log(`✅ ${fileName} → ${rawChunks.length} chunks embedded and stored`);
}

async function ingestDir(dir) {
  const docsDir = dir || DOCS_DIR;
  if (!fs.existsSync(docsDir)) {
    console.log('📁 No docs directory found. Create memory/docs/ and drop files there.');
    return;
  }
  
  const files = fs.readdirSync(docsDir).filter(f => !f.startsWith('.'));
  if (files.length === 0) {
    console.log('📁 No files in docs directory.');
    return;
  }
  
  console.log(`📚 Found ${files.length} files in ${docsDir}\n`);
  for (const file of files) {
    await ingestFile(path.join(docsDir, file));
    console.log('');
  }
}

// ============================================================================
// QUERY
// ============================================================================
async function queryDocs(queryText, opts = {}) {
  const { brainToo = true, maxResults = MAX_RESULTS, compact = false } = opts;
  
  const store = loadStore();
  if (store.chunks.length === 0 && !brainToo) {
    console.log('📭 No documents ingested yet. Run: node rag.js ingest <file>');
    return [];
  }
  
  // Get query embedding
  const queryEmb = await getEmbedding(queryText);
  if (!queryEmb) {
    console.error('❌ Failed to get query embedding');
    return [];
  }
  
  // Score RAG chunks
  const scoredChunks = store.chunks
    .filter(c => c.embedding)
    .map(c => ({
      ...c,
      score: cosineSimilarity(queryEmb, c.embedding),
      type: 'doc'
    }))
    .filter(c => c.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
  
  // Optionally merge with brain nodes
  let results = scoredChunks;
  
  if (brainToo) {
    const brain = loadBrain();
    const scoredNodes = brain.nodes
      .filter(n => n.embedding)
      .map(n => ({
        id: n.id,
        text: n.distilled || n.text,
        score: cosineSimilarity(queryEmb, n.embedding),
        type: 'memory',
        tier: n.tier,
        usage: n.usage || 0
      }))
      .filter(n => n.score > 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    
    // Merge and re-sort
    results = [...scoredChunks, ...scoredNodes]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }
  
  // Display
  if (results.length === 0) {
    console.log('🔍 No relevant results found.');
    return [];
  }
  
  console.log(`\n🔍 Results for: "${queryText}"\n`);
  results.forEach((r, i) => {
    const tag = r.type === 'doc' ? `📄 ${r.source}` : `🧠 ${r.tier || 'memory'}`;
    const scoreStr = (r.score * 100).toFixed(0);
    const preview = compact
      ? r.text.substring(0, 120).replace(/\n/g, ' ')
      : r.text.substring(0, 300).replace(/\n/g, ' ');
    console.log(`  ${i + 1}. [${scoreStr}%] ${tag}`);
    console.log(`     ${preview}...`);
    console.log('');
  });
  
  return results;
}

// ============================================================================
// LIST / REMOVE / STATS
// ============================================================================
function listDocs() {
  const store = loadStore();
  if (store.documents.length === 0) {
    console.log('📭 No documents ingested.');
    return;
  }
  console.log(`\n📚 ${store.documents.length} documents:\n`);
  store.documents.forEach(d => {
    console.log(`  📄 ${d.name} (${d.chunks} chunks, ${d.words} words)`);
    console.log(`     ID: ${d.id} | Ingested: ${d.ingestedAt}`);
    console.log(`     Path: ${d.path}`);
    console.log('');
  });
}

function removeDoc(docId) {
  const store = loadStore();
  const doc = store.documents.find(d => d.id === docId || d.name === docId);
  if (!doc) {
    console.error(`❌ Document not found: ${docId}`);
    return;
  }
  store.chunks = store.chunks.filter(c => c.docId !== doc.id);
  store.documents = store.documents.filter(d => d.id !== doc.id);
  saveStore(store);
  console.log(`🗑️  Removed ${doc.name} and its ${doc.chunks} chunks`);
}

function showStats() {
  const store = loadStore();
  const totalChunks = store.chunks.length;
  const totalDocs = store.documents.length;
  const withEmbeddings = store.chunks.filter(c => c.embedding).length;
  const totalWords = store.documents.reduce((s, d) => s + (d.words || 0), 0);
  
  console.log(`\n📊 RAG Store Stats:`);
  console.log(`   Documents: ${totalDocs}`);
  console.log(`   Chunks: ${totalChunks} (${withEmbeddings} embedded)`);
  console.log(`   Total words: ${totalWords.toLocaleString()}`);
  
  if (fs.existsSync(RAG_PATH)) {
    const size = fs.statSync(RAG_PATH).size;
    console.log(`   Store size: ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log('');
}

// ============================================================================
// CLI
// ============================================================================
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command) {
    console.log('Usage: node rag.js <command> [args]');
    console.log('');
    console.log('Commands:');
    console.log('  ingest <file>        Chunk + embed a document');
    console.log('  ingest-dir [dir]     Ingest all files in memory/docs/');
    console.log('  query "search"       Search docs (+ brain nodes)');
    console.log('  query-docs "search"  Search docs only (no brain)');
    console.log('  list                 List ingested documents');
    console.log('  remove <id|name>     Remove a document');
    console.log('  stats                Show stats');
    process.exit(1);
  }
  
  switch (command) {
    case 'ingest':
      if (!args[1]) { console.error('Usage: node rag.js ingest <file>'); process.exit(1); }
      await ingestFile(args[1]);
      break;
    case 'ingest-dir':
      await ingestDir(args[1]);
      break;
    case 'query':
      await queryDocs(args.slice(1).join(' '));
      break;
    case 'query-docs':
      await queryDocs(args.slice(1).join(' '), { brainToo: false });
      break;
    case 'list':
      listDocs();
      break;
    case 'remove':
      if (!args[1]) { console.error('Usage: node rag.js remove <id|name>'); process.exit(1); }
      removeDoc(args[1]);
      break;
    case 'stats':
      showStats();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { queryDocs, loadStore };
