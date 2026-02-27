# Agent Behaviour in NanoClaw

How routed agents work, how their messages get delivered, and what each agent must do.

---

## Architecture Overview

Every agent run has two possible delivery paths for its response:

### Path 1 — Streaming path (host-side)
`src/index.ts` → `processGroupMessages` → `onOutput` callback

When the SDK emits a `result` message, the host receives the text and sends it via `channel.sendMessage`. This is the default path for WhatsApp and for Telegram without pool bots.

### Path 2 — IPC path (container-side)
Agent calls `mcp__nanoclaw__send_message` → writes file to `/workspace/ipc/messages/` → host IPC watcher picks it up → calls `sendPoolMessage()` → delivers via the assigned pool bot.

This is the **primary path for Telegram with pool bots**. It preserves bot identity (each agent has a dedicated Telegram bot).

### Guard: streaming path is suppressed for Telegram+pool

```ts
const isTelegramWithPool = chatJid.startsWith('tg:') && hasPoolBots();
if (!isTelegramWithPool) {
  await channel.sendMessage(chatJid, text); // skip for Telegram+pool
}
```

This prevents duplicates when an agent uses `send_message` (IPC) AND the streaming path both fire for the same text.

### Fallback: streaming path as safety net

If the agent finishes without any IPC pool delivery detected, `processGroupMessages` waits one IPC poll cycle (1.2s) and then falls back to sending via the main bot. This ensures messages are never silently dropped even if an agent forgets to call `send_message`.

The fallback is logged as: `No pool delivery detected — falling back to main bot`

---

## Agent Personas & Bot Assignments

Each routed agent has a Futurama persona, a dedicated Telegram bot, and a `sender` name to use in `send_message`.

| Trigger | Agent | Persona | Sender Name | Pool Bot |
|---------|-------|---------|-------------|----------|
| `>bender` / default | `daily` | Bender Bending Rodríguez | `"Bender Bending Rodríguez"` | `benderfromtijuana_bot` |
| `>professor` / `>farnsworth` | `deep-research` | Prof. Hubert J. Farnsworth | `"Professor Farnsworth"` | `farnsworthfromnewyork_bot` |
| `>fry` | `light-research` | Philip J. Fry | `"Philip J. Fry"` | `philipfromnewyork_bot` |
| `>amy` | `tech-reviewer` | Amy Wong-Kroker | `"Amy Wong-Kroker"` | `amyfrommars_bot` |
| `>hermes` | `finance-reviewer` | Hermes Conrad | `"Hermes Conrad"` | `hermesfromkingston_bot` |
| `>zoidberg` | `health-reviewer` | Dr. John A. Zoidberg | `"Dr. Zoidberg"` | `zoidbergfromdecapod10_bot` |
| `>leela` | `language-reviewer` | Turanga Leela | `"Turanga Leela"` | `leelaisnotalien_bot` |
| `>nibbler` | `science-reviewer` | Lord Nibbler | `"Lord Nibbler"` | `thelordnibbler_bot` |

Pool bot assignment is persisted in `data/pool-bot-map.json` keyed by `{groupFolder}:{senderName}`.

> **Important**: Do NOT rely on automatic round-robin assignment for correct bot identity. Round-robin assigns whichever pool bot is "next" at the time an agent first sends — this is non-deterministic and will map agents to wrong bots if not pre-seeded. Always pre-seed `data/pool-bot-map.json` with all intended assignments (see [Adding a New Agent](#adding-a-new-agent)).

The canonical pre-seeded state for the main group:

```json
{
  "main:Bender Bending Rodríguez": "benderfromtijuana_bot",
  "main:Professor Farnsworth":     "farnsworthfromnewyork_bot",
  "main:Philip J. Fry":            "philipfromnewyork_bot",
  "main:Amy Wong-Kroker":          "amyfrommars_bot",
  "main:Hermes Conrad":            "hermesfromkingston_bot",
  "main:Dr. Zoidberg":             "zoidbergfromdecapod10_bot",
  "main:Turanga Leela":            "leelaisnotalien_bot",
  "main:Lord Nibbler":             "thelordnibbler_bot"
}
```

---

## What Every Agent Must Do

### Send the response via `send_message`

Each agent system prompt (`agents/{name}/system.md`) must include a `## Sending Your Response` section instructing the agent to call `mcp__nanoclaw__send_message` with a consistent `sender` name:

```
mcp__nanoclaw__send_message(sender="Lord Nibbler", text="<your response>")
```

- `sender` must match exactly on every call — this is the key for stable pool bot assignment
- After calling `send_message`, wrap the final output in `<internal>` tags to prevent the streaming fallback from also sending it
- NEVER use markdown — only Telegram formatting (`*bold*`, `_italic_`, `• bullets`, ` ```code``` `)

### Pattern (add to every agent system.md)

```markdown
## Sending Your Response

You are replying in a Telegram group where you have your own dedicated bot identity.
When you have your response ready, send it using:

    mcp__nanoclaw__send_message(sender="<Persona Name>", text="<your response>")

Keep `sender` exactly `"<Persona Name>"` every time — this keeps your bot identity stable.
Then wrap your final output in `<internal>` tags so it is not sent again.

NEVER use markdown. Use only Telegram formatting: *bold* (single asterisks), _italic_, • bullets, ```code```.
```

---

## System Prompt Loading

Agent system prompts from `agents/{name}/system.md` are loaded by `src/container-runner.ts` and passed as `agentSystemPrompt` to the container.

In `container/agent-runner/src/index.ts`:

```ts
if (containerInput.agentSystemPrompt) {
  // Agent has explicit personality routing — use it exclusively
  combinedSystemPrompt = containerInput.agentSystemPrompt;
} else if (containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
  // Main group without agent routing — use global context
  combinedSystemPrompt = fs.readFileSync(globalClaudeMdPath, 'utf-8');
}
```

**Key rule**: Agent system prompts are **exclusive** — when a routed agent runs, the global `CLAUDE.md` is NOT loaded. This prevents the global "Fry" personality from overriding Nibbler, Zoidberg, etc. The agent's personality is the only context.

Main group (Bender/`daily`) uses `groups/global/CLAUDE.md` + `groups/main/CLAUDE.md` via the SDK's project settings mechanism when no agent routing is in play.

---

## Routing

`src/model-router.ts` maps trigger keywords to agent names. The `routeModel()` function unescapes XML entities before pattern matching (since `formatMessages()` escapes `>` to `&gt;`).

```ts
const normalizedPrompt = prompt
  .toLowerCase()
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  // ...
```

Without this unescaping, `>nibbler` in user input would become `&gt;nibbler` in the formatted prompt and never match.

---

## Common Failure Modes

### Agent responds but message doesn't appear in Telegram

**Cause**: Agent did not call `mcp__nanoclaw__send_message`. Streaming path is suppressed for Telegram+pool, so the text was saved as `fallbackText` and the host waited for IPC delivery that never came.

**Resolution**: After 1.2s grace period, the fallback fires and sends via the main bot. The message appears but from the main bot (`benderfromtijuana_bot`), not the agent's own bot.

**Fix**: Add / verify the `## Sending Your Response` section in the agent's `system.md`.

### Agent sends message from wrong bot

**Cause**: `data/pool-bot-map.json` has a wrong entry — either a stale assignment from a previous run, or an incorrect round-robin assignment from when the agent first sent (before the map was pre-seeded).

Note: the personality in the response being correct (e.g. Zoidberg-style text) does NOT mean routing failed — it means the agent ran correctly but the pool map pointed to the wrong bot.

**Diagnosis**:
```bash
cat /opt/nanoclaw/data/pool-bot-map.json
```
Compare each `{group}:{senderName}` entry against the canonical assignments above.

**Fix**: Set the correct bot directly in the map — do NOT delete the key and let it reassign, as round-robin re-assignment is non-deterministic and may land on the wrong bot again:
```json
"main:Dr. Zoidberg": "zoidbergfromdecapod10_bot"
```
Then restart the service for the change to take effect.

### Duplicate messages

**Cause**: Both IPC path and streaming fallback fired for the same response. This happens if `poolDelivered` was set to `true` too late (after the fallback timer already checked it).

**Diagnosis**:
```bash
journalctl -u nanoclaw -n 200 | grep -E "(Pool message sent|Telegram message sent|falling back to main bot)"
```

**Root cause check**: Two entries for `Pool message sent` + `Telegram message sent` for the same response = both paths fired.

### Agent personality wrong (e.g., Nibbler sounds like Fry)

**Cause**: Agent routing isn't working — `routeModel()` returned `daily` (default). The `>nibbler` trigger wasn't matched.

**Check**: Verify `>nibbler` is in `MODEL_ROUTES` in `src/model-router.ts`. Verify XML unescaping is applied in `routeModel()`.

---

## MCP Tool Reference (inside container)

| Tool | What it does |
|------|-------------|
| `mcp__nanoclaw__send_message` | Sends a message to the group chat. Use `sender` for pool bot identity. |
| `mcp__nanoclaw__schedule_task` | Schedule a recurring or one-time task |
| `mcp__nanoclaw__list_tasks` | List scheduled tasks |
| `mcp__nanoclaw__pause_task` | Pause a task |
| `mcp__nanoclaw__resume_task` | Resume a paused task |
| `mcp__nanoclaw__cancel_task` | Cancel/delete a task |
| `mcp__nanoclaw__save_journal` | Append to the daily vault journal file |
| `mcp__nanoclaw__dump_tasks` | Save tagged task lists to vault |
| `mcp__nanoclaw__write_vault_file` | Write or append any `.md` in the vault |
| `mcp__nanoclaw__get_vault_url` | Get browser URL for a vault file |
| `mcp__nanoclaw__get_short_url` | Shorten a URL via Shlink |

All MCP tools are called **directly by tool name** — do NOT use the `Skill` tool for them.

---

## Adding a New Agent

1. Create `agents/{name}/system.md` with the persona, role, and crucially the `## Sending Your Response` section with the correct `sender` name.
2. Add the agent to `AgentName` type and `MODEL_ROUTES` in `src/model-router.ts`.
3. Add a model to `AGENT_MODELS` in `src/model-router.ts`.
4. Add the Telegram bot token to `TELEGRAM_BOT_POOL` in `/opt/stack/.env`.
5. Pre-seed the pool map — add the entry to `data/pool-bot-map.json` before restarting:
   ```json
   "{groupFolder}:{Sender Name}": "newbot_username"
   ```
   Do NOT skip this step and rely on auto-assignment — round-robin is non-deterministic.
6. Document the agent in `adding_telegram_bot-README.md` (persona table + routing table).
7. Restart the service.

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/model-router.ts` | Routes trigger keywords to agent names |
| `src/container-runner.ts` | Loads `agents/{name}/system.md`, spawns container |
| `src/index.ts` | `processGroupMessages` — streaming path, fallback logic |
| `src/ipc.ts` | IPC watcher — processes `send_message` files, calls `sendPoolMessage` |
| `src/channels/telegram.ts` | `sendPoolMessage`, pool init, `hasPoolBots` |
| `agents/{name}/system.md` | Per-agent system prompt (persona + send_message instructions) |
| `data/pool-bot-map.json` | Persistent `{groupFolder}:{senderName}` → bot username map |
| `groups/global/CLAUDE.md` | Global context loaded for main group only |
| `groups/main/CLAUDE.md` | Main group–specific context (team instructions, vault tools, admin) |
