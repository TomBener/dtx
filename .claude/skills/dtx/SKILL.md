---
name: dtx
description: >
  Use dtx to search, browse, and read documents in DEVONthink from the command line.
  Invoke this skill whenever the user wants to find papers, read passages, explore
  their DEVONthink library, retrieve document content, or look up citation keys —
  even if they don't say "dtx" explicitly. Also use this skill when the user wants
  to build or manage the local search index for their DEVONthink database, or when
  they need help choosing between keyword search, semantic search, or native
  DEVONthink operators like NEAR/AND/NOT.
---

# dtx — DEVONthink CLI for AI Agents

`dtx` is a read-only CLI for DEVONthink. All output is JSON on stdout; progress logs go to stderr. It is designed for AI agents: structured, predictable, composable.

## Two Retrieval Modes

There are two fundamentally different retrieval modes. Choose based on what the user needs:

| | `keyword` | `semantic` |
|---|---|---|
| Backend | DEVONthink native engine | Local vector index |
| Granularity | Document-level | Passage-level |
| Operators | NEAR, AND, OR, NOT, wildcards, `name:`, `tag:` | Not supported |
| Requires index | No | Yes (`dtx index build`) |

**Use `keyword` when:**
- The query uses DEVONthink operators (NEAR, AND, NOT, wildcards, field qualifiers)
- You need a quick coarse filter without a local index
- You want document-level results only

**Use `semantic` when:**
- You need passage-level excerpts with surrounding context
- You have a local index available (`dtx index status` to check)
- You want semantic ranking over indexed chunks

## Commands

### Browse & Explore
```bash
dtx version
dtx doctor [--index-dir <path>]
dtx databases list
dtx groups list [--uuid <groupUuid>] [--limit <n>]
```

### Search
```bash
# DEVONthink native retrieval — document-level, operators supported
dtx keyword --query "<q>" [--database <name>] [--group <uuid>] [--limit <n>] [--with-abstract]  # default limit: 10

# Local index retrieval — passage-level
# default limit: 10; default per-doc: 2
dtx semantic [--query "<q>"] \
  [--database <name>] \
  [--group <uuid>] \
  [--limit <n>] \
  [--per-doc <n>]          # default: 2 passages per doc
  [--context]              # include full contextText alongside excerpt
  [--debug]                # include internal scoring fields
  [--index-dir <path>]
  [--citation-key <key>]   # fetch all passages for a known paper; --query optional
  [--uuid <recordUuid>]    # fetch passages for a known document; --query optional
```

### Documents
```bash
dtx documents get (--uuid <recordUuid> | --citation-key <key>) [--max-length <n>]
dtx documents related --uuid <recordUuid> [--limit <n>]
```

### Index Management
```bash
dtx index build \
  [--database <name>]          # disables default group unless --group is also passed
  [--group <uuid>]             # limit to a group subtree
  [--bib <path>]               # bibliography JSON for citation key mapping
  [--index-dir <path>]
  [--include-md]               # include markdown files (excluded by default)
  [--force]                    # full rebuild, ignore modification dates
  [--content-max-length <n>]   # truncate documents before chunking (0 = no limit)

dtx index status [--index-dir <path>]
```

## Key Behaviors

**Default scope** — `keyword`, `semantic`, and `index build` default to group `33203673-B7E2-4F3F-9D87-6E83EB4781EA` unless overridden. Pass `--group <uuid>` to use another group. Pass `--database <name>` to search/build by database instead; if you provide both `--database` and `--group`, both constraints apply.

**`--limit 10`** (default) — Caps the number of returned results for both `dtx keyword` and `dtx semantic`.

**`--citation-key <key>`** — With no query, `dtx semantic` retrieves all indexed chunks for a document identified by its citation key (e.g. `shucksmith2018rrr`), merges adjacent chunks into consecutive passages, and returns them in chunk order. With `--query`, retrieval is restricted to that document.

**`--uuid <recordUuid>`** — Equivalent document-scoped semantic access using a DEVONthink UUID instead of a citation key. When combined with `--query`, retrieval is restricted to that document.

**`--per-doc 2`** (default) — Limits results to 2 passages per document, ensuring diversity across sources. Use `--per-doc 0` to remove the cap.

**`--context`** — Adds `contextText` (full chunk text) alongside the short `excerpt`. Useful when the excerpt alone is insufficient to understand the passage.

**`dtx semantic`** — Embeds the query and performs cosine similarity search over the local vector index, then re-ranks with lexical signals. Requires an embedding API key (`GOOGLE_API_KEY` for Gemini, `OPENAI_API_KEY` for OpenAI).

**`dtx doctor`** — Reports the current runtime environment for the CLI, including version info, semantic-search readiness from `process.env`, whether a `.env` exists in the current working directory, and index availability. This is useful because `dtx` does not auto-load `.env`.

**`documents related`** — Calls DEVONthink's See Also / `compare()` API. Returns documents similar to a known UUID without a text query.

## Output Contract

```json
// Success
{ "ok": true, "data": { ... }, "meta": { "elapsedMs": 123 } }

// Error
{ "ok": false, "error": { "code": "...", "message": "..." }, "meta": {} }
```

Progress logs (indexing, etc.) are written to stderr, not stdout.

## Index Configuration

Priority order for index directory:
1. `--index-dir <path>`
2. `DT_INDEX_DIR` environment variable
3. `~/Library/CloudStorage/Dropbox/bibliography/dtx-index` (default)

Index files: `vectors.bin`, `chunks.json`, `chunks.001.json` …, `meta.json`

## Environment Variables

| Variable | Purpose |
|---|---|
| `EMBEDDING_PROVIDER` | `gemini` (default) or `openai` |
| `EMBEDDING_MODEL` | Override embedding model |
| `GOOGLE_API_KEY` | Required for Gemini embeddings |
| `OPENAI_API_KEY` | Required for OpenAI embeddings |
| `DT_INDEX_DIR` | Default index directory |
| `DT_DEFAULT_GROUP_UUID` | Default group scope for search/index commands |
| `BIBLIOGRAPHY_JSON_PATH` | Default bibliography path |

## Typical Workflows

**Find relevant passages on a topic (with index):**
```bash
dtx semantic --query "rural gentrification China" --limit 10 --context
```

**Use DEVONthink operators for precise filtering:**
```bash
dtx keyword --query "rural idyll NEAR gentrification" --limit 10
```

**Read a specific paper by citation key:**
```bash
dtx semantic --citation-key "shucksmith2018rrr" --limit 20
```

**Semantic search when keyword matching misses conceptual matches:**
```bash
dtx semantic --query "pastoral nostalgia urban escape" --limit 8
```

**Get full document text:**
```bash
dtx documents get --uuid "76A0C214-4EC5-4A95-8E12-0E3EA0B82414" --max-length 5000
```

**Check if index is available before using passage search:**
```bash
dtx index status
```
