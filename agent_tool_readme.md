# Agent Tool Architecture — Journal & Dump

Reference for future debugging. Explains how `+journal` and `+dump` work end-to-end when everything is correctly wired.

---

## Overview

When a user sends `+journal` or `+dump` from Telegram, the message reaches the container agent (Bender). The agent must call a **MCP tool** to save the data to the vault. The MCP tool writes a task over **IPC** (shared filesystem) to the host. The host runs a **subprocess** that does the actual vault write, then writes the result back over IPC. The agent polls for the result and replies to the user.

There are two separate execution paths depending on where the command comes from:

| Trigger | Path | Tool Used |
|---------|------|-----------|
| `+journal` / `+dump` via Telegram | Container → IPC → Host | `mcp__nanoclaw__save_journal` / `mcp__nanoclaw__dump_tasks` |
| `/journal` / `/dump` via Claude Code CLI | Host-only, direct | `Skill('journal')` / `Skill('dump')` → `host.ts` → script |
| `get_vault_url` — build vault URL | Container → IPC → Host | `mcp__nanoclaw__get_vault_url` |
| `get_short_url` — shorten any URL | Container → IPC → Host | `mcp__nanoclaw__get_short_url` |

This document covers the **container/Telegram path** in detail.

---

## Full Data Flow (Container Path)

```
User (Telegram)
    │  "+journal\ntoday I..."
    ▼
NanoClaw host (src/index.ts)
    │  routes message to container
    ▼
Container agent (container/agent-runner/src/index.ts)
    │  runs query() with prompt
    ▼
Agent SDK calls MCP tool
    │  mcp__nanoclaw__save_journal({ raw_input: "..." })
    ▼
ipc-mcp-stdio.ts (MCP server process, inside container)
    │  1. Parse raw_input → extract content
    │  2. Generate taskId = "journal-{timestamp}-{random}"
    │  3. Write task file → /workspace/ipc/tasks/{taskId}.json
    │     { type: "journal", taskId, params: { content } }
    │  4. Poll /workspace/ipc/journal_results/{taskId}.json (every 500ms, 15s max)
    ▼
[IPC bridge — shared volume mount]
    │
    │  Host path:      DATA_DIR/ipc/{groupFolder}/tasks/{taskId}.json
    │  Container path: /workspace/ipc/tasks/{taskId}.json
    │
    ▼
src/ipc.ts — processTaskIpc()
    │  Picks up task file (polls every IPC_POLL_INTERVAL ms)
    │  case 'journal':
    │    1. Validate taskId + params.content
    │    2. Read secrets from .env (whitelist: NOTES_URL, SHLINK_URL, SHLINK_API_KEY, SHLINK)
    │    3. Spawn: npx ts-node .claude/skills/journal/journal.ts
    │    4. Write { params, secrets } to subprocess stdin
    │    5. Read JSON result from subprocess stdout
    │    6. Write result → DATA_DIR/ipc/{groupFolder}/journal_results/{taskId}.json
    ▼
.claude/skills/journal/journal.ts (subprocess)
    │  1. Read { params, secrets } from stdin
    │  2. Append entry to /opt/vault/journal/{DD-MM-YYYY}-journal.md
    │  3. Generate short URL via Shlink API
    │  4. Write JSON result to stdout: { success, message, data }
    ▼
[IPC bridge — result written back]
    │
    │  Host path:      DATA_DIR/ipc/{groupFolder}/journal_results/{taskId}.json
    │  Container path: /workspace/ipc/journal_results/{taskId}.json
    │
    ▼
ipc-mcp-stdio.ts (polling loop finds result file)
    │  Returns result to agent SDK
    ▼
Agent formats reply and sends to user ✅
```

---

## Key Files and Their Roles

### Container Side

| File | Role |
|------|------|
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **MCP server** — registers all tools the agent can call. Must include `save_journal` and `dump_tasks`. This is the only file that defines tools accessible via `mcp__nanoclaw__*`. |
| `container/agent-runner/src/index.ts` | Runs the agent SDK `query()` loop. Spawns `ipc-mcp-stdio.ts` as an MCP server subprocess. Lists allowed tools including `mcp__nanoclaw__*`. |
| `.claude/skills/journal/agent.ts` | **Orphaned** — defines `save_journal` using `@anthropic-ai/claude-agent-sdk`'s `tool()`. Never registered anywhere. Superseded by the `ipc-mcp-stdio.ts` approach. Do not use. |
| `.claude/skills/dump/agent.ts` | **Orphaned** — same situation as above for `dump_tasks`. |

### Host Side

| File | Role |
|------|------|
| `src/ipc.ts` — `processTaskIpc()` | **IPC dispatcher** — polls group task dirs and dispatches by `type`. Has cases for `journal`, `dump`, `vault_url`, `short_url`. |
| `src/ipc.ts` — `startIpcWatcher()` | Starts the polling loop. Called from `src/index.ts` on startup. Scans `DATA_DIR/ipc/{group}/tasks/` for all groups. |
| `.claude/skills/journal/journal.ts` | **Vault writer (file I/O only)** — reads `{ params }` from stdin, appends to vault file, returns `{ success, filePath, vaultPath, filename }`. No URL logic. |
| `.claude/skills/dump/dump.ts` | **Vault writer (file I/O only)** — same pattern for dump tasks. Returns `{ success, results: [{tag, taskCount, filePath, vaultPath}] }`. No URL logic. |
| `.claude/skills/vault/write_vault_file.ts` | **Vault file writer** — reads `{ params: { vault_path, content, mode } }` from stdin (no secrets), writes file, returns `{ success, filePath, vaultPath }`. Path-escape validated, `.md` only, 1 MB limit. |
| `.claude/skills/vault/get_vault_url.ts` | **URL builder** — reads `{ params: { vault_path }, secrets: { NOTES_URL } }` from stdin, returns `{ success, url }`. |
| `.claude/skills/vault/get_short_url.ts` | **URL shortener** — reads `{ params: { url }, secrets: { SHLINK_URL, SHLINK_API_KEY, SHLINK } }` from stdin, returns `{ success, url }`. |
| `.claude/skills/journal/host.ts` | **Partially implemented watcher** — exports `startJournalWatcher()`. Uses wrong paths (container paths). Safe to ignore. |
| `.claude/skills/dump/host.ts` | Same situation as journal `host.ts`. |

---

## IPC Mechanism

The container and host share a directory via Docker volume mount:

```
Host:      DATA_DIR/ipc/{groupFolder}/
Container: /workspace/ipc/
```

Subdirectories:

```
tasks/                    ← Agent writes task requests here; host reads
messages/                 ← Agent writes send_message requests here; host sends to Telegram
input/                    ← Host writes follow-up messages to agent here
journal_results/          ← Host writes journal results here; agent polls
dump_results/             ← Host writes dump results here; agent polls
vault_url_results/        ← Host writes get_vault_url results here; agent polls
short_url_results/        ← Host writes get_short_url results here; agent polls
write_vault_file_results/ ← Host writes write_vault_file results here; agent polls
```

### Task file format (agent → host)

```json
{
  "type": "journal",
  "taskId": "journal-1740000000000-abc12",
  "params": {
    "content": "today I changed the NanoClaw interface..."
  }
}
```

```json
{
  "type": "dump",
  "taskId": "dump-1740000000000-xyz99",
  "params": {
    "tags": ["ai-notes"],
    "tasks": ["- [ ] fix journal skill", "- [ ] fix dump skill"]
  }
}
```

### Result file format (host → agent)

```json
{
  "success": true,
  "message": "✅ Saved journal entry to:\n...\nhttps://s.example.com/abc",
  "data": { "file": "/opt/vault/journal/25-02-2026-journal.md", "url": "https://..." }
}
```

---

## System Prompt Composition (Agent Sessions)

When an agent has a `system.md` (e.g. `agents/daily/system.md`), it is passed as the explicit `systemPrompt` to the SDK's `query()` call — this is "exclusive" meaning the global CLAUDE.md (`/workspace/global/`) is NOT appended to it.

**However:** The Claude Code SDK always auto-discovers CLAUDE.md files from the `cwd` (`/workspace/group/`). So the group's CLAUDE.md (e.g. `groups/main/CLAUDE.md`) is ALWAYS injected into the agent's context, even when an explicit `systemPrompt` is set.

This means instructions in the group CLAUDE.md (like `NEVER use markdown`) always apply alongside the agent's own system prompt. When these conflict with agent behavior (e.g. outputting verbatim tool results that contain code blocks), the agent must have an explicit override in its `system.md`.

---

## MCP Tool Registration

The agent can only call tools registered in `container/agent-runner/src/ipc-mcp-stdio.ts`.

Tools are registered with `server.tool(name, description, schema, handler)`.

The agent calls them as `mcp__nanoclaw__{name}` (prefix added by SDK).

To add a new tool: add it in `ipc-mcp-stdio.ts`, then **rebuild the container image** (`./container/build.sh`). The image bakes the compiled JS — changes to source are not picked up without a rebuild.

### Chain Tooling Pattern

`dump_tasks` and `save_journal` use `ipcCall()` to chain `get_vault_url` → `get_short_url` within their handlers:

```
MCP handler (ipc-mcp-stdio.ts)
  │
  ├─ ipcCall('dump', ...)           → dump_results/   → { results: [{vaultPath}] }
  │    └─ ipcCall('vault_url', ...) → vault_url_results/ → { url: "https://notes..." }
  │         └─ ipcCall('short_url', ...) → short_url_results/ → { url: "https://s..." }
  │
  └─ Builds response message with short URL → returns to agent
```

**When URL is generated:**
- `dump_tasks`: single-tag only (no URL for multi-tag dumps)
- `save_journal`: always
- `write_vault_file`: never auto-chains — agent decides whether to follow up with `get_vault_url` → `get_short_url`

**`ipcCall()` helper:** writes IPC task + polls result dir (30 × 500ms = 15s max). Returns parsed result or `null` on timeout.

**Pitfall:** `--no-cache` alone does NOT invalidate Docker COPY steps. If the buildkit builder volume has stale files, prune it first:
```bash
docker builder prune
./container/build.sh
```

---

## Secrets Security Model

Secrets are never in container environment variables or command-line arguments.

```
.env file (host)
    │  readEnvFile(['NOTES_URL', 'SHLINK_URL', 'SHLINK_API_KEY', 'SHLINK'])
    ▼
processTaskIpc() — builds { params, secrets }
    │  secrets only in memory, never logged
    ▼
subprocess stdin ← JSON.stringify({ params, secrets })
    │
journal.ts / dump.ts
    │  reads from stdin, uses secrets, never passes downstream
    ▼
secrets removed from memory on process exit
```

The subprocess env is minimal: only `NODE_ENV` and optionally `TZ`. No secrets in `process.env`.

**TZ handling:** `TZ` is only included in the subprocess env when it is explicitly set in the host process (`process.env.TZ`). If the host system configures timezone via `/etc/localtime` (not the `TZ` env var), passing `TZ: ''` would force UTC in the subprocess — libc treats an empty `TZ` as UTC, ignoring `/etc/localtime`. The correct pattern is:

```typescript
env: {
  NODE_ENV: process.env.NODE_ENV || 'production',
  ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
}
```

When `TZ` is omitted, libc falls back to `/etc/localtime` for timezone resolution, which reflects the actual system timezone.

---

## Debugging Checklist

When `+journal` or `+dump` fails:

### 1. Check MCP tool exists in the container

```bash
grep -n "save_journal\|dump_tasks" container/agent-runner/src/ipc-mcp-stdio.ts
```

If no output → tools not registered. Add them and rebuild container.

### 2. Check agent error type

- **"Unknown skill: save_journal"** → Agent called `Skill('save_journal')` not the MCP tool. Gemini models can misinterpret the system prompt and use the `Skill` tool by mistake. The system prompt must explicitly say "do NOT use the Skill tool — call `mcp__nanoclaw__save_journal` directly."
- **Agent says "I only have agent-browser"** → Session history is poisoned. The agent recalled a prior failure where `Skill('save_journal')` errored and concluded it can't do journals. **Reset the session** (see step 9 below) so it starts fresh and re-reads the updated system prompt.
- **`EACCES: permission denied, mkdir '/workspace/ipc/journal_results'`** → The `journal_results` / `dump_results` directories don't exist in `data/ipc/{group}/`. The container user (1000) can't create subdirs in the parent because it's root-owned 755. The MCP tool calls `mkdirSync` before writing the task file, so the task is never written and the host never processes it. Fix: create the dirs on the host with 777. Permanently fixed in `container-runner.ts` by adding them to the pre-creation loop — but if the group IPC dir was already created (existing installation), create them manually: `mkdir -p data/ipc/{group}/journal_results data/ipc/{group}/dump_results && chmod 777 data/ipc/{group}/journal_results data/ipc/{group}/dump_results`. **Also reset the session** — the agent will have lied to the user ("I saved it") because it ignores error tool results.
- **`❌ sh: 1: ts-node: not found`** → The host subprocess runner used `npx ts-node` but `ts-node` is not installed. Only `tsx` is in `node_modules/.bin/`. Fix: use absolute path `path.join(process.cwd(), 'node_modules', '.bin', 'tsx')` as the spawn executable instead of `npx ts-node`. The subprocess env has no PATH (only `NODE_ENV`/`TZ`), so `npx` cannot resolve local binaries — absolute path is required.
- **"Unknown tool: mcp__nanoclaw__save_journal"** → MCP server registered the tool but the agent runner's `allowedTools` doesn't include `mcp__nanoclaw__*`.
- **Task timeout (15s)** → MCP tool exists but host handler is missing or not writing result file. Check `src/ipc.ts` for `case 'journal':`.
- **Script error** → Host handler ran but `journal.ts` / `dump.ts` failed. Check secrets, vault paths.
- **Tool succeeds but agent replies with only its personality text (no structured result)** → The system prompt instruction `"reply with the result"` is too vague. Personality agents (e.g. Bender) interpret it as *"confirm in my own words"* and drop the actual tool result text. Fix: rewrite the reply instruction in the agent's `system.md` to be two explicit steps — (1) optional personality line, (2) required: output the exact verbatim tool result text. Use placeholder-style format (square brackets) in examples — NOT copyable phrases. See `agents/daily/system.md` Interface Commands section for the pattern. **Also reset the session** if the agent has already learned the wrong behavior from prior turns.
- **Tool result text is stripped/reformatted — URL missing, code blocks removed** → The group CLAUDE.md (e.g. `groups/main/CLAUDE.md`) contains `NEVER use markdown`. The Claude Code SDK auto-discovers CLAUDE.md from `cwd: /workspace/group` regardless of the explicit `systemPrompt` set in `query()`. So even when `agentSystemPrompt` is set exclusively, the group CLAUDE.md still leaks into context. The model applies `no markdown` to the tool result and strips bare URLs and code blocks. Fix: add an explicit formatting override to the agent's `system.md`: *"The 'no markdown' rule does NOT apply to tool result text from `mcp__nanoclaw__*` — output verbatim, preserve backticks and URLs."*
- **Personality response is static (same phrase every time)** → The agent's `system.md` Interface Commands section contained a specific copyable example phrase (e.g. `"Fine, I dumped your tasks..."`). The model repeats it verbatim as a template instead of generating fresh Bender responses. Fix: replace specific example phrases with placeholder-format strings like `[your own fresh Bender reaction — one line, contextual to what was saved]`. Square brackets signal "fill this in" rather than "copy this".

### 3. Check host IPC handler exists

```bash
grep -n "case 'journal'\|case 'dump'" src/ipc.ts
```

If no output → add the cases in `processTaskIpc()`.

### 4. Check IPC directories exist and are writable

```bash
ls -la /opt/nanoclaw/data/ipc/{groupFolder}/
# Should show: tasks/ messages/ input/ journal_results/ dump_results/
# All must be drwxrwxrwx (777) — container runs as user 1000, parent dir is root 755
```

If `journal_results/` or `dump_results/` are missing:

```bash
mkdir -p /opt/nanoclaw/data/ipc/{groupFolder}/journal_results \
         /opt/nanoclaw/data/ipc/{groupFolder}/dump_results
chmod 777 /opt/nanoclaw/data/ipc/{groupFolder}/journal_results \
          /opt/nanoclaw/data/ipc/{groupFolder}/dump_results
```

These are pre-created by `container-runner.ts` on each container start (since Session 4 fix), but existing installs need them created manually once.

### 5. Check result files appear after sending command

```bash
# Run this right after sending +journal from Telegram:
watch -n1 ls /opt/nanoclaw/data/ipc/{groupFolder}/journal_results/
```

Result file appears → MCP tool polled successfully.
No file appears → host handler didn't run. Check ipc.ts logs.

### 6. Check container logs

```bash
# Service runs as system (not user), so no --user flag:
journalctl -u nanoclaw -f
```

Look for:
- `Processing journal task` / `Processing dump task` → host handler ran
- `Journal task complete` / `Dump task complete` → script succeeded
- `Unknown IPC task type` → host handler missing

### 7. Test CLI path independently

```bash
# From /opt/nanoclaw, test with tsx (ts-node is NOT installed, only tsx):
echo '{"params":{"content":"test entry"},"secrets":{"NOTES_URL":"...","SHLINK_URL":"...","SHLINK_API_KEY":"...","SHLINK":"..."}}' | \
  (cd .claude/skills/journal && /opt/nanoclaw/node_modules/.bin/tsx journal.ts)

# Same for dump:
echo '{"params":{"tags":["ai-notes"],"tasks":["- [ ] test"]},"secrets":{}}' | \
  (cd .claude/skills/dump && /opt/nanoclaw/node_modules/.bin/tsx dump.ts)
```

Expected: JSON `{ success: true, message: "...", data: {...} }`

### 8. Verify MCP server actually registers the tools

The MCP server compiles from `/app/src` and runs as a subprocess. To verify it registers `save_journal` and `dump_tasks`:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | \
docker run --rm -i --entrypoint bash \
  -v /opt/nanoclaw/data/sessions/main/agent-runner-src:/app/src:ro \
  nanoclaw-agent:latest \
  -c 'cd /app && npx tsc --outDir /tmp/dist 2>/dev/null; ln -s /app/node_modules /tmp/dist/node_modules; node /tmp/dist/ipc-mcp-stdio.js'
```

Look for `save_journal` and `dump_tasks` in the `tools` array. If they're not there, the source sync or build is wrong.

### 9. Reset a poisoned session

If the agent persistently refuses to call the tools despite the system prompt being correct, its session history contains old failures that block it:

```bash
# Clear session from DB (next run starts fresh):
node -e "
const Database = require('/opt/nanoclaw/node_modules/better-sqlite3');
const db = new Database('/opt/nanoclaw/store/messages.db');
db.prepare('DELETE FROM sessions WHERE group_folder = ?').run('main');
console.log('Session cleared');
"

# Archive the stale JSONL so it can't be accidentally resumed:
cd /opt/nanoclaw/data/sessions/main/.claude/projects/-workspace-group/
mv <session-id>.jsonl <session-id>.jsonl.bak

# Restart service
systemctl restart nanoclaw
```

The agent will start a fresh session, read the current system prompt, and see the MCP tools as available.

---

## Container Path ↔ Host Path Mapping

| Container path | Host path |
|---------------|-----------|
| `/workspace/ipc/` | `DATA_DIR/ipc/{groupFolder}/` |
| `/workspace/ipc/tasks/` | `DATA_DIR/ipc/{groupFolder}/tasks/` |
| `/workspace/ipc/journal_results/` | `DATA_DIR/ipc/{groupFolder}/journal_results/` |
| `/workspace/ipc/dump_results/` | `DATA_DIR/ipc/{groupFolder}/dump_results/` |
| `/workspace/ipc/vault_url_results/` | `DATA_DIR/ipc/{groupFolder}/vault_url_results/` |
| `/workspace/ipc/short_url_results/` | `DATA_DIR/ipc/{groupFolder}/short_url_results/` |
| `/workspace/ipc/write_vault_file_results/` | `DATA_DIR/ipc/{groupFolder}/write_vault_file_results/` |
| `/workspace/group/` | `GROUPS_DIR/{groupFolder}/` |
| `/home/node/.claude/` | `DATA_DIR/sessions/{groupFolder}/.claude/` |
| `/workspace/global/` | `GROUPS_DIR/global/` |

`DATA_DIR` defaults to `/opt/nanoclaw/data` (see `src/config.ts`).
`GROUPS_DIR` is `groups/` in the project root.

---

## What `agent.ts` Files Are (and Aren't)

Both `.claude/skills/journal/agent.ts` and `.claude/skills/dump/agent.ts` define tool objects using `@anthropic-ai/claude-agent-sdk`'s `tool()`. These were intended to be passed directly to the SDK's `query()` function as custom tools — a different approach from the MCP server pattern.

They are **never registered** anywhere in the current codebase. The agent runner (`index.ts`) uses the MCP server approach via `mcpServers: { nanoclaw: { command: 'node', args: [mcpServerPath] } }`. Custom SDK tools would require passing them to `query({ tools: [...] })`, which is not done.

These files are safe to ignore. The correct place to add new agent-callable tools is `ipc-mcp-stdio.ts`.
