# Adding Telegram Bots to NanoClaw

## Overview

NanoClaw uses a **bot pool** system where each agent persona gets its own dedicated Telegram bot identity. When an agent sends a message via `mcp__nanoclaw__send_message` with a `sender` name, it gets auto-assigned a pool bot (round-robin, persisted to disk).

---

## Step 1: Register the Bot Token

Add the new bot token(s) to `TELEGRAM_BOT_POOL` in `/opt/stack/.env`:

```env
TELEGRAM_BOT_POOL=<existing tokens>,<new_token_1>,<new_token_2>,...
```

Tokens are comma-separated. Order determines pool index (first = index 0).

> **Note:** `TELEGRAM_BOT_TOKEN` is the main bot used for *receiving* messages (polling). It can also appear as the first entry in `TELEGRAM_BOT_POOL` so it doubles as a sender (e.g. Bender).

---

## Step 2: Add a Persona to the Agent (optional but recommended)

If the bot is assigned to a specific reviewer agent, add a Futurama persona section to its `agents/{agent-name}/system.md`. This ensures the agent identifies itself with a consistent `sender` name when sending messages in team contexts.

Follow the pattern from existing agents:

```
# {Agent Title} (Persona: {Character Name})

You are **{Character Name}**, {brief character description}. You are a {role description}...

## Voice & Style
- ...
```

Existing assignments:
| Agent | Persona | Bot |
|-------|---------|-----|
| `daily` | Bender Bending Rodríguez | `benderfromtijuana_bot` |
| `deep-research` | Prof. Hubert J. Farnsworth | `farnsworthfromnewyork_bot` |
| `light-research` | Philip J. Fry | `philipfromnewyork_bot` |
| `tech-reviewer` | Amy Wong-Kroker | `amyfrommars_bot` |
| `finance-reviewer` | Hermes Conrad | `hermesfromkingston_bot` |
| `health-reviewer` | Dr. John A. Zoidberg | `zoidbergfromdecapod10_bot` |
| `language-reviewer` | Turanga Leela | `leelaisnotalien_bot` |
| `science-reviewer` | Lord Nibbler | `thelordnibbler_bot` |

---

## Step 3: Restart the Service

```bash
systemctl restart nanoclaw
```

Check logs to confirm the new bot(s) initialized:

```bash
tail -f /opt/nanoclaw/logs/nanoclaw.log | grep "Pool bot initialized"
```

Expected output per bot:
```
INFO: Pool bot initialized
  username: "zoidbergfromdecapod10_bot"
  id: 8399486324
  poolSize: 6
```

Final confirmation:
```
INFO: Telegram bot pool ready
  count: 8
```

---

## How Assignment Works

- **Automatic & round-robin** — no manual mapping needed.
- On first `send_message` with a new `sender` name, the next available pool bot is assigned.
- Assignment is keyed by `{groupFolder}:{senderName}` and persisted to `data/pool-bot-map.json` (survives restarts).
- The bot is then renamed in Telegram to the `sender` name via `setMyName`.

Check current assignments:
```bash
cat /opt/nanoclaw/data/pool-bot-map.json
```

---

## Routing Patterns

The model router (`src/model-router.ts`) maps trigger keywords to agents. Each agent also has a `>character` shortcut:

| Trigger | Agent |
|---------|-------|
| `>bender` / default | `daily` |
| `>professor` / `>farnsworth` / `deep-research` | `deep-research` |
| `>fry` / `light-research` | `light-research` |
| `>amy` / `tech-review` | `tech-reviewer` |
| `>hermes` / `finance-reviewer` | `finance-reviewer` |
| `>zoidberg` / `health-reviewer` | `health-reviewer` |
| `>leela` / `language-reviewer` | `language-reviewer` |
| `>nibbler` / `science-reviewer` | `science-reviewer` |

To add a new routing pattern, edit `src/model-router.ts` — add to `MODEL_ROUTES` and `AgentName` type.

---

## Troubleshooting

**Bot not appearing in pool:**
- Check the token is correctly appended (no spaces, comma-separated).
- Verify the token is valid — pool init will log an error if `getMe()` fails.

**Wrong bot sending messages after restart:**
- Check `data/pool-bot-map.json` — if keyed by username and the bot is in the pool, it will restore correctly.
- If the map is corrupt/missing, delete it and let it rebuild on the next agent message.

**Duplicate messages:**
- Only occurs when `TELEGRAM_BOT_POOL` is non-empty *and* a stray second host process is running.
- Check: `ps aux | grep "node.*dist/index" | grep -v grep` — should show exactly one PID.
- See `multiple_agent_messages.md` for full incident analysis.
