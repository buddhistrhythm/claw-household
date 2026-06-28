# rsspool

A **downstream of [RSSHub](https://docs.rsshub.app/)**. RSSHub already turns
almost anything — **小红书** collections, **X.com** likes, **Hacker News**, and
of course **tech blogs** (Anthropic, Netflix, Cloudflare, …) — into RSS.
rsspool stays pure: it just **subscribes to feeds**, pools them into
**Postgres/SQLite + an Obsidian vault**, serves them over **MCP**, exports them
to **NotebookLM**, and turns them into *A Tour of Go*-style **quiz levels**.

```
RSSHub ──┐
native RSS ─┤→  rsspool  →  Postgres / SQLite (+FTS)  →  MCP server
file feeds ─┘        │            Obsidian vault          NotebookLM export
                     └─ normalize → enrich (tags) → dedup  quiz levels
```

Everything upstream is RSS — no bespoke scrapers, paid APIs, or cookies in
rsspool itself. Auth/scraping is RSSHub's job.

## Quick start

```bash
cd rsspool
npm install            # better-sqlite3 + MCP SDK; pg is optional

node src/cli.js feeds          # show configured feeds + resolved URLs
node src/cli.js ingest         # fetch all feeds → store + Obsidian
node src/cli.js ingest --source blog --limit 10
node src/cli.js stats
node src/cli.js search "rag agents"
node src/cli.js recent --tag llm
node src/cli.js quiz --count 5
node src/cli.js export-notebooklm
```

Copy `.env.example` → `.env` to set your RSSHub instance and storage.

## Configuring feeds

Edit `config/feeds.json`. Each feed is identified by `name` / `source` /
`category` and points at one of:

```jsonc
{
  "rsshub": { "base": "https://rsshub.app", "accessKey": null },
  "feeds": [
    // native RSS — absolute url
    { "name": "Anthropic", "source": "blog", "category": "ai", "url": "https://www.anthropic.com/rss.xml" },

    // via RSSHub — a route path resolved against rsshub.base
    { "name": "我的小红书收藏", "source": "xiaohongshu", "category": "life",
      "rsshub": "/xiaohongshu/user/USER_ID/collect" },
    { "name": "我的 X 点赞", "source": "x", "category": "social",
      "rsshub": "/twitter/likes/HANDLE" },
    { "name": "Hacker News best", "source": "hackernews", "category": "tech",
      "rsshub": "/hackernews/best" },

    // local file — handy for tests / static pools
    { "name": "Sample", "source": "blog", "category": "tech", "file": "fixtures/sample-blog.rss.xml" }
  ]
}
```

`RSSHUB_BASE` / `RSSHUB_ACCESS_KEY` env vars override the `rsshub` block.
Find routes in the [RSSHub docs](https://docs.rsshub.app/) — many social
routes need RSSHub configured with the relevant cookie/token upstream.

## Storage

- **Default:** SQLite + FTS5, zero setup (`data/rsspool.db`).
- **Postgres:** set `DATABASE_URL` — schema (JSONB + tsvector) auto-migrates.
- **Obsidian:** every item is mirrored to `data/vault/<source>/<id>__<slug>.md`
  with YAML frontmatter (queryable via Dataview). Disable with
  `RSSPOOL_OBSIDIAN_DISABLED=1`.

Items are normalized to a stable id + content hash, so re-ingesting is
idempotent — only changed items touch the store or vault.

## MCP

```json
{
  "mcpServers": {
    "rsspool": {
      "command": "node",
      "args": ["/absolute/path/to/rsspool/src/cli.js", "mcp"],
      "env": { "RSSHUB_BASE": "https://your-rsshub.example" }
    }
  }
}
```

Tools: `pool_search`, `pool_get`, `pool_recent`, `pool_list_sources`,
`pool_stats`, `pool_related`, `pool_ingest`, `pool_quiz`.

## NotebookLM

NotebookLM has no public ingestion API, so integration is export-based:
`export-notebooklm` bundles items into clean per-source markdown files (plus a
`README.md` with upload steps) under `RSSPOOL_EXPORT_DIR`. Upload them as
sources in a NotebookLM notebook for chat, study guides, and audio overviews.

## Tests

```bash
npm test     # node --test, fixture-based (file feeds), no network
```

## Roadmap

- Web UI: graph/board view of pooled items linked by shared tags & topics.
- LLM enrichment: summaries, embeddings, semantic related-items, richer quizzes.
- Scheduled ingestion (cron) + per-feed incremental cursors.
