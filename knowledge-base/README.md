# Personal Knowledge Base + MCP

Aggregate the things you *like* across the web — **Hacker News** favorites,
**X.com** likes, **小红书** collections, and articles from leading **tech blogs**
(Anthropic, Uber, Google, …) — into one searchable personal knowledge base.
Stored in **Postgres or SQLite** *and* mirrored to an **Obsidian** vault, served
over **MCP**, exportable to **NotebookLM**, and turned into *A Tour of Go*-style
**quiz levels** for spaced learning.

> Inspired by [Ontos-AI/knowhere](https://github.com/Ontos-AI/knowhere)'s
> ingest → structure → agentic-RAG memory layer, scoped down to a personal,
> self-hostable knowledge base.

## Status

This is **milestone 1: ingest → store → MCP**, fully working end-to-end:

| Area | State |
|------|-------|
| Hacker News favorites connector | ✅ live (scrapes `/favorites` + Firebase API) |
| Tech-blog RSS/Atom connector | ✅ live (dependency-free feed parser) |
| X.com likes connector | ✅ works with `X_BEARER_TOKEN`; falls back to fixtures |
| 小红书 favorites connector | 🟡 stub seam (`fetchLive`); falls back to fixtures |
| Storage: SQLite + FTS5 | ✅ default, zero-setup |
| Storage: Postgres + tsvector | ✅ when `DATABASE_URL` is set |
| Obsidian vault sync | ✅ one markdown note per item |
| Keyword enrichment / tagging | ✅ offline; LLM enricher is a clean seam |
| MCP server | ✅ 8 tools over stdio |
| NotebookLM export | ✅ upload-ready markdown bundles |
| Quiz levels (A Tour of Go style) | ✅ deterministic generator (LLM seam) |
| Knowhere-style graph web UI | ⏭ roadmap (milestone 2) |

## Quick start

```bash
cd knowledge-base
npm install            # better-sqlite3 + MCP SDK; pg is optional

# Pull from the fixture-backed sources (no creds/network needed):
node src/cli.js ingest x xiaohongshu

# Or everything that's configured (HN needs HN_USERNAME, RSS hits the network):
HN_USERNAME=pg node src/cli.js ingest

node src/cli.js stats
node src/cli.js search "rag agents"
node src/cli.js recent --tag llm
node src/cli.js quiz --count 5
node src/cli.js export-notebooklm
```

Copy `.env.example` → `.env` to configure storage and connector credentials.

## Architecture

```
connectors/  ── pull raw items from each source (HN, RSS, X, 小红书)
     │           base.Connector → fetch(opts) → raw items
     ▼
pipeline/    ── normalize (stable id + content hash) → enrich (tags)
     │
     ▼
storage/     ── repository pattern, async interface
     ├─ sqlite.js     (FTS5)         ◄ default
     ├─ postgres.js   (tsvector)     ◄ when DATABASE_URL set
     └─ obsidian.js   (markdown vault sink, synced on every write)
     │
     ├──► mcp/server.js     8 tools over stdio
     ├──► quiz/generate.js  A-Tour-of-Go levels
     └──► export/notebooklm.js  upload bundles
```

Every item is normalized to a stable shape (`src/model/item.js`) with a
content hash, so re-ingesting is idempotent and only changed items touch the
store or the Obsidian vault.

## MCP

Add to your MCP client (Claude Desktop / Cursor / etc.):

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": ["/absolute/path/to/knowledge-base/src/cli.js", "mcp"],
      "env": { "HN_USERNAME": "your-hn-user" }
    }
  }
}
```

Tools: `kb_search`, `kb_get`, `kb_recent`, `kb_list_sources`, `kb_stats`,
`kb_related`, `kb_ingest`, `kb_quiz`.

## Connectors & credentials

- **Hacker News** — set `HN_USERNAME`. Favorites are read from the public
  favorites page; no auth required.
- **RSS** — edit `config/sources.json` → `rss.feeds`. The bundled list is a
  starting point; feed URLs change, so verify them for your blogs.
- **X.com** — set `X_BEARER_TOKEN` + `X_USER_ID` (paid API). Without them the
  connector reads `fixtures/x_likes.sample.json`.
- **小红书** — has no official API. Implement `XiaohongshuConnector.fetchLive()`
  against the private web endpoints using `XHS_COOKIE`. Without a cookie it
  reads `fixtures/xiaohongshu_favorites.sample.json`.

## NotebookLM

NotebookLM has no public ingestion API, so integration is export-based:
`export-notebooklm` bundles your items into clean per-source markdown files
(plus a `README.md` with upload steps) under `KB_EXPORT_DIR`. Upload them as
sources in a NotebookLM notebook to get chat, study guides, and audio overviews.

## Tests

```bash
npm test     # node --test, fixture-based, no network
```

## Roadmap (milestone 2+)

- Knowhere-style web UI: graph/board view of items linked by shared tags & topics.
- LLM enrichment: summaries, embeddings, semantic related-items, richer quizzes.
- Scheduled ingestion (cron) + incremental sync.
- 小红书 live `fetchLive` implementation.
