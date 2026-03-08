# dtx

[![Build And Release](https://github.com/TomBener/dt-agent-cli/actions/workflows/release.yml/badge.svg)](https://github.com/TomBener/dt-agent-cli/actions/workflows/release.yml)

An agent-friendly CLI for read-only DEVONthink access with optional semantic indexing and citation-key mapping.

## Key Features

- Read-only DEVONthink operations (search/read/browse)
- Document search, passage search, and related-document lookup
- Citation key mapping via bibliography JSON (`file -> id`)
- Default JSON output for easy AI-agent integration
- Configurable index directory per command (`--index-dir`)

## Requirements

- macOS with DEVONthink 4.2+
- Node.js 20+
- Gemini or OpenAI key for embedding/index commands
- `databases/groups/documents` commands do not require embedding API keys

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
dtx search passages --query "<q>" [--limit <n>] [--index-dir <path>]

dtx documents get --uuid <recordUuid> [--max-length <n>]
dtx documents related --uuid <recordUuid> [--limit <n>]

dtx index build [--database <name>] [--group <uuid>] [--include-md] [--force] [--bib <path>] [--index-dir <path>] [--content-max-length <n>]
dtx index status [--index-dir <path>]
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

## Example: Group-Scoped Index with Citation Keys

```bash
dtx index build \
  --database Inbox \
  --bib ~/Library/CloudStorage/Dropbox/bibliography/bibliography.json \
  --index-dir ~/Library/CloudStorage/Dropbox/bibliography/dtx-index
```

Defaults for `dtx index build`:

- Group UUID: `33203673-B7E2-4F3F-9D87-6E83EB4781EA`
- Markdown files are excluded unless `--include-md` is provided
- `--content-max-length` defaults to no truncation (`0` also means no truncation)
- Semantic chunking defaults to `800` chars with `120` chars of overlap

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
