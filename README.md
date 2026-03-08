# dtx

[![Build And Release](https://github.com/TomBener/dt-agent-cli/actions/workflows/release.yml/badge.svg)](https://github.com/TomBener/dt-agent-cli/actions/workflows/release.yml)

An agent-friendly CLI for read-only DEVONthink access with optional semantic indexing and citation-key mapping.

## Key Features

- Read-only DEVONthink operations (search/read/browse)
- Document search, keyword passage search, semantic passage search, and related-document lookup
- Citation key mapping via bibliography JSON (`file -> id`)
- Default JSON output for easy AI-agent integration
- Configurable index directory per command (`--index-dir`)

## Requirements

- macOS with DEVONthink 4.2+
- Node.js 20+
- Gemini or OpenAI key for indexing and `search passages --mode semantic`
- `databases/groups/documents` commands and keyword passage search do not require embedding API keys

## Install (Homebrew)

```bash
brew install tombener/tap/dtx
```

Then run:

```bash
dtx help
```

## Quick Start

```bash
npm install
npm run build
npm link
```

## Output Contract

- `stdout`: JSON response
- `stderr`: progress logs (for long-running operations like indexing)

Success shape:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "elapsedMs": 123
  }
}
```

Error shape:

```json
{
  "ok": false,
  "error": {
    "code": "MISSING_ARGUMENT",
    "message": "..."
  },
  "meta": {}
}
```

## Commands

```bash
dtx databases list
dtx groups list [--uuid <groupUuid>] [--limit <n>]
dtx search documents --query "<q>" [--database <name>] [--limit <n>]
dtx search passages --query "<q>" [--database <name>] [--limit <n>] [--per-doc <n>] [--mode <keyword|semantic>] [--context] [--debug] [--index-dir <path>]

dtx documents get --uuid <recordUuid> [--max-length <n>]
dtx documents related --uuid <recordUuid> [--limit <n>]

dtx index build [--database <name>] [--group <uuid>] [--include-md] [--force] [--bib <path>] [--index-dir <path>] [--content-max-length <n>]
dtx index status [--index-dir <path>]
```

## Search Modes

- `dtx search documents`
  Uses DEVONthink native keyword search and returns document-level results. Supports advanced operators such as `NEAR`, `AND`, `OR`, `NOT`, wildcards, and field qualifiers (e.g. `name:`, `tag:`), since the query is passed directly to DEVONthink's search engine.
- `dtx search passages --mode keyword` (default)
  Returns passage-level results using lexical matching. If a local index is available, it scans indexed chunks directly; otherwise it falls back to DEVONthink document search followed by local passage extraction and scoring.
- `dtx search passages --mode semantic`
  Embeds the query and performs cosine similarity search over the local vector index, then re-ranks results with lexical signals.
- `dtx documents related`
  Uses DEVONthink `See Also` / `compare()` and returns related documents for one known UUID.

Only `search passages --mode semantic` requires an embedding API key at query time.

```mermaid
flowchart TD
    Q["Query / UUID"] --> D["search documents"]
    D --> D1["DEVONthink native search\n(supports NEAR / Boolean / wildcards)"]
    D1 --> D2["Document results"]

    Q --> PK["search passages (keyword)"]
    PK --> PK1{"Local index available?"}
    PK1 -->|Yes| PK2["Scan indexed chunks\nwith lexical matching"]
    PK1 -->|No| PK3["DEVONthink document search"]
    PK3 --> PK4["Read & split candidate documents\ninto passage units"]
    PK2 --> PK5["Score & rank passages"]
    PK4 --> PK5
    PK5 --> PP

    Q --> PS["search passages (semantic)"]
    PS --> PS1["Embed query"]
    PS1 --> PS2["Cosine similarity search\nover local vector index"]
    PS2 --> PS3["Re-rank with lexical signals"]
    PS3 --> PP

    PP["Merge adjacent passages\n& build excerpt"] --> PR["Passage results"]

    Q --> R["documents related"]
    R --> R1["DEVONthink compare / See Also"]
    R1 --> R2["Related document results"]
```

## Index Directory Configuration

Priority order:

1. `--index-dir <path>`
2. `DT_INDEX_DIR` (env)
3. `~/Library/CloudStorage/Dropbox/bibliography/dtx-index` (default)

Index files:

- `vectors.bin`
- `chunks.json`
- `meta.json`
- `chunks.001.json`, `chunks.002.json`, ... (auto-generated chunk shards)

## Example: Database-Scoped Index with Citation Keys

```bash
dtx index build \
  --database Inbox \
  --bib ~/Library/CloudStorage/Dropbox/bibliography/bibliography.json \
  --index-dir ~/Library/CloudStorage/Dropbox/bibliography/dtx-index
```

Defaults for `dtx index build`:

- Group UUID: `33203673-B7E2-4F3F-9D87-6E83EB4781EA`
- Database: all databases (omit `--database` to scan all)
- Bibliography path: `~/Library/CloudStorage/Dropbox/bibliography/bibliography.json` (or `BIBLIOGRAPHY_JSON_PATH` env)
- Markdown files are excluded unless `--include-md` is provided
- `--content-max-length` defaults to no truncation (`0` also means no truncation)
- Semantic chunking defaults to `800` chars with `120` chars of overlap
- Chunk metadata shard size defaults to `10000`

`dtx search passages` defaults to `--mode keyword`:

- If an index is available, it scans indexed chunks directly with lexical matching
- If no index is available, it falls back to DEVONthink document search and then extracts passages locally
- By default, results return only `excerpt`; pass `--context` to also include `contextText`
- By default, there is no per-document cap; use `--per-doc <n>` to limit how many passages one document can contribute
- Pass `--debug` to include internal ranking and passage-location fields
- Results are post-processed into short excerpts, with adjacent hits merged
- Use `--mode semantic` to query the local vector index instead

## Configuration (Environment Variables)

Set env vars in your shell/profile (or pass inline per command). Important ones:

- `EMBEDDING_PROVIDER`
- `EMBEDDING_MODEL`
- `GOOGLE_API_KEY` (when `EMBEDDING_PROVIDER=gemini`)
- `OPENAI_API_KEY` (when `EMBEDDING_PROVIDER=openai`)
- `BIBLIOGRAPHY_JSON_PATH`
- `DT_INDEX_DIR`
- `LIST_ALL_RECORDS_TIMEOUT_MS`
- `INDEX_CRAWL_HEARTBEAT_MS`
- `CHUNK_MAX_CHARS`
- `CHUNK_OVERLAP_CHARS`
- `CHUNK_MIN_CHARS`
- `CHUNK_SHARD_SIZE`

`dtx` does not read `.env` files automatically.

Example:

```bash
export EMBEDDING_PROVIDER=gemini
export GOOGLE_API_KEY=your_key
export BIBLIOGRAPHY_JSON_PATH="$HOME/Library/CloudStorage/Dropbox/bibliography/bibliography.json"
export DT_INDEX_DIR="$HOME/Library/CloudStorage/Dropbox/bibliography/dtx-index"
```

## Safety

All DEVONthink operations are read-only.

# License

MIT License. See [LICENSE](LICENSE) for details.
