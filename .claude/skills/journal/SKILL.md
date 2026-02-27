# Journal Skill

Use this skill whenever the user sends a message starting with `/journal`.

## Purpose
Append journal entries to a daily markdown file in the Obsidian vault.
Entries are appended with timestamps, never overwritten.

## Triggers
- `/journal` — Claude Code CLI (this tool)
- `+journal` — Telegram interface (handled by the container agent via `save_journal` MCP tool)

## Execution Paths

### Host CLI (Claude Code) — Secure Pattern
`host.ts` implements secure secrets handling:

1. **Whitelist secrets** — only load `NOTES_URL`, `SHLINK_URL`, `SHLINK_API_KEY`, `SHLINK`
2. **Pass via stdin** — secrets never in `process.env` or command-line args
3. **Minimal env** — subprocess gets only `NODE_ENV` and `TZ`
4. **No leaks** — secrets removed from memory after subprocess ends

```ts
// host.ts
const secrets = readJournalSecrets(); // whitelist
const input = JSON.stringify({ params, secrets });
proc.stdin.write(input); // via stdin, not env
```

Invoke `runJournal()` directly from `host.ts`:

```ts
import { runJournal } from './host.ts';

const result = await runJournal({ content });
```

### Container Agent
Call the `save_journal` MCP tool (defined in `agent.ts`). It sends an IPC message to `host.ts` watcher, which spawns `journal.ts` with the same secure stdin pattern.

## Tools Available
- `save_journal` — MCP tool for container agents (IPC path)
- `runJournal()` — direct export from `host.ts` for host CLI path

## Input Format

```
+journal
Your journal entry text here. Can be multiple paragraphs.
```

(or `/journal` from Claude Code CLI)

## Supported Formats
- Any plain text after the `/journal` trigger line
- Multi-line entries are preserved as-is

## Content Formatting (Agent Responsibility)

Before passing content to `save_journal`, the agent **may restructure the flow** of the entry to improve idea separation and readability. This happens in the agent's reasoning layer — not inside `journal.ts`.

### ✅ Allowed
- Breaking a wall of text into logical paragraphs
- Adding a blank line between distinct thoughts or topic shifts
- Adding a markdown heading (`##`) when the entry clearly shifts to a new subject
- Normalizing inconsistent spacing or line breaks

### ❌ Not Allowed
- Changing, rewording, or paraphrasing any of the user's words
- Adding new sentences, commentary, or summaries
- Removing any part of the content
- Fixing grammar or spelling — preserve the user's voice exactly

### Example

**User input:**
```
+journal
had a great morning workout then got distracted by emails for like 2 hours, need to fix that. also been thinking about the new project structure, maybe split it into 3 phases. phase 1 just the core, phase 2 integrations, phase 3 polish. dinner was good made pasta
```

**Formatted before saving:**
```
had a great morning workout then got distracted by emails for like 2 hours, need to fix that.

also been thinking about the new project structure, maybe split it into 3 phases. phase 1 just the core, phase 2 integrations, phase 3 polish.

dinner was good made pasta
```

> Words are identical — only paragraph breaks were added at natural idea boundaries.

## Validation Rules
- Content must not be empty after stripping the `/journal` trigger

## Response Format

**Success:**
✅ Saved journal entry to:
```
├── journal/
    └── {DD/MM/YYYY}-journal.md
```
https://s.xxx.com/abc123

## Notes
- Files live at `/opt/vault/journal/{DD/MM/YYYY}-journal.md`
- One file per day — entries are appended chronologically
- Vault syncs via Syncthing — user can view entries in Obsidian
- Always generate a short URL via Shlink on success
- **Security:** Secrets passed via stdin (never in `process.env`), whitelisted to only what journal.ts needs
- `tsconfig.json` + `package.json` in this directory enable ts-node to run `journal.ts` with proper module resolution
- Secrets are loaded from `.env` but never logged, exposed via command-line, or leaked to child processes
