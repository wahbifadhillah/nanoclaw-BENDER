# OpenRouter Agent Routing + Telegram + Agent Swarm — How It Works

This document covers the OpenRouter integration, the named-agent routing system, the Telegram channel, and the Agent Swarm bot pool added to NanoClaw. It explains the full request flow, how routing decisions are made, how agent system prompts get injected, how pool bots are assigned to subagents, and how to extend the system.

---

## Overview

NanoClaw routes every prompt to a **named agent**, each backed by a specific OpenRouter model. Four agents are active by default; four more have system prompts ready and can be activated in minutes. Routing is automatic, based on keyword patterns in the incoming message. No configuration beyond setting your API key is required.

Messages can arrive from **WhatsApp or Telegram** — the orchestrator handles both channels identically. When running in Telegram mode with Agent Swarm enabled, each subagent in a team gets its own dedicated bot identity in the group so the user can see exactly who is speaking.

```
WhatsApp / Telegram message
      │
      ▼
src/channels/whatsapp.ts  OR  src/channels/telegram.ts
      │   ← normalises inbound message to common NewMessage type
      ▼
src/index.ts             ← orchestrator: queues, routes to agent
      │
      ▼
src/model-router.ts      ← keyword match → picks agent name
      │
      ▼
src/container-runner.ts  ← reads agents/{name}/system.md
                         ← writes ANTHROPIC_BASE_URL=http://host.docker.internal:4000
                         ← writes ANTHROPIC_MODEL (OpenRouter model ID)
                         ← attaches agentSystemPrompt to stdin payload
      │
      ▼
container (Docker)       ← --add-host=host.docker.internal:host-gateway
      │                  ← -e ANTHROPIC_BASE_URL=http://host.docker.internal:4000
      ▼
container/agent-runner/src/index.ts
      │  ← merges global CLAUDE.md + agentSystemPrompt
      │  ← calls SDK with ANTHROPIC_BASE_URL pointing to LiteLLM
      ▼
LiteLLM proxy (localhost:4000)
      │  ← accepts Anthropic /v1/messages format
      │  ← translates to OpenRouter /api/v1/chat/completions format
      ▼
OpenRouter API  →  {model}   ← e.g. google/gemini-2.5-flash-lite
      │
      ▼
Response → IPC → src/ipc.ts
      │
      ├─ data.sender present + tg: JID → sendPoolMessage()  (pool bot)
      └─ otherwise → deps.sendMessage()                     (main bot)
```

---

## All Agents

Each agent lives in `agents/{name}/system.md`. That file defines its role, approach, and output format, and is injected into the SDK system prompt at runtime. All 8 agents are registered in `src/model-router.ts`.

| Agent | Model | Trigger patterns (examples) | Default? |
|-------|-------|-----------------------------|----------|
| `daily` | `google/gemini-2.5-flash-lite` | *(everything else)* | ✓ |
| `light-research` | `google/gemini-2.5-flash` | "look up", "summarize", "explain", "analyze" | |
| `deep-research` | `google/gemini-3-flash-preview` | "deep research", "comprehensive", "in-depth", "full report" | |
| `tech-reviewer` | `minimax/minimax-m2.5` | "technical review", "feasibility", "how does it scale", "stress test" | |
| `finance-reviewer` | `google/gemini-2.5-flash` | "finance", "market", "investment", "bitcoin", "crypto", "macro" | |
| `health-reviewer` | `google/gemini-2.5-flash` | "health", "medical", "symptom", "wellness", "nutrition" | |
| `language-reviewer` | `google/gemini-2.5-flash` | "grammar", "proofread", "edit my", "writing review", "english" | |
| `science-reviewer` | `google/gemini-2.5-flash` | "science", "physics", "chemistry", "first principles", "mechanism" | |

---

## Configuration

### 1. Set your API key

Add one of the following to `.env`:

```env
# Option A — explicit OpenRouter key
OPENROUTER_API_KEY=sk-or-v1-...

# Option B — reuse ANTHROPIC_API_KEY slot with your OpenRouter key
ANTHROPIC_API_KEY=sk-or-v1-...
```

If `OPENROUTER_API_KEY` is present and `ANTHROPIC_API_KEY` is not, the runner automatically maps it to `ANTHROPIC_API_KEY` before passing secrets to the container. Both variables are stripped from the subprocess environment so Bash commands inside the container cannot read them.

### 2. Telegram environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | If using Telegram | Main bot token from `@BotFather` |
| `TELEGRAM_ONLY` | No | Set to `true` to disable WhatsApp and run Telegram only |
| `TELEGRAM_BOT_POOL` | If using Agent Swarm | Comma-separated pool bot tokens |

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ONLY=true
TELEGRAM_BOT_POOL=token1,token2,token3,token4
```

After editing `.env`, sync to the container environment path:

```bash
cp .env data/env/env
```

### 3. No other changes needed for OpenRouter

`ANTHROPIC_BASE_URL=http://host.docker.internal:4000` is written into each group's `settings.json` and passed as a Docker `-e` flag automatically on every container spawn. This points the Anthropic SDK to the local **LiteLLM proxy** (see [LiteLLM Proxy](#litellm-proxy) below), which translates the SDK's Anthropic-format calls into OpenRouter's format.

---

## LiteLLM Proxy

### Why it exists

The Claude Agent SDK (which powers NanoClaw's container agents) always calls the **Anthropic `/v1/messages` endpoint**. OpenRouter exposes a compatible URL at `https://openrouter.ai/api/v1/messages`, but it only accepts Anthropic provider models there. Sending `google/gemini-2.5-flash-lite` to that endpoint returns:

```json
{"error": "No allowed providers available", "requested_providers": ["anthropic"]}
```

Non-Anthropic models on OpenRouter require the **OpenAI `/v1/chat/completions` endpoint** — a different wire format that the SDK doesn't use.

**Solution:** A local [LiteLLM](https://docs.litellm.ai/) proxy sits between the container and OpenRouter. It:

1. Accepts the Anthropic `/v1/messages` format (what the SDK sends)
2. Translates the request to OpenRouter's `/api/v1/chat/completions` format
3. Translates the response back to Anthropic format
4. Runs as a systemd service on the host, reachable from containers via `host.docker.internal:4000`

### Configuration file

`/opt/nanoclaw/litellm-config.yaml`:

```yaml
general_settings:
  drop_params: true   # silently ignore unknown Anthropic params

model_list:
  - model_name: google/gemini-2.5-flash-lite
    litellm_params:
      model: openrouter/google/gemini-2.5-flash-lite
      api_key: os.environ/OPENROUTER_API_KEY

  - model_name: google/gemini-2.5-flash
    litellm_params:
      model: openrouter/google/gemini-2.5-flash
      api_key: os.environ/OPENROUTER_API_KEY

  - model_name: google/gemini-3-flash-preview
    litellm_params:
      model: openrouter/google/gemini-3-flash-preview
      api_key: os.environ/OPENROUTER_API_KEY

  - model_name: minimax/minimax-m2.5
    litellm_params:
      model: openrouter/minimax/minimax-m2.5
      api_key: os.environ/OPENROUTER_API_KEY
```

The `model_name` values must exactly match the `ANTHROPIC_MODEL` values written by `src/container-runner.ts`. LiteLLM uses the model name to look up the correct OpenRouter target.

### Systemd service

`/etc/systemd/system/litellm.service` runs the proxy on port 4000:

```ini
[Unit]
Description=LiteLLM Proxy for OpenRouter
After=network.target

[Service]
ExecStart=litellm --config /opt/nanoclaw/litellm-config.yaml --port 4000
Environment=OPENROUTER_API_KEY=sk-or-v1-...
Restart=on-failure
WorkingDirectory=/opt/nanoclaw

[Install]
WantedBy=multi-user.target
```

Service management:

```bash
systemctl start litellm
systemctl stop litellm
systemctl status litellm
journalctl -u litellm -f   # live logs
```

### Container networking

Containers run with `--add-host=host.docker.internal:host-gateway`, which maps the `host.docker.internal` hostname to the host's gateway IP. This is how the container reaches `localhost:4000` on the host without host networking mode.

`ANTHROPIC_BASE_URL=http://host.docker.internal:4000` is injected both as a Docker `-e` flag (so it reaches `process.env` in the agent-runner Node process) and written into `settings.json` (so it reaches the Claude Code subprocess). Both are required because they load the variable at different stages.

---

## Telegram Channel

### How it works

`src/channels/telegram.ts` implements the `Channel` interface — the same contract used by WhatsApp. The orchestrator in `src/index.ts` treats both channels identically: it holds a `channels: Channel[]` array and routes outbound messages via `findChannel(jid)`, which matches on JID prefix (`tg:` for Telegram, `@g.us`/`@s.whatsapp.net` for WhatsApp).

Telegram JIDs use the format `tg:{numeric_chat_id}`. Negative IDs are groups; positive IDs are private chats.

```
tg:-5292311757   ← group chat
tg:123456789     ← private chat
```

### @mention translation

Telegram @mentions (e.g. `@andy_ai_bot`) use the bot's username, not the assistant's trigger name. The channel translates them automatically:

```typescript
// If message contains @bot_username → prepend @AssistantName
if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
  content = `@${ASSISTANT_NAME} ${content}`;
}
```

This means `@andy_ai_bot do research` becomes `@Fry do research` internally, which matches the trigger pattern and routes to the agent.

### Built-in commands

| Command | Response |
|---------|----------|
| `/chatid` | Returns the chat's registration JID (`tg:{id}`), name, and type |
| `/ping` | Confirms the bot is online |

### Use case: run on a Linux server

On Linux, NanoClaw runs as a systemd service (`/etc/systemd/system/nanoclaw.service`) reading environment from `/opt/stack/.env`. WhatsApp auth requires an interactive QR scan and a persistent browser session, which is awkward on headless servers. Telegram bots use a token — no browser, no QR, no session file. Setting `TELEGRAM_ONLY=true` skips the WhatsApp connection entirely and removes that dependency.

---

## Agent Swarm (Bot Pool)

### What it is

When an agent creates a team of subagents, each subagent can call `mcp__nanoclaw__send_message` with a `sender` parameter (e.g. `sender: "Researcher"`). Instead of all messages appearing from the main bot, each unique sender gets its own Telegram bot identity from the pool.

```
Subagent calls send_message(text: "Found 3 results", sender: "Researcher")
  → IPC writes file with sender field
  → src/ipc.ts picks it up: data.sender present + tg: JID
  → sendPoolMessage("tg:-5292311757", text, "Researcher", "main")
      → assigns pool bot #2 to "Researcher" (round-robin, first use)
      → renames pool bot #2 to "Researcher" via setMyName (2s propagation delay)
      → sends message via pool bot #2's Api instance
  → Appears in Telegram from "Researcher" bot
```

### Bot pool architecture

Pool bots use Grammy's `Api` class — lightweight, no polling, just send. The main bot (`Bot`) handles all inbound polling; pool bots only call `sendMessage` and `setMyName`.

| Concept | Detail |
|---------|--------|
| Assignment | Round-robin on first use per `{groupFolder}:{senderName}` key |
| Stability | Same sender always gets the same pool bot within a service lifetime |
| Bot naming | `setMyName` renames the bot globally; 2-second delay allows Telegram to propagate |
| Fallback | If pool is empty, logs a warning — the message is dropped (not fallen back to main bot, to avoid identity confusion) |
| Reset | Sender→bot mapping resets on service restart; bots get reassigned fresh |

### Sender parameter in MCP tool

The `send_message` tool in the agent container already accepts an optional `sender`:

```typescript
server.tool('send_message', '...', {
  text: z.string(),
  sender: z.string().optional().describe(
    'Your role/identity name (e.g. "Researcher"). ' +
    'When set, messages appear from a dedicated bot in Telegram.'
  ),
}, async (args) => { ... });
```

The host IPC watcher (`src/ipc.ts`) routes based on whether `data.sender` is present and the JID starts with `tg:`:

```typescript
if (data.sender && data.chatJid.startsWith('tg:')) {
  await sendPoolMessage(data.chatJid, data.text, data.sender, sourceGroup);
} else {
  await deps.sendMessage(data.chatJid, data.text);
}
```

### Use case: interactive multi-agent research in Telegram

You send: `@Fry assemble a team of a marine biologist, a physicist, and Alexander Hamilton to debate the physics of fish`

What happens:
1. Fry (main bot) receives the message, acknowledges, and spawns three subagents via Claude Code Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
2. Each subagent is instructed to call `send_message` with their role name as `sender`.
3. The IPC watcher assigns pool bot #1 to "Marine Biologist", pool bot #2 to "Physicist", pool bot #3 to "Alexander Hamilton".
4. Each bot is renamed to match its role (with a 2-second delay for Telegram propagation).
5. Messages appear in the FUTURAMA group from three different bot identities — the user can see who is saying what in real time.
6. Fry synthesises and sends a final summary from the main bot.

The `groups/main/CLAUDE.md` Agent Teams section instructs the lead agent to create exactly the team the user asked for, give each member the `sender` instruction, keep messages short (2-4 sentences), and wrap non-user-facing output in `<internal>` tags.

### Pool bot requirements

- Each pool bot must be a member of the Telegram group it will post in
- Group Privacy must be **disabled** for each pool bot (`@BotFather` → `/mybots` → Bot Settings → Group Privacy → Turn off)
- Pool bots are send-only — they do not need to receive messages

---

## Request Flow — Step by Step

### Step 1 — Message arrives

A WhatsApp or Telegram message triggers the orchestrator (`src/index.ts`). Both channels emit a `NewMessage` object with the same fields. After parsing and queuing, the orchestrator calls `runContainerAgent()` in `src/container-runner.ts` with the raw prompt.

### Step 2 — Agent routing

Inside `buildVolumeMounts()`, the prompt is passed to `routeModel()`:

```typescript
// src/model-router.ts
export function routeModel(prompt: string): AgentName {
  const normalizedPrompt = prompt.toLowerCase().trim();
  for (const route of MODEL_ROUTES) {
    for (const pattern of route.patterns) {
      if (normalizedPrompt.includes(pattern)) return route.agent;
    }
  }
  return DEFAULT_AGENT; // 'daily'
}
```

Routing is **first-match**: patterns are checked in declaration order. `tech-reviewer` is checked before `light-research`, so "debug my code" routes to the tech reviewer even though "debug" could loosely mean research.

The matched agent name is returned alongside the volume mounts.

### Step 3 — Model written to settings.json

`buildVolumeMounts()` writes (or overwrites) the group's `.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0",
    "ANTHROPIC_BASE_URL": "http://host.docker.internal:4000",
    "ANTHROPIC_MODEL": "google/gemini-2.5-flash-lite"
  }
}
```

This file is mounted at `/home/node/.claude/settings.json` in the container. The Claude Code subprocess (spawned inside the container by the agent-runner) picks it up on startup. `ANTHROPIC_BASE_URL` points to the local LiteLLM proxy — not OpenRouter directly.

`ANTHROPIC_BASE_URL` is **also** passed as a Docker `-e` flag so that the agent-runner Node process itself (which starts before Claude Code) has the variable in `process.env`. Both injection paths are needed because the variable is consumed at two different layers.

### Step 4 — Agent system prompt attached

Back in `runContainerAgent()`, after the mounts are determined:

```typescript
const agentSystemMdPath = path.join(process.cwd(), 'agents', selectedAgent, 'system.md');
if (fs.existsSync(agentSystemMdPath)) {
  input.agentSystemPrompt = fs.readFileSync(agentSystemMdPath, 'utf-8');
}
```

This attaches the agent's role description to the `ContainerInput` object before it is serialised to stdin.

### Step 5 — Secrets forwarded via stdin

```typescript
input.secrets = readSecrets(); // reads ANTHROPIC_API_KEY (+ OPENROUTER_API_KEY alias)
container.stdin.write(JSON.stringify(input));
container.stdin.end();
delete input.secrets; // removed from memory immediately after write
```

The entire `ContainerInput` — prompt, session ID, secrets, and `agentSystemPrompt` — travels as a single JSON payload over stdin. Nothing is passed as environment variables or mounted files.

### Step 6 — Container starts, agent-runner boots

`docker run` is called with two extra flags for OpenRouter support:

```bash
--add-host=host.docker.internal:host-gateway   # lets container reach host localhost
-e ANTHROPIC_BASE_URL=http://host.docker.internal:4000  # points SDK to LiteLLM
```

`container/agent-runner/src/index.ts` reads stdin, parses the JSON, and merges secrets into `sdkEnv` (which starts from `process.env`, so it already contains `ANTHROPIC_BASE_URL`):

```typescript
const sdkEnv: Record<string, string | undefined> = { ...process.env };
for (const [key, value] of Object.entries(containerInput.secrets || {})) {
  sdkEnv[key] = value;
}
```

`sdkEnv` now contains `ANTHROPIC_API_KEY` (your OpenRouter key) alongside `ANTHROPIC_BASE_URL` (`http://host.docker.internal:4000`), which was injected by `docker run -e`.

A `PreToolUse` hook strips secrets from any Bash command the agent tries to run:

```typescript
const unsetPrefix = `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null; `;
```

### Step 7 — System prompt assembled

```typescript
const systemParts: string[] = [];

// 1. Global CLAUDE.md (shared instructions for all groups)
if (!containerInput.isMain && fs.existsSync('/workspace/global/CLAUDE.md')) {
  systemParts.push(fs.readFileSync('/workspace/global/CLAUDE.md', 'utf-8'));
}

// 2. Agent-specific role definition
if (containerInput.agentSystemPrompt) {
  systemParts.push(containerInput.agentSystemPrompt);
}

const combinedSystemPrompt = systemParts.length > 0
  ? systemParts.join('\n\n---\n\n')
  : undefined;
```

The result is passed to the SDK as `systemPrompt: { type: 'preset', preset: 'claude_code', append: combinedSystemPrompt }`. The Claude Code preset provides the base tool-use instructions; the append extends it with global memory and agent-specific behaviour.

### Step 8 — Query runs, response streams back

The SDK sends an Anthropic-format request to `http://host.docker.internal:4000` (LiteLLM). LiteLLM translates it to an OpenRouter `/chat/completions` request for the routed model (e.g. `google/gemini-2.5-flash-lite`) and forwards the response back in Anthropic format. The SDK never knows it isn't talking to Anthropic.

Results stream back through the `OUTPUT_START/END` sentinel protocol to `src/ipc.ts`, which routes each outbound message to the correct channel and bot identity.

---

## Adding a New Agent

1. **Create the folder and system prompt:**

```bash
mkdir agents/my-agent
cat > agents/my-agent/system.md << 'EOF'
# My Agent

You are a ...

## Your Role
...
EOF
```

2. **Register the model in `src/model-router.ts`:**

```typescript
export type AgentName = 'deep-research' | 'light-research' | 'daily' | 'tech-reviewer' | 'my-agent';

export const AGENT_MODELS: Record<AgentName, string> = {
  // ...existing entries...
  'my-agent': 'openai/gpt-4o', // any OpenRouter model ID
};
```

3. **Add routing patterns:**

```typescript
const MODEL_ROUTES: ModelRoute[] = [
  {
    patterns: ['my keyword', 'another phrase'],
    agent: 'my-agent',
    description: 'Short description of what this agent handles',
  },
  // ...existing routes...
];
```

4. **Add the model to `litellm-config.yaml`:**

```yaml
- model_name: openai/gpt-4o          # must match AGENT_MODELS value exactly
  litellm_params:
    model: openrouter/openai/gpt-4o
    api_key: os.environ/OPENROUTER_API_KEY
```

Then restart the proxy:

```bash
systemctl restart litellm
```

5. **Rebuild and restart NanoClaw:**

```bash
npm run build
systemctl restart nanoclaw   # Linux
```

The container runner and agent-runner pick up new agents automatically. The only required configuration beyond the code change is the `litellm-config.yaml` entry — without it, LiteLLM will return a 404 for the unknown model name.

---

## Routing Patterns Reference

Patterns are checked **in order** — first match wins.

1. `deep-research` — "deep research", "comprehensive", "in-depth", "full report", "investigate thoroughly", "thorough analysis", "detailed report"
2. `tech-reviewer` — "technical review", "stress test", "feasibility", "how does it scale", "architecture review", "review research", "engineering review", "trade-off", "trade off", "does it scale", "implementation strategy"
3. `finance-reviewer` — "finance", "economy", "market", "investment", "bitcoin", "crypto", "macro", "capital", "interest rate", "portfolio", "trading", "monetary policy"
4. `health-reviewer` — "health", "medical", "symptom", "wellness", "nutrition", "mental health", "medication", "disease", "body", "cortisol", "inflammation"
5. `language-reviewer` — "grammar", "proofread", "edit my", "correct my", "writing review", "language review", "fix my writing", "english", "paragraph", "sentence structure"
6. `science-reviewer` — "science", "physics", "chemistry", "biology", "scientific", "first principles", "how does it work", "mechanism", "thermodynamics", "quantum", "evolution"
7. `light-research` — "light research", "research note", "quick research", "look up", "find info", "search for", "summarize", "explain", "analyze", "analysis"
8. *(default)* `daily` — everything else

---

## Changing the Default Model

Edit `src/model-router.ts`:

```typescript
const DEFAULT_AGENT: AgentName = 'light-research'; // was 'daily'
```

Rebuild and restart.

---

## Disabling OpenRouter (reverting to Anthropic)

1. Remove `ANTHROPIC_BASE_URL` from the `settings.env` block in `src/container-runner.ts`.
2. Remove the `-e ANTHROPIC_BASE_URL=...` and `--add-host=...` lines from `buildContainerArgs()` in the same file.
3. Set `ANTHROPIC_MODEL` values in `src/model-router.ts` back to Anthropic model names (e.g. `claude-haiku-4-5`).
4. Stop the LiteLLM service (no longer needed):

```bash
systemctl stop litellm
systemctl disable litellm
```

5. Replace `OPENROUTER_API_KEY` in `.env` with a valid `ANTHROPIC_API_KEY`.

The routing infrastructure (agent names, system prompts, keyword patterns) stays the same — only the model IDs and base URL change.

---

## File Reference

| File | Role |
|------|------|
| `src/model-router.ts` | Routing rules, agent names, OpenRouter model IDs |
| `src/container-runner.ts` | Reads system.md, writes settings.json, injects `--add-host` and `-e ANTHROPIC_BASE_URL`, secrets alias |
| `src/container-runtime.ts` | Docker runtime abstraction: `ensureContainerRuntimeRunning`, `cleanupOrphans` |
| `src/channels/whatsapp.ts` | WhatsApp channel implementing the `Channel` interface |
| `src/channels/telegram.ts` | Telegram channel + pool bot state (`initBotPool`, `sendPoolMessage`) |
| `src/channels/telegram.test.ts` | 50 unit tests for TelegramChannel and pool functions |
| `src/ipc.ts` | IPC watcher: routes `data.sender` messages to pool, others to main channel |
| `src/config.ts` | All env exports incl. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ONLY`, `TELEGRAM_BOT_POOL` |
| `src/index.ts` | Orchestrator: multi-channel array, `initBotPool` call after Telegram connect |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP `send_message` tool with optional `sender` param |
| `container/agent-runner/src/index.ts` | Assembles system prompt, passes sdkEnv to query |
| `litellm-config.yaml` | LiteLLM proxy model list — maps OpenRouter model IDs to LiteLLM routes |
| `/etc/systemd/system/litellm.service` | Systemd unit running LiteLLM on port 4000 with `OPENROUTER_API_KEY` |
| `groups/global/CLAUDE.md` | Shared instructions for all groups (formatting rules) |
| `groups/main/CLAUDE.md` | Main group: Agent Teams instructions, lead agent behaviour |
| `agents/daily/system.md` | Daily assistant — notes, reminders, quick tasks |
| `agents/light-research/system.md` | Light research — lookups, summaries, explanations |
| `agents/deep-research/system.md` | Deep research — comprehensive reports, multi-source synthesis |
| `agents/tech-reviewer/system.md` | Tech reviewer — stress-tests research for engineering feasibility |
| `agents/finance-reviewer/system.md` | Finance — macro flows, capital incentives, risk profiles |
| `agents/health-reviewer/system.md` | Health — root cause analysis, mechanisms of action |
| `agents/language-reviewer/system.md` | Language — grammar error theory, paragraph refinement |
| `agents/science-reviewer/system.md` | Science — first-principles deconstruction, mechanism explanations |
