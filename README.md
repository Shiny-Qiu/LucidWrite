# editAI

**Local AI writing workspace for research, drafting, editing, fact-checking, and content pipelines.**

editAI is a local-first web writing tool inspired by the multi-agent content workflow of newtype OS. It is not the newtype OS CLI product. newtype OS is a CLI/TUI system built on top of OpenCode; editAI focuses on a browser-based personal writing workspace that runs locally, lets you configure model keys, browse local Markdown files, attach project context, and work with AI through a clean chat interface.

## What editAI Does

- Provides a one-screen web writing workspace for personal local use.
- Visualizes content modes such as research, writing, editing, fact-checking, analysis, extraction, archive, and full pipeline.
- Supports multi-turn chat so follow-up prompts can use prior conversation context.
- Lets you attach Markdown files or entire local directories through the file tree or `@` mentions in the composer.
- Renders assistant Markdown in the chat, including headings, lists, tables, blockquotes, and code blocks.
- Supports a pipeline approval flow where the user can review and edit the outline before drafting continues.
- Stores local settings under `.newtype/web-settings.json` for compatibility with the existing runtime structure.

## Project Status

This project is currently designed for local personal use. It is being shaped toward a future web product, but the first version intentionally keeps data and workspace files on the local machine.

## Requirements

- [Bun](https://bun.sh/)
- A DeepSeek API key, or another supported provider configured through the local settings flow
- A local Markdown workspace directory

## Quick Start

```bash
bun install
cp .env.example .env
bun run web
```

Open:

```text
http://localhost:3899
```

If the default port is occupied:

```bash
PORT=3900 bun run web
```

## Environment Configuration

For local use, configure model access in `.env`:

```bash
EDITAI_LLM_API_KEY=
EDITAI_LLM_BASE_URL=https://api.deepseek.com
EDITAI_LLM_MODEL=deepseek-chat
EDITAI_LLM_MAX_RETRIES=3
EDITAI_LLM_TIMEOUT_MS=60000

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=60000
```

Do not commit real API keys. `.env` is ignored by Git.

`DEEPSEEK_*` remains supported. `EDITAI_LLM_*` is preferred for temporary switching to another OpenAI-compatible provider when a model service is busy.

## Web Workspace

The UI is organized into three focused areas:

- Left: local workspace file tree and directory switching.
- Center: mode tabs, agent status, conversation, and the single input composer.
- Right: distilled agent guidance and reference direction.

In the composer, type `@` to search the current workspace for Markdown files or directories. Selecting a file attaches that file; selecting a directory attaches aggregated Markdown content from that directory.

## Available Modes

| Mode | Purpose |
| --- | --- |
| Chief | Free conversation and mode selection |
| Research | Gather background, source notes, and content angles |
| Write | Generate Markdown drafts |
| Edit | Improve structure, flow, clarity, and wording |
| Fact-check | Verify claims and flag weak sources |
| Analyze | Apply structured analysis frameworks |
| Extract | Clean and structure supplied content |
| Archive | Organize or retrieve local knowledge |
| Pipeline | Outline approval, then full content production |

## Development Commands

```bash
bun run web        # start the local web app
bun run build      # bundle CLI/plugin/web server and static assets
bun run typecheck  # run TypeScript checks
bun test           # run Bun tests
bun run clean      # remove dist/
```

## Relationship to newtype OS

editAI references newtype OS as an architectural inspiration for multi-agent content production. It does not share the same product positioning, installation path, or primary interaction model. Users should install and run editAI as this local web workspace, not as `@newtype-os/cli` or an OpenCode plugin.

## Repository

GitHub: <https://github.com/pengcong2020520/edit-ai>
