<p align="right">
  <strong>English</strong> | <a href="./README.zh-cn.md">简体中文</a>
</p>

# LucidWrite

**A browser-based AI writing studio with cloud sync, user accounts, and a structured multi-stage content workflow.**

LucidWrite is a locally-run web writing tool that guides you through every stage of content creation — from topic research to a polished final draft — using AI agents at each step. User accounts and all writing data (projects, drafts, style fingerprints) are stored in Supabase with row-level security, so each user only ever sees their own content.

## Features

- **Structured writing workflow** — seven sequential stages: Topic, Outline, Draft, Refine, Fact-check, Score, Final.
- **Real-time AI collaboration** — right-side chat modifies the left-side draft live; the AI returns the complete updated article each time.
- **User accounts** — email-based sign-up and login powered by Supabase Auth; email confirmation required.
- **Cloud storage with RLS** — projects, drafts, finals, and style fingerprints stored in Supabase with row-level security policies; no user can access another user's data.
- **Style fingerprint** — import past articles so the AI learns and maintains your writing voice.
- **Local workspace** — browse and attach local Markdown files or directories via the file tree or `@` mentions.
- **LLM agnostic** — works with DeepSeek, OpenAI, or any OpenAI-compatible endpoint via environment variables.

## Requirements

| Tool | Version | Install |
|------|---------|---------|
| [Bun](https://bun.sh/) | ≥ 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| Supabase project | — | [supabase.com](https://supabase.com) |
| LLM API key | — | DeepSeek / OpenAI / compatible |

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/Shiny-Qiu/LucidWrite.git
cd LucidWrite
bun install
```

### 2. Set up Supabase

Create a project at [supabase.com](https://supabase.com), then run the schema in **SQL Editor**:

```bash
# Copy the full SQL from supabase/schema.sql and execute it in Supabase SQL Editor
```

The schema creates five tables (`profiles`, `projects`, `drafts`, `finals`, `style_fingerprints`), enables RLS on all of them, and installs a trigger that auto-creates a profile on every new signup.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Supabase (required)
SUPABASE_URL=https://<project_ref>.supabase.co
SUPABASE_ANON_KEY=sb_publishable_xxxxxxxxxxxx
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxxxxxx

# LLM — DeepSeek example (or any OpenAI-compatible provider)
EDITAI_LLM_API_KEY=sk-xxxxxxxxxxxx
EDITAI_LLM_BASE_URL=https://api.deepseek.com
EDITAI_LLM_MODEL=deepseek-chat
EDITAI_LLM_MAX_RETRIES=3
EDITAI_LLM_TIMEOUT_MS=60000
```

### 4. Start

```bash
bun run web
```

Open **http://localhost:3899**, register an account, and start writing.

## Writing Workflow

| Stage | What happens |
|-------|-------------|
| Topic | Interview-style conversation to lock in the article angle |
| Outline | Generate and refine a structured outline |
| Draft | Produce a complete first draft from the approved outline |
| Refine | AI content analysis with inline editing on request |
| Fact-check | Claim-by-claim verification; corrections applied on request |
| Score | Full quality score (structure, evidence, style, clarity) |
| Final | Last edits; save `final.md` |

At every stage, anything you type in the right-side chat can modify the article on the left. The AI always returns the **complete updated article** — never just a partial snippet.

## Authentication Flow

```
Register → Supabase sends confirmation email
         → User clicks link → redirected back to localhost:3899
         → Token parsed automatically → logged in

Login    → POST /api/auth/login → server calls Supabase Auth REST API
         → JWT returned → stored in localStorage
         → All subsequent API calls carry Authorization: Bearer <JWT>
         → Server validates JWT → RLS enforces per-user data isolation
```

## Project Structure

```
src/web/
  server.ts        # Hono server: auth endpoints + Supabase-backed API routes
  supabase.ts      # Server-side Supabase client factory
  deepseek.ts      # LLM client (DeepSeek / OpenAI-compatible)
  task-runner.ts   # AI task execution engine
  task-prompts.ts  # Per-mode prompt templates
  public/
    index.html     # App shell + auth gate UI
    app.js         # Frontend state, auth, API calls
    styles.css     # UI styles
supabase/
  schema.sql       # Tables + RLS policies + signup trigger
```

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✓ | Supabase project URL |
| `SUPABASE_ANON_KEY` | ✓ | Public anon key (safe for client config endpoint) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | Service role key (server-side only, bypasses RLS) |
| `EDITAI_LLM_API_KEY` | ✓ | LLM API key |
| `EDITAI_LLM_BASE_URL` | ✓ | LLM base URL (OpenAI-compatible) |
| `EDITAI_LLM_MODEL` | ✓ | Model name |
| `EDITAI_LLM_MAX_RETRIES` | — | Retry attempts on failure (default: 3) |
| `EDITAI_LLM_TIMEOUT_MS` | — | Request timeout in ms (default: 60000) |

## Development Commands

```bash
bun run web        # start the local web server
bun run build      # build CLI / plugin / web server + static assets
bun run typecheck  # TypeScript type check
bun test           # run tests
bun run clean      # remove dist/
```

## Security Notes

- `.env` and `.mcp.json` are git-ignored and must never be committed.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — keep it server-side only.
- All database tables enforce RLS: `auth.uid() = user_id` on every operation.
- Supabase Auth requires email confirmation before a user can log in.

## Repository

GitHub: <https://github.com/Shiny-Qiu/LucidWrite>
