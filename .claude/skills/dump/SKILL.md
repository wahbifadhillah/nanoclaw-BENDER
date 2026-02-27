# Dump Skill

Use this skill whenever the user sends a message starting with `/dump`.

## Purpose
Quickly dump todo tasks into tagged markdown files in the Obsidian vault.
Tasks are appended with timestamps, never overwritten.

## Triggers
- `/dump` — Claude Code CLI (this tool)
- `+dump` — Telegram interface (handled by the container agent via `dump_tasks` MCP tool)

## Execution Paths

### Host CLI (Claude Code) — Secure Pattern
`host.ts` implements secure secrets handling:

1. **Whitelist secrets** — only load `NOTES_URL`, `SHLINK_URL`, `SHLINK_API_KEY`, `SHLINK`
2. **Pass via stdin** — secrets never in `process.env` or command-line args
3. **Minimal env** — subprocess gets only `NODE_ENV` and `TZ`
4. **No leaks** — secrets removed from memory after subprocess ends

```ts
// host.ts
const secrets = readDumpSecrets(); // whitelist
const input = JSON.stringify({ params, secrets });
proc.stdin.write(input); // via stdin, not env
```

Invoke `runDump()` directly from `host.ts`:

```ts
import { runDump } from './host.ts';

const result = await runDump({ tags, tasks });
```

### Container Agent
Call the `dump_tasks` MCP tool (defined in `agent.ts`). It sends an IPC message to `host.ts` watcher, which spawns `dump.ts` with the same secure stdin pattern.

## Tools Available
- `dump_tasks` — MCP tool for container agents (IPC path)
- `runDump()` — direct export from `host.ts` for host CLI path

## Input Format
```
+dump #tag

- todo item
- [ ] already formatted task
```

(or `/dump` from Claude Code CLI)

## Supported Formats
- `- todo item` → auto-converted to `- [ ] todo item`
- `- [ ] todo item` → kept as-is
- Multiple tags: `+dump #work #personal`

## Validation Rules
- Tags: only letters, numbers, hyphens, underscores allowed
- At least one `- ` or `- [ ]` item required

## Response Format

**Single dump -- single entry:**
✅ Saved 1 entry to:
```
├── dumps/
	└── personal
```
https://s.xxx.com/abc123

**Single dump -- multiple entries:**
✅ Saved 2 entries to:
```
├── dumps/
	└── personal
```
https://s.xxx.com/abc123

**Multiple dumps -- single entry:**
✅ Saved 2 dumps to:
```
├── dumps/
	├── work --1 entry
	└── personal --1 entry
```

**Multiple dumps -- multiple entries:**
✅ Saved 2 dumps to:
```
├── dumps/
	├── work --2 entries
	└── personal --2 entries
```

## Notes
- Files live at `/opt/vault/dumps/{tag}.md`
- Vault syncs via Syncthing — user can check off tasks in Obsidian
- For single tag, always generate a short URL via Shlink
- **Security:** Secrets passed via stdin (never in `process.env`), whitelisted to only what dump.ts needs
- `tsconfig.json` + `package.json` in this directory enable ts-node to run `dump.ts` with proper module resolution
- Secrets are loaded from `.env` but never logged, exposed via command-line, or leaked to child processes
