# lifeos — Competitive Landscape & Differentiation

Status: 2026-06-12 · Author: competitive analysis pass · Audience: lifeos design/positioning

> **Sourcing note.** Outbound web search *was* available for this pass (June 2026), and
> inline `[n]` citations below point to sources gathered then; the source list is at the
> bottom. Anything not cited is **my own assessment** and is marked **(assessment)**.
> Product facts move fast — treat pricing/feature specifics as "as of early-mid 2026."

---

## 0. What lifeos is (one paragraph, so the comparison has a fixed point)

lifeos is a single **Postgres "document + relations" store** that unifies *every* personal/household
domain in one schema — home inventory & placement, baby/household logs, personal finance
(encrypted sensitive fields), notes, reading, and ingested web knowledge (RSS/RSSHub).
Two tables carry it: `entities` (polymorphic node = common columns + `data JSONB` + `search`
tsvector + pgvector `embedding`) and `relations` (first-class typed `subject -predicate-> object`
edges). New domain = new `type`, **no migration**. The DB is source of truth; **Obsidian is a
rich derived mirror** (one note per entity). Retrieval is **agentic over MCP**: hybrid full-text +
vector + 1-hop relation expansion, returning **cited context** for a *client* LLM to answer
(no server-side LLM). It's **local-first / self-hosted** (docker-compose: postgres + ingest + MCP),
single-family scale, with planned **plugin ingestion endpoints** (Ray-Ban glasses, email-to-inbox,
webhooks, bots → LLM router classifies a capture into the right domain entity).

---

## 1. Landscape table

Legend for "Relevance": ★★★ direct competitor for the same job · ★★ overlapping idea/component · ★ adjacent/inspirational.

| Product | Cluster | Data model | AI / retrieval | Plugins / extensibility | Local-first / self-host | Relevance to lifeos |
|---|---|---|---|---|---|---|
| **Notion** (+Notion AI/QA) | PKM / blocks+DB | Blocks + relational databases; "data sources" abstraction (API 2025-09-03) [6] | Bundled AI Q&A over workspace; official hosted MCP server, most polished cloud KM integration [6] | Huge API; 78+ MCP servers [6] | Cloud-only [1] | ★★ Sets the "typed objects + AI Q&A" bar; opposite on ownership |
| **Tana** | PKM / outliner | Outliner + **supertags** (typed nodes) [1] | AI commands, node-level AI | Closed ecosystem | Cloud | ★★ Supertag = lightweight entity-type; good taste to study |
| **Anytype** | PKM / objects | Object-typed, **local-first**, `any-sync` P2P E2EE graph + CRDT [1][8] | Local; limited AI | Open-source, types | **Yes** (local-first, E2EE) [1][8] | ★★★ Closest *philosophy* (typed objects + ownership); different store tech |
| **Logseq** | PKM / outliner | Pure outliner; plain Markdown/org files; bidirectional links + graph view [1] | No native AI; community plugins vary [1] | Plugins | **Yes** (local MD files) [1] | ★★ Graph-as-backlinks; single-user; no relational power |
| **Obsidian** (+Smart Connections, Bases) | PKM / files+graph | Markdown files + wikilinks; **Bases** adds DB-like views; backlink graph | **Smart Connections**: local on-device embeddings, semantic search, "score_connection" in Bases; 786k+ downloads; 64+ MCP servers [2][6] | Massive plugin ecosystem | **Yes** (local files) [2] | ★★★ lifeos *uses* Obsidian as mirror; SC/Bases/MCP are the de-facto bar for local AI PKM |
| **Capacities** | PKM / objects | Object-typed ("everything is an object") [9] | Some AI | Closed | Cloud | ★ Typed-object ergonomics reference |
| **Mem** (Mem 2.0, Oct 2025) | AI PKM | Text-stream + AI auto-org; rebuild adds offline, voice, **agentic** layer that acts on notes [9] | AI-first, agentic | Closed | Cloud (offline added) [9] | ★ Capture-fast + agentic capture is directly relevant to plugin ingestion |
| **Reflect** | AI PKM | Daily-notes graph; "capture fast, connect everything, own your data" [9] | AI-powered | Closed | Cloud, E2EE leanings [9] | ★ Positioning language to study |
| **Heptabase** | PKM / canvas | Visual canvas + notes; has an MCP server [retrieval search] | Canvas-centric; MCP | Closed | Cloud | ★ Canvas not lifeos's lane; MCP exposure is |
| **Saga / Amplenote / Dendron / Twos / Saner.AI** | PKM (misc) | Blocks / outliner / hierarchical MD / lists | Varies | Varies | Mixed | ★ Field context only |
| **Grocy** | Household | Web app, **SQLite** relational; consumables/expiry/chores/batteries; barcode [3] | None | Limited | **Yes** (self-host) [3] | ★★★ Direct overlap on inventory/expiry; purpose-built but single-domain silo |
| **HomeBox** | Household | Go binary, **SQLite/Postgres**; durable goods; FTS; CSV/JSON export; multi-user roles [3] | None | Limited | **Yes** (self-host) [3] | ★★★ Direct overlap on durable inventory + placement; clean self-host |
| **Sortly** | Household | Cloud inventory; QR/barcode; for SMB/pro [3] | None notable | API | Cloud [3] | ★ Polished UX reference; business-oriented |
| **Actual Budget** | Finance | Envelope/zero-sum (YNAB-4 inspired); fast offline sync [4] | None | Plugins/community | **Yes** (self-host) [4] | ★★★ Best self-host budgeting UX; lifeos finance is ledger-lite by comparison |
| **Firefly III** | Finance | **Double-entry ledger**; rules engine (regex, split txns); multi-currency [4] | None | Rules/API | **Yes** (self-host) [4] | ★★★ The bar for correct finance data modeling |
| **Lunch Money / Monarch** | Finance | Cloud; bank-sync aggregation, categorization | Some AI categorization | API/integrations | Cloud [4] | ★★ Auto-import/categorization UX bar |
| **Readwise + Reader** | Read-it-later | Cloud library; highlights → spaced review; export everywhere | AI ("Ghostreader"), Q&A over highlights | Robust export/API | Cloud [5] | ★★★ Best capture→highlight→export pipeline; survived the shakeout |
| **Raindrop** | Bookmarks | Cloud bookmark DB; not true read-later [5] | Light | API | Cloud [5] | ★ Bookmarking reference |
| **Omnivore** (shutdown Nov 2024) | Read-it-later | Was OSS/self-hostable | — | — | Was self-host | ★★★ **Cautionary tale**: free/OSS read-later died after acquisition [5] |
| **Matter / Instapaper** | Read-it-later | Cloud reader+highlights [5] | Light AI | Export | Cloud [5] | ★ Survivors of the 2024-25 cull (Pocket, Omnivore dead) [5] |
| **Solid / Personal Data Store** | Local-first infra | Per-user "pod"; data local then CRDT-synced [8] | — | Standards | **Yes** (own pod) [8] | ★★ Ideological cousin: own-your-data, app-agnostic store |
| **Local-first movement** (Ink&Switch, Automerge 3.0, Yjs, Loro) | Local-first infra | **CRDTs** for multi-device merge [7][8] | — | Libraries | **Yes** | ★★ The path lifeos must consciously *decline* (or scope) — see §4 |

---

## 2. Where lifeos is genuinely differentiated

These are the defensible points. I've flagged where it is honestly **not** differentiated.

1. **One store across *truly* unrelated domains — inventory + finance + baby logs + knowledge in
   the same two tables, queryable together.** **(assessment)** Every competitor is a *silo*:
   Grocy/HomeBox do household, Firefly/Actual do money, Readwise does reading, Notion/Obsidian do
   notes. Nobody lets you write one query that joins "diapers running low" with "this month's
   grocery spend" with "the article I saved about brand X." lifeos's polymorphic `entities` +
   typed `relations` makes cross-domain the *default*, not an integration project. This is the
   real moat.

2. **"EAV done right on Postgres" — JSONB flexibility without EAV's query pain, and without
   per-domain migrations.** **(assessment, partly validated by your SPEC §2)** Anytype, Tana,
   Capacities also do "typed objects," but on bespoke/closed stores or CRDT graphs. lifeos gets
   the same extensibility (`new type, no schema change`) while keeping **SQL aggregation, GIN/FTS,
   and joins** — things a CRDT object graph or a Markdown vault can't do well. Firefly has correct
   finance modeling but *only* finance; lifeos trades some per-domain rigor for cross-domain reach.

3. **Relations as a first-class, *typed* knowledge graph — not backlink soup.** Logseq/Obsidian
   "graphs" are undirected backlink clouds; Notion relations are per-database. lifeos has
   directed, predicate-typed, weighted edges (`stored_in`, `issued_by`, `references`) in one table
   spanning all domains, with **direct edges treated as the strongest retrieval signal**. **(assessment)**
   That's a structurally richer graph than the PKM incumbents expose.

4. **Server-side-LLM-free, citation-first agentic retrieval over MCP.** lifeos returns *hybrid
   FTS+vector+1-hop* **cited context** and lets the *client* LLM answer. The 2026 PKM frontier is
   exactly this (hybrid BM25+vector+rerank, agentic RAG, source attribution over MCP) [6] — but the
   polished versions are Obsidian-plugin or cloud-Notion. lifeos brings it to a **multi-domain
   relational** store, which most MCP-PKM servers (vault-only) can't. **Partly differentiated**: the
   *technique* is becoming table stakes; the *substrate* (relational+graph+multi-domain) is the edge.

5. **Local-first / self-hosted, single-family scale, with privacy-aware encryption split.**
   Splitting "searchable plaintext columns vs. encrypted opaque `data.enc`" so finance stays both
   private *and* aggregatable is a genuinely thoughtful design **(assessment)** that cloud finance
   apps (Monarch/Lunch Money) structurally can't offer.

**Where lifeos is NOT differentiated (be honest):**
- **Self-hosting + ownership** alone is not a differentiator — Grocy, HomeBox, Firefly, Actual,
  Anytype, Logseq, Obsidian all have it [1][3][4][8].
- **Per-domain depth**: Firefly's double-entry + rules engine [4] and Grocy's chores/meal-planning [3]
  beat lifeos *inside their lane*. lifeos wins on breadth, not depth — own that, don't pretend otherwise.
- **Polish/UX**: Notion/Capacities/Readwise are years ahead on ergonomics. lifeos is CLI+DB+mirror.
- **Multi-device CRDT sync**: lifeos has none; Anytype/Solid/the local-first stack do [7][8].

---

## 3. What to steal (tastefully)

Concrete, scoped ideas — with who does it best.

- **Supertags / entity-type templates as a UX, not just a registry — Tana [1] / Capacities [9].**
  lifeos already has `entity_types`; expose it the way Tana exposes supertags: typing `#book` or
  `#item` in capture auto-applies the schema. Directly powers the plugin router (§6).
- **Local on-device embeddings + "related panel" — Obsidian Smart Connections [2].** SC proves
  zero-setup, no-API-key, local embeddings work and that "score_connection in Bases" (similarity
  as a *column*) is loved. lifeos has pgvector already — surface a `life_related` neighbors-by-vector
  tool and a "related" view per entity.
- **A rules engine for ingestion/categorization — Firefly III [4].** Firefly's regex + split-txn
  auto-categorization is the gold standard. lifeos's LLM router (§6) should have a **deterministic
  rules layer in front of the LLM** (cheaper, auditable, user-correctable) — LLM only for the
  residue.
- **Consumption/expiry + restock prediction as a domain primitive — Grocy [3].** Grocy's
  consumable model (expiry, stock-down, shopping-list generation) is exactly the household CLAUDE.md
  logic; formalize it as a reusable `consumable` pattern over `entities` rather than bespoke code.
- **Capture-fast + voice/agentic capture — Mem 2.0 [9] / Readwise Reader [5].** Mem's "capture
  first, organize later, AI acts on it" and Readwise's frictionless highlight→export pipeline are
  the model for the Ray-Ban/email plugin endpoints: never block capture on classification.
- **Export-everywhere as trust signal — Readwise [5] / HomeBox (JSON/CSV) [3].** Make full
  DB→JSON/Markdown export a first-class, documented promise. It's how you earn the "you own your
  data" claim *and* it's your migration moat in case you ever pivot.
- **Object-typed local-first ownership story — Anytype [1][8].** Borrow the *narrative* ("Notion's
  flexibility, your device's privacy"), not the CRDT stack.

---

## 4. Anti-patterns to avoid

Traps these products fell into:

- **Bloat / "ERP for your home" scope creep — Grocy [3].** Grocy bolts on chores, batteries, meal
  plans, equipment. Each is a half-app. lifeos's `type`-extensibility makes this *temptingly easy*;
  resist shipping shallow features in every domain. Win on the *join*, not the count of domains.
- **Cloud lock-in + no export = death — Omnivore/Pocket [5].** Two read-later apps with users'
  libraries just vanished (Omnivore acq+shutdown Nov 2024; Pocket dead July 2025) [5]. Self-hosted
  + export is lifeos's structural immunity — don't ever compromise it for a hosted convenience.
- **AI gimmickry / server-side LLM coupling — generic "AI PKM" [9].** Many AI PKMs are a chat box
  bolted on a notes DB. lifeos's "no server-side LLM, return cited context, client answers"
  discipline is *correct* — keep retrieval deterministic and auditable; don't let the LLM become a
  load-bearing, un-cited oracle.
- **Sync hell / CRDT premature complexity — local-first stack [7][8].** CRDTs (Automerge 3.0,
  Yjs, Loro) are real but heavy [7]. lifeos is single-Postgres, single-family — **do not adopt
  CRDTs for multi-device merge until there's a concrete multi-writer requirement.** Postgres-as-
  source-of-truth + Obsidian-mirror is a deliberate, simpler choice; defend it.
- **Backlink soup mistaken for a knowledge graph — Logseq/Obsidian [1].** Undirected link clouds
  look impressive and retrieve poorly. lifeos's typed/weighted edges are the antidote — *keep
  predicates meaningful*; don't auto-materialize low-signal `related_to` edges so densely that the
  graph degrades into noise.
- **Encryption that silently kills search.** Your SPEC §7.3 already names this. The plaintext-vs-
  `data.enc` split is right; the anti-pattern is encrypting a field someone later needs to
  aggregate. Make "is this field searchable?" an explicit per-field decision, enforced.

---

## 5. Positioning statement

> **lifeos is the unified, self-hosted memory layer for one household's entire life — the place
> where your stuff, your money, your kids' logs, your reading, and the web you've saved all live in
> *one* Postgres store and can be asked about *together*.** It is for the technical, privacy-minded
> person who is tired of stitching together Grocy + Firefly + Readwise + Obsidian and still not
> being able to ask one question that crosses them. lifeos wins not by out-featuring any single
> app inside its lane — Firefly budgets better, Grocy tracks pantries better — but by being the
> only system where every domain is the same kind of typed, related, searchable object, exposed to
> your own LLM over MCP as **cited, graph-expanded context you fully own**. Breadth + relations +
> ownership, not depth-in-one-silo, is the bet.

---

## 6. Implications for the plugin / ingestion system

What the competitive picture says lifeos's plugin endpoints (Ray-Ban glasses, email-to-inbox,
webhooks, bots) **should** and **should NOT** try to be. **(assessment, grounded in §3/§4)**

**Should be:**
- **A thin "capture → inbox → classify" pipe, never a blocking classifier.** Mem 2.0 and Readwise
  prove capture must be instantaneous [5][9]. Every plugin endpoint writes an `entity` (type
  `inbox_capture` or similar) *immediately*; classification/routing is async and reversible.
- **Deterministic rules first, LLM router second — Firefly's pattern [4].** A photo from
  Ray-Ban with a barcode → rules resolve to `item` with zero LLM cost. Email from your bank →
  rule routes to finance. The LLM only classifies the ambiguous residue, and its decision is stored
  as a *correctable* `relations`/field, not a hidden side effect.
- **Schema-driven, leaning on `entity_types` (Tana supertags [1]).** The router's job is "pick the
  type, fill the schema, draw the obvious relations" — the type registry *is* the routing target
  set. New domain = new type = router automatically can target it. No router code change.
- **Citation/provenance preserving.** Every capture keeps `source` + `source_ref` (which glasses,
  which email, which webhook) so retrieval can cite it. This is the same discipline as the MCP
  cited-context design — extend it to the edges.
- **Local-first and offline-tolerant at the edge.** Captures queue when the household server is
  unreachable and reconcile later — but with a **simple queue, not CRDTs** (§4).

**Should NOT be:**
- **NOT a general "AI does everything" agent.** Don't let the ingestion LLM mutate finance balances,
  delete entities, or take actions — it *classifies and proposes*, humans/rules confirm. Avoids the
  un-auditable-oracle anti-pattern (§4).
- **NOT a per-device proprietary integration zoo.** Don't build a bespoke Ray-Ban app, a bespoke
  email app, a bespoke bot — build **one normalized capture contract** (an HTTP endpoint taking
  `{blob|text, source, hints}`) and make every edge a thin adapter to it. Avoids Grocy-style bloat
  (§4).
- **NOT a cloud round-trip.** No sending captures to a vendor cloud for processing; routing runs
  against the household's own LLM/MCP. The whole value prop is ownership (§2.5, §5).
- **NOT a sync-everything CRDT mesh.** The edges *push* into one store; they are not peers in a
  replicated graph. Keep the topology a star (edges → Postgres), not a mesh.

---

## Sources

1. The Software Scout / AI:PRODUCTIVITY / Storyflow — Notion vs Logseq / Anytype / Tana data-model & local-first comparisons (2026): https://thesoftwarescout.com/notion-vs-logseq-2026-which-note-taking-app-fits-your-brain/ , https://aiproductivity.ai/vs/anytype-vs-logseq/ , https://storyflow.so/blog/best-tana-alternatives-2026
2. Smart Connections (Obsidian) — local embeddings, Bases integration, adoption: https://github.com/brianpetro/obsidian-smart-connections , https://smartconnections.app/smart-connections/
3. Grocy / HomeBox / Sortly — self-hosted home inventory data models & scope: https://grocy.info/ , https://github.com/grocy/grocy , https://store.elfhosted.com/product/homebox/ , https://www.spullio.com/alternatives
4. Firefly III vs Actual Budget (and Monarch/Lunch Money) — finance data models: https://talos.tools/compare/firefly-iii-vs-actual-budget , https://ezbookkeeping.mayswind.net/comparison/
5. Read-it-later shakeout (Omnivore/Pocket shutdowns; Readwise/Matter/Raindrop): https://danielprindii.com/blog/read-it-later-alternatives-after-omnivore-shutting-down , https://www.readless.app/blog/best-read-later-apps-comparison
6. MCP + PKM, Notion official MCP / data sources, agentic hybrid retrieval: https://chatforest.com/guides/mcp-personal-knowledge-management-pkm/ , https://desktopcommander.app/blog/best-mcp-servers-for-knowledge-bases-in-2026/ , https://blakecrosley.com/guides/obsidian
7. Local-first / CRDTs (Ink&Switch, Automerge 3.0, Yjs, Loro): https://www.inkandswitch.com/essay/local-first/ , https://rxdb.info/articles/local-first-future.html
8. Anytype any-sync / Solid personal data store / local-first ownership: https://github.com/alexanderop/awesome-local-first , https://fosdem.org/2025/schedule/event/fosdem-2025-5107-solid-local-first-and-the-ultimate-bookkeeping-system/
9. Second-brain / AI PKM lanes; Mem 2.0; Capacities/Reflect/Heptabase: https://storyflow.so/blog/best-ai-second-brain-apps-2026 , https://www.kosmik.app/blog/best-second-brain-apps , https://skywork.ai/skypage/en/unlocking-second-brain-heptabase-server/1978301825238880256
