# DEVONthink Agent CLI

[![Build And Release](https://github.com/TomBener/dt-agent-cli/actions/workflows/release.yml/badge.svg)](https://github.com/TomBener/dt-agent-cli/actions/workflows/release.yml)

Non-interactive, agent-friendly CLI for read-only DEVONthink access with optional semantic indexing and citation-key mapping.

## Key Features

- Read-only DEVONthink operations (search/read/browse)
- Semantic index build + semantic/hybrid search
- Citation key mapping via bibliography JSON (`file -> id`)
- Default JSON output for easy AI-agent integration
- Configurable index directory per command (`--index-dir`)

## Requirements

- macOS with DEVONthink 4.2+
- Node.js 20+
- Gemini or OpenAI key for embedding/index commands
- `databases/groups/records` commands do not require embedding API keys

## Install (Homebrew)

```bash
brew install tombener/tap/dt-agent-cli
```

Then run:

```bash
dt help
```

## Quick Start

```bash
npm install
npm run build
npm link
```

After linking, use:

```bash
dt help
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
dt databases list
dt groups list [--uuid <groupUuid>] [--limit <n>]
dt records search --query "<q>" [--database <name>] [--limit <n>]
dt records get --uuid <recordUuid> [--max-length <n>]

dt index build [--database <name>] [--group <uuid>] [--include-md] [--force] [--bib <path>] [--index-dir <path>]
dt index status [--index-dir <path>]

dt search semantic --query "<q>" [--top-k <n>] [--index-dir <path>]
dt search hybrid --query "<q>" [--database <name>] [--top-k <n>] [--index-dir <path>]
```

## Index Directory Configuration

Priority order:

1. `--index-dir <path>`
2. `DT_INDEX_DIR` (env)
3. `~/Library/CloudStorage/Dropbox/bibliography` (default)

Index files:

- `vectors.bin`
- `chunks.json`
- `meta.json`

## Example: Group-Scoped Index with Citation Keys

```bash
dt index build \
  --database Inbox \
  --bib ~/Library/CloudStorage/Dropbox/bibliography/bibliography.json \
  --index-dir ~/Library/CloudStorage/Dropbox/bibliography
```

Defaults for `dt index build`:

- Group UUID: `33203673-B7E2-4F3F-9D87-6E83EB4781EA`
- Markdown files are excluded unless `--include-md` is provided

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

`dt` does not read `.env` files automatically.

Example:

```bash
export EMBEDDING_PROVIDER=gemini
export GOOGLE_API_KEY=your_key
export BIBLIOGRAPHY_JSON_PATH="$HOME/Library/CloudStorage/Dropbox/bibliography/bibliography.json"
export DT_INDEX_DIR="$HOME/Library/CloudStorage/Dropbox/bibliography"
```

## Safety

All DEVONthink operations are read-only.

# License

MIT License. See [LICENSE](LICENSE) for details.
