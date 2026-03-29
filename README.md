# Constellation 🧠

A knowledge graph memory system for AI agents. Stores memories as nodes with semantic embeddings, auto-wires them via entity extraction and cosine similarity, and retrieves with 2-hop graph traversal + MMR diversity.

Built for [OpenClaw](https://openclaw.ai) agents but works standalone.

## Features

- **Semantic search** — OpenAI embeddings + BM25 hybrid scoring
- **Knowledge graph** — entities auto-extracted, edges auto-wired (cosine + entity overlap)
- **2-hop traversal** — queries surface connected context, not just direct matches
- **Temporal decay** — recent memories rank higher, old ones fade naturally
- **MMR diversity** — results are diverse, not 10 variations of the same thing
- **Auto-ingestion** — write markdown → ingest → distill + embed + wire in ~2-3s
- **Session handoffs** — capture session summaries for cross-session continuity
- **SQLite backend** — fast, single-file, no external DB needed

## Setup

```bash
# Clone and install
git clone https://github.com/FaradayHunt/constellation.git
cd constellation
npm install

# Set your OpenAI key
cp .env.example .env
# Edit .env with your OPENAI_API_KEY
```

## Usage

The system expects to live in a `memory/` directory inside your workspace:

```
workspace/
├── memory/
│   ├── constellation.js    # CLI entry point
│   ├── lib/                # Core modules
│   ├── constellation.db    # Auto-created SQLite DB
│   └── 2026-03-29.md       # Daily memory files
```

### Core Commands

```bash
# Search your memory
node constellation.js query "search terms"
node constellation.js query -c "compact output"

# Add a memory
node constellation.js ingest "Important decision: we chose X over Y because..."

# Ingest a markdown file
node constellation.js ingest memory/2026-03-29.md

# Session handoffs (for agent continuity)
node constellation.js handoff "Session summary: built feature X, decided Y, open thread Z"
node constellation.js recall-recent -c

# Graph maintenance
node constellation.js rebuild          # Rebuild graph from memory files
node constellation.js stats            # Show statistics
node constellation.js embed            # Generate embeddings
node constellation.js dedup            # Merge duplicate nodes
node constellation.js deep-link        # Deep-link related nodes (requires Ollama)
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | For embeddings and LLM distillation |
| `OPENROUTER_API_KEY` | No | Fallback LLM provider |
| `CONSTELLATION_WORKSPACE` | No | Override workspace root (default: auto-detect from `__dirname`) |
| `OLLAMA_MODEL` | No | Model for cortex deep-linking (default: `qwen3:8b`) |

### Support Scripts

| Script | Purpose |
|--------|---------|
| `heartbeat-enhance.js` | Periodic maintenance (ingest, gaps, prune) |
| `session-capture.js` | Auto-capture uncaptured sessions |
| `tag-enforcer.js` | Auto-tag untagged daily entries |
| `ingest-verify.js` | Review ingest success/fail rates |
| `build-portal.js` | Build web visualization portal |
| `rag.js` | RAG document store |

## Architecture

- **constellation.js** — CLI router
- **lib/core.js** — Brain load/save, ID generation
- **lib/db.js** — SQLite schema + accessors (better-sqlite3)
- **lib/search.js** — Hybrid semantic + BM25 search with 2-hop graph traversal
- **lib/ingest.js** — Distill → embed → extract entities → wire
- **lib/embeddings.js** — OpenAI embedding + LLM calls
- **lib/graph.js** — Graph rebuild, rewire, orphan fixing
- **lib/maintenance.js** — Stats, compaction, decay, archive, dedup
- **lib/cortex.js** — Deep-linking via local Ollama
- **lib/handoff.js** — Session handoff creation + recall
- **lib/advanced.js** — Conflict detection, feedback, RAPTOR
- **lib/episodes.js** — Episode clustering
- **lib/tracking.js** — Usage tracking
- **lib/bm25.js** — BM25 scoring
- **lib/parsing.js** — Memory text parsing + categorization

## License

MIT
