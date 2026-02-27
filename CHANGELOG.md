# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

#### OpenRouter Integration
- `ANTHROPIC_BASE_URL` is now written to every group's `settings.json` env block, pointing all SDK calls to `https://openrouter.ai/api/v1`. The Anthropic SDK and Claude Agent SDK both honour this variable, so no other wiring was needed.
- `OPENROUTER_API_KEY` is now accepted in `.env` as an alias for `ANTHROPIC_API_KEY`. If only `OPENROUTER_API_KEY` is set, it is mapped to `ANTHROPIC_API_KEY` before being forwarded to the container via stdin. If both are set, `ANTHROPIC_API_KEY` takes priority.

#### Named Agent System (`agents/`)
- New top-level `agents/` directory. Each subdirectory represents a named agent with its own `system.md` (role, approach, output format).
- Four agents shipped out of the box:

| Agent | Model | Best for |
|-------|-------|----------|
| `daily` | `google/gemini-2.5-flash-lite` | Notes, reminders, quick tasks |
| `light-research` | `google/gemini-2.5-flash` | Summaries, lookups, explanations |
| `deep-research` | `google/gemini-3-flash-preview` | Comprehensive reports, multi-source synthesis |
| `tech-reviewer` | `minimax/minimax-m2.5` | Code review, architecture, technical trade-offs |

- `daily` is the **default** agent — used when no routing pattern matches.

#### Agent System Prompt Injection
- When a container is spawned, `container-runner.ts` reads `agents/{selectedAgent}/system.md` and attaches it to `ContainerInput.agentSystemPrompt`.
- Inside the container, `agent-runner/src/index.ts` appends the agent's system prompt to the global `CLAUDE.md` context via the SDK's `systemPrompt.append` option. Both sources are combined with a `---` separator.

### Changed

#### `src/model-router.ts` — rewritten
- `ClaudeModel` type (`'haiku' | 'sonnet' | 'opus'`) replaced by `AgentName` (`'deep-research' | 'light-research' | 'daily' | 'tech-reviewer'`).
- `getModelEnvValue()` now returns OpenRouter model IDs (e.g. `google/gemini-2.5-flash-lite`) instead of Claude model names.
- `DEFAULT_AGENT` changed from `'haiku'` → `'daily'` (`google/gemini-2.5-flash-lite`).
- Routing table updated: `tech-reviewer` patterns cover debugging, code review, and architecture keywords; `light-research` patterns cover lookups, summaries, and analysis; `deep-research` patterns cover comprehensive/in-depth requests.
- `AGENT_MODELS` map exported for reference by other modules.
- `getRoutingInfo()` return shape updated (`defaultAgent` instead of `defaultModel`).

#### `src/container-runner.ts`
- `buildVolumeMounts()` return type changed from `VolumeMount[]` to `{ mounts: VolumeMount[]; selectedAgent: AgentName }` — caller now gets the routing decision alongside the mount list.
- `runContainerAgent()` reads the agent's `system.md` immediately after mounts are built and attaches it to `input.agentSystemPrompt`.
- `settings.env` block gains `ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1'`.
- `readSecrets()` now whitelists `OPENROUTER_API_KEY` and performs the alias mapping before returning; `OPENROUTER_API_KEY` is never forwarded to the container.
- Log message updated from `'Model routing applied'` → `'Agent routing applied'`; log fields updated (`agent`, `modelName`).
- Stale commented-out settings block removed.

#### `ContainerInput` interface (both host and container)
- `agentSystemPrompt?: string` field added. Populated on the host before stdin write; consumed in the container to extend the SDK system prompt.

#### `container/agent-runner/src/index.ts`
- `globalClaudeMd` variable replaced by `systemParts: string[]` accumulator.
- Global CLAUDE.md and `agentSystemPrompt` are both pushed into `systemParts` and joined with `\n\n---\n\n` before being passed to the SDK.
- `ContainerInput` interface synced with host-side definition (adds `agentSystemPrompt?`).

---

## [1.1.0] — prior release

- `/update` skill for pulling upstream changes with merge preview.
- Auto version bumping on update.

## [1.0.x] — prior releases

- Initial Agent Swarms (Teams) support.
- IPC streaming output with `OUTPUT_START/END` sentinels.
- Per-group session isolation.
- Scheduled tasks.
- WhatsApp channel via Baileys.
