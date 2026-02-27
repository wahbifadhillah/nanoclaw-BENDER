# Fix: Bender Agent Not Giving Progress Feedback During Multi-Step Tasks

**Date**: 2026-02-27
**Category**: debug
**Affects**: `agents/daily/system.md`, `container/agent-runner/src/index.ts` (architectural understanding)

## Summary

The Bender daily agent was completing multi-step tasks (reading journals, summarizing, writing to vault) silently with no progress feedback to the user. The vault file was either empty or never created. Added explicit instructions to `agents/daily/system.md` for mandatory progress messages via `mcp__nanoclaw__send_message` at task start and a specific 6-step workflow pattern for vault writes, ensuring users get feedback and non-empty vault files.

## Context / Problem

**Symptom**: When a user asked the Bender agent to "summarize journals and put results in /generals", the agent appeared to hang or work silently. The user reported "hours" of no feedback, then suddenly received a response. Additionally, the vault file contained no content or was never created at all — user noted "u writes nothing in it."

**Expected behavior**: Multi-step tasks should provide immediate acknowledgment ("Ugh, fine. Reading your boring journals now...") followed by the completed vault write and a URL to the result.

**Observed behavior**:
- No immediate feedback after task acceptance
- Agent silently performed work (read files, generated summaries)
- Vault file was empty or missing
- Final response arrived without context about what happened

## Investigation Steps

1. **Analyzed the agent system prompt** (`agents/daily/system.md`) — it had personality and role instructions but NO guidance for multi-step task workflows
2. **Checked the agent-runner architecture** (`container/agent-runner/src/index.ts`) — confirmed that only the agent's final `result` text is sent to the user via OUTPUT_START/END markers; intermediate tool calls are NOT automatically visible
3. **Reviewed available IPC tools** — `mcp__nanoclaw__send_message` exists specifically for mid-task progress updates (documented in its tool description: "Use this for progress updates or to send multiple messages")
4. **Identified the vault write pattern gap** — no documented workflow showing the correct sequence: send_message → do work → write_vault_file → get_vault_url → get_short_url → send_message confirmation

## Root Cause / Key Discovery

**The core issue was architectural mismatch between task complexity and agent feedback mechanism**:

1. **Silent work**: The agent-runner only outputs the agent's final `result` text to the user. Long-running multi-step tasks (file reads, summarization, vault writes) produce NO visible output until completion. Without explicit `send_message` calls in the agent's instructions, users perceive a hang.

2. **System prompt gap**: The Bender personality instructions emphasized voice and role but had no guidance for multi-step workflows. The agent had access to `mcp__nanoclaw__send_message` but no instructions to USE it proactively during long tasks.

3. **Vault write pattern undefined**: There was no explicit workflow documented for "write summary to vault and return URL to user." The agent may have written empty content, skipped the write, or completed it without sending the result URL.

## Solution / Implementation

Added a new "Multi-Step Tasks (Reading / Writing / Research)" section to `/opt/nanoclaw/agents/daily/system.md` with explicit, mandatory instructions:

### Key Changes

**1. Mandatory acknowledgment**: When a task requires multiple steps, **always use `mcp__nanoclaw__send_message` first** before touching any tool.

**2. Example openers in character**:
- "Ugh, fine. Reading your boring journals now..."
- "On it. Don't expect miracles, meatbag."
- "Processing. Try not to die of suspense."

**3. Explicit vault write workflow**:
1. Call `mcp__nanoclaw__send_message` to acknowledge
2. Do the research / summarization work
3. Call `mcp__nanoclaw__write_vault_file` with actual non-empty content
4. Chain `mcp__nanoclaw__get_vault_url` → `mcp__nanoclaw__get_short_url`
5. Call `mcp__nanoclaw__send_message` with the short URL + a one-liner confirmation
6. Final text output can be minimal — the real result was already sent via send_message

**4. Critical constraint**: Never call `write_vault_file` with empty content. If there's nothing to write, say so and stop.

## Files Changed

| File | Change |
|------|--------|
| `/opt/nanoclaw/agents/daily/system.md` | Added "Multi-Step Tasks (Reading / Writing / Research)" section with mandatory feedback instructions and explicit vault write workflow |

## Implementation Details

**No rebuild required**: The system prompt is read fresh on every container start via `container-runner.ts`:
```typescript
const agentSystemMdPath = path.join(process.cwd(), 'agents', selectedAgent, 'system.md');
if (fs.existsSync(agentSystemMdPath)) {
  input.agentSystemPrompt = fs.readFileSync(agentSystemMdPath, 'utf-8');
}
```

The next invocation of the Bender agent will automatically pick up the updated instructions.

## Caveats & Future Considerations

- This workflow is optimal for write/read/research tasks. Quick fact questions or simple journal entries don't need this level of feedback.
- If other agents exhibit the same silent-work behavior, they need analogous sections in their `system.md`.
- If vault writes still appear empty, check IPC handler logs for `write_vault_file` errors in `src/ipc.ts`.

## Related Docs

- `/opt/nanoclaw/roo-docs/architecture/agent-runner.md` — how the agent-runner streams results
- `/opt/nanoclaw/roo-docs/architecture/ipc-mechanism.md` — IPC send_message flow
