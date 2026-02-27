# Duplicate Messages Bug — Root Cause & Fix

## Symptoms

Every agent response was sent **twice** to the Telegram group:
- Once via the main bot (`Telegram message sent` in logs)
- Once via a pool bot (`Pool message sent` in logs, e.g. "Bender Bending Rodríguez")

Both sends had identical content (same character length confirmed in logs).

---

## Root Cause: Two Concurrent Send Paths

### Path 1 — Streaming output callback (host-side)
`src/index.ts` → `processGroupMessages` → `onOutput` callback:
```ts
if (result.result) {
  const text = ...strip internal tags...
  await channel.sendMessage(chatJid, text); // ← sends via main Telegram bot
}
```
This fires whenever the SDK emits a `result` message (Claude's final text response).

### Path 2 — IPC `send_message` MCP tool (container-side)
The agent calls `mcp__nanoclaw__send_message` with `sender: "Bender Bending Rodríguez"`:
1. MCP server writes a file to `/workspace/ipc/messages/`
2. Host IPC watcher (`src/ipc.ts`) picks it up
3. Calls `sendPoolMessage()` → sends via pool bot with Bender's identity

Both paths fire for every response → user receives the same message twice.

---

## Fix

### `src/index.ts` — Skip streaming send when pool bots handle Telegram delivery

```ts
const isTelegramWithPool = chatJid.startsWith('tg:') && hasPoolBots();
if (!isTelegramWithPool) {
  await channel.sendMessage(chatJid, text);
}
outputSentToUser = true;
```

For Telegram with pool bots: IPC path is authoritative (preserves bot identity).
For WhatsApp or Telegram without pool: streaming path is used as before.

### `src/channels/telegram.ts` — Export pool availability check

```ts
export function hasPoolBots(): boolean {
  return poolApis.length > 0;
}
```

---

## Related Bug: `>text` Routing Patterns Not Matching

### Symptom
Patterns like `>fry`, `>professor` in `src/model-router.ts` never matched, so all messages
fell through to the default `daily` agent regardless of what the user typed.

### Root Cause
`formatMessages()` in `src/router.ts` runs `escapeXml()` on message content, which converts
`>` → `&gt;`. So user input `>fry` becomes `&gt;fry` in the XML-formatted prompt string
passed to `routeModel()`. The pattern `'>fry'` never matches `'&gt;fry'`.

### Fix — `src/model-router.ts`

Unescape XML entities before pattern matching:

```ts
export function routeModel(prompt: string): AgentName {
  // Unescape XML entities — formatMessages escapes > to &gt; etc.
  const normalizedPrompt = prompt
    .toLowerCase()
    .trim()
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
  ...
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/index.ts` | Skip `channel.sendMessage` for Telegram with pool bots in `onOutput` |
| `src/channels/telegram.ts` | Add `hasPoolBots()` export |
| `src/model-router.ts` | Unescape XML entities in `routeModel` before pattern matching |

---

## Status: Both Fixes Verified Applied

Both fixes above are confirmed present in the current codebase. The two bugs are **independent** — the `model-router.ts` routing change did **not** cause the double messages.

- The double-send bug was a pre-existing architectural issue (two concurrent send paths).
- The `>fry` routing bug was a separate XML encoding issue.
- Fixing `>fry` routing changes *which agent runs* but has no effect on *how replies are delivered*.

### Remaining Edge Case

The streaming-path guard only fires when `hasPoolBots() === true`:

```ts
const isTelegramWithPool = chatJid.startsWith('tg:') && hasPoolBots();
```

If pool bots are not configured (`TELEGRAM_BOT_POOL` empty), `hasPoolBots()` returns false and the streaming path is never blocked. In that scenario, if an agent calls `send_message` MCP with a `sender` field, `sendPoolMessage()` will be called but returns early (no pool bots available, just logs a warn), so the IPC path sends nothing and only the streaming path fires — still a single message.

### Diagnosing if Doubles Still Occur

```bash
journalctl --user -u nanoclaw -n 200 | grep -E "(Pool message sent|Telegram message sent|IPC message sent)"
```

Doubles would appear as both `Pool message sent` and `Telegram message sent` for the same response within the same agent run.

---

## Incident: Duplicate Agent Spawns (2026-02-26)

### Symptoms

Every incoming message triggered **two independent agent containers**, each producing its own response. The Telegram group received two different replies — same intent, different wording (e.g. "Four of me?! Don't be ridiculous..." and "Four of me? Don't be ridiculous..."). ENOENT errors also appeared in logs when both processes raced to delete the same IPC file.

### Root Cause: Two Host Processes Running Simultaneously

Two separate `node dist/index.js` host processes were running at the same time:

- PID `3530676` — managed by `nanoclaw.service` (systemd)
- PID `3530246` — stray process started manually (`node dist/index.js`), left running in the background

Both processes shared the same SQLite DB, same IPC directories, same Telegram bot credentials. Both polled for new messages, both spawned containers, both sent via IPC/pool. No architectural code bug — a process management issue.

**How to confirm:** Check for multiple PIDs:
```bash
ps aux | grep "node.*dist/index" | grep -v grep
```
Two entries = two instances = duplicates guaranteed.

### ENOENT Cascade

Both processes picked up the same IPC file. Whichever deleted it first succeeded; the second got `ENOENT` on `unlinkSync`, fell into the catch block, then got another `ENOENT` on `renameSync` → two error log lines per IPC file.

### Fixes Applied

**1. Killed stray process** (immediate)
```bash
kill <stray-pid>
```

**2. PID lock file** (`src/index.ts`) — `acquirePidLock()` added before `main()` setup:
- On startup, writes PID to `data/nanoclaw.pid`
- If a second instance starts and finds an alive PID in the lock file, it logs an error and calls `process.exit(1)` immediately
- Stale lock files (process no longer alive) are overwritten with a warning
- Lock file is removed on graceful shutdown

**3. ENOENT-tolerant IPC cleanup** (`src/ipc.ts`):
- `unlinkSync` on success path now silently ignores `ENOENT` (file already gone)
- `renameSync` in error handler also ignores `ENOENT` — no more cascading error logs

### Files Changed (this incident)

| File | Change |
|------|--------|
| `src/index.ts` | Added `acquirePidLock()` — PID file written at startup, checked to prevent dual instances |
| `src/ipc.ts` | Made `unlinkSync` and `renameSync` in IPC processor ENOENT-tolerant |

---

## Incident: Wrong Pool Bot After Restart (2026-02-26)

### Symptom

After every service restart, Bender's messages were being sent by `farnsworthfromnewyork_bot` instead of `benderfromtijuana_bot`.

### Root Cause: Two separate bugs combined

**Bug 1 — Pool map was in-memory only.**
`senderBotMap` (which maps `{groupFolder}:{senderName}` → pool index) lived only in RAM. Every restart cleared it, and the round-robin counter reset to 0. The first sender to appear got assigned pool index 0, which happened to be `farnsworthfromnewyork_bot`.

**Bug 2 — `benderfromtijuana_bot` was missing from `TELEGRAM_BOT_POOL`.**
The main bot token was only in `TELEGRAM_BOT_TOKEN` (for polling/receiving). It was never in `TELEGRAM_BOT_POOL`, so it had no pool index and could never be assigned as Bender's sender. The pool only had Farnsworth, Philip, Amy, Hermes.

### Pool Structure

| Variable | Bot | Role |
|----------|-----|------|
| `TELEGRAM_BOT_TOKEN` | `benderfromtijuana_bot` | Main bot — receives messages AND now also sends as Bender |
| `TELEGRAM_BOT_POOL[0]` | `benderfromtijuana_bot` | Pool index 0 → assigned to "Bender Bending Rodríguez" |
| `TELEGRAM_BOT_POOL[1]` | `farnsworthfromnewyork_bot` | Pool index 1 → deep-research agent |
| `TELEGRAM_BOT_POOL[2]` | `philipfromnewyork_bot` | Pool index 2 → light-research agent |
| `TELEGRAM_BOT_POOL[3]` | `amyfrommars_bot` | Pool index 3 → tech-reviewer agent |
| `TELEGRAM_BOT_POOL[4]` | `hermesfromkingston_bot` | Pool index 4 → finance-reviewer agent |

A bot can appear in both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_POOL` without conflict — the pool uses `Api` instances (send-only, no polling).

### Fixes Applied

**1. Persist pool-bot map to disk** (`src/channels/telegram.ts`):
- Added `data/pool-bot-map.json` — saves `{groupFolder}:{senderName}` → bot username (not index)
- Keyed by username so the mapping survives token reordering in `TELEGRAM_BOT_POOL`
- Loaded on startup after `initBotPool` completes; saved on every new assignment
- New bot assignments also log `botUsername` alongside `poolIndex`

**2. Added `benderfromtijuana_bot` to `TELEGRAM_BOT_POOL`** (`/opt/stack/.env`):
- Prepended its token as the first entry so it gets pool index 0
- On the next Bender response, it is assigned index 0, saved to disk, and persists across all future restarts

### Files Changed (this incident)

| File | Change |
|------|--------|
| `src/channels/telegram.ts` | `poolUsernames[]` parallel array; `loadPoolMap()`/`savePoolMap()` using `data/pool-bot-map.json`; `botUsername` logged on assignment |
| `/opt/stack/.env` | `benderfromtijuana_bot` token prepended to `TELEGRAM_BOT_POOL` |
