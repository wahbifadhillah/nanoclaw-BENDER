# Troubleshooting & Debugging Findings

This document tracks significant debugging sessions, root cause analyses, and remediation steps for complex issues encountered in NanoClaw.

---

## Corrupted Session Transcript (Parallel Tool Calls with Gemini)

**Date**: 2026-02-28
**Category**: debug
**Affects**: `src/container-runner.ts`, Claude Code session management, multi-model support

### Summary

Every container run failed with "Claude Code process exited with code 1" when resuming a session that was created by Gemini (via OpenRouter). The root cause was a corrupted transcript where parallel tool calls had mismatched tool results — the Claude SDK's `ensureToolResultPairing` function detected the imbalance but crashed during repair. This reveals a compatibility issue when non-Anthropic models (Gemini, etc.) are used with Claude Code's session resumption.

### Context / Problem

**Symptoms observed**:
- All container logs showed: `[agent-runner] Result #1: subtype=error_during_execution`
- Followed by: `[agent-runner] Agent error: Claude Code process exited with code 1`
- The session was stuck retrying the same ID: `12f4fd27-a8f0-411c-889c-dbf1c4c26b97`
- Crucially: a `type=result` message arrived **before** `type=system/init`, indicating the session never successfully initialized on resume

**What was being attempted**:
Resuming a container with a stored session ID for the `main` group, expecting Claude Code to load the prior transcript and continue work.

**Observable behavior**:
- Container started without EACCES permission errors (the prior permission fix worked)
- Claude Code subprocess crashed immediately
- The same session ID was retried on every run, indicating the database still had the reference
- No meaningful error in `stdout`/`stderr` — only the agent-runner's generic "exited with code 1"

### Investigation Steps

1. **Ruled out infrastructure issues**: Verified LiteLLM proxy was healthy with all 5 endpoints up. Not an API connectivity problem.

2. **Verified model configuration**: Confirmed `settings.json` correctly specified `model: google/gemini-2.5-flash-lite` through OpenRouter. Configuration was correct.

3. **Located the debug log**: Found `/opt/nanoclaw/data/sessions/main/.claude/debug/12f4fd27-a8f0-411c-889c-dbf1c4c26b97.txt` — this file logs every Claude Code internal event.

4. **Discovered the real error**: The debug log contained:
   ```
   [ERROR] ensureToolResultPairing: repaired missing tool_result blocks (141 -> 141 messages)
   ```
   This indicated the session transcript was malformed: it had unmatched tool calls and results.

5. **Analyzed the transcript**: Examined `/opt/nanoclaw/data/sessions/main/.claude/projects/-workspace-group/12f4fd27-a8f0-411c-889c-dbf1c4c26b97.jsonl` and found multiple instances of:
   - `[17] assistant(tool_uses=[dump_tasks, send_message])` → `[18] user(tool_results=[send_message])` — 2 calls, only 1 result
   - `[114] assistant(tool_uses=[save_journal_A, save_journal_B, save_journal_C])` → `[115] user(tool_results=[save_journal_C])` — 3 calls, only 1 result
   - `[129] assistant(tool_uses=[Read_A, Read_B, Read_C])` → `[130] user(tool_results=[Read_C])` — 3 calls, only 1 result

### Root Cause / Key Discovery

**The Problem**: When Gemini (via OpenRouter) makes parallel tool calls, the response IDs use a `gen-` prefix instead of Anthropic's `msg_` prefix. During transcript recording or initial session setup, **only the last (or first) tool result in a parallel batch was recorded**, leaving other tool calls unanswered.

**Why it crashed on resume**: Claude Code's session resumption validates the message pairing when loading the transcript. It detected that assistant messages contained N tool uses but only M < N tool results. The `ensureToolResultPairing` repair function attempted to fix the imbalance but either:
- Corrupted the transcript further during repair, OR
- Attempted to submit a malformed transcript to the API, which rejected it

The subprocess exited with code 1 during this error handling, before ever sending the `system/init` message to the agent-runner.

**Why this matters**:
- Anthropic's Claude models always return sequential tool calls (one `tool_use` per message), so the issue never manifested.
- Gemini and other models that return parallel tool calls expose this recording/validation gap.
- The session becomes permanently corrupted and cannot be resumed.

### Solution / Implementation

#### Immediate Fix (for the stuck session)

Performed these steps to recover:

1. **Backed up the corrupted transcript**:
   ```bash
   mv /opt/nanoclaw/data/sessions/main/.claude/projects/-workspace-group/12f4fd27-a8f0-411c-889c-dbf1c4c26b97.jsonl \
      /opt/nanoclaw/data/sessions/main/.claude/projects/-workspace-group/12f4fd27-a8f0-411c-889c-dbf1c4c26b97.jsonl.corrupted
   ```

2. **Cleared the session ID from the database**:
   ```javascript
   const Database = require('better-sqlite3');
   const db = new Database('/opt/nanoclaw/store/messages.db');
   db.prepare('DELETE FROM sessions WHERE group_folder = ?').run('main');
   db.close();
   ```

3. **Next container run**:
   - Claude Code detected no prior session
   - Started a fresh session with a new ID
   - Container ran successfully

#### Debugging Path for Future Occurrences

When you encounter `error_during_execution` + "Claude Code process exited with code 1":

1. **Check the debug log** (most important step):
   ```bash
   # Find the session ID from the database first:
   sqlite3 /opt/nanoclaw/store/messages.db "SELECT session_id FROM sessions WHERE group_folder = 'main'"

   # Then read the debug log:
   cat /opt/nanoclaw/data/sessions/main/.claude/debug/<session-id>.txt
   ```

2. **Look for `ensureToolResultPairing` errors** — they indicate a corrupted transcript:
   ```bash
   grep -i "ensureToolResultPairing\|tool_result" /opt/nanoclaw/data/sessions/main/.claude/debug/<session-id>.txt
   ```

3. **Examine the transcript** for mismatched tool calls and results:
   ```bash
   # Count tool_uses vs tool_results per message:
   cat /opt/nanoclaw/data/sessions/main/.claude/projects/-workspace-group/<session-id>.jsonl | \
     jq -r 'select(.content) | "\(.role): \(.content | length) content items"'
   ```

4. **Clear the session**:
   - Back up the `.jsonl` file (for post-mortem analysis if needed)
   - Delete the session from the database
   - Next run will create a fresh session

### Files Changed

| File | Change |
|------|--------|
| `/opt/nanoclaw/data/sessions/main/.claude/projects/-workspace-group/12f4fd27-a8f0-411c-889c-dbf1c4c26b97.jsonl` | Backed up as `.corrupted` (session data was unrecoverable) |
| `/opt/nanoclaw/store/messages.db` (sessions table) | Deleted row where `group_folder = 'main'` to allow fresh session creation |

### Caveats & Future Considerations

#### Design Issue: Non-Anthropic Model Support
- **Current limitation**: Claude Code's session management assumes Anthropic's strict sequential tool call model. Gemini and other models that return parallel tool calls are not properly handled.
- **What needs fixing**: The session transcript recording logic (likely in the Claude Code SDK or OpenRouter integration) needs to handle parallel tool calls correctly, recording all results regardless of model.
- **Workaround for now**: If using Gemini or similar models, monitor the debug logs regularly. If a session becomes corrupted, clear it and start fresh.

#### Session Corruption Detection
- **Opportunity**: Add a health check that validates the session transcript before resumption. Flag corrupted sessions early (before container spawn) so they can be cleared automatically.
- **Benefit**: Users wouldn't experience the confusing "process exited with code 1" error.

#### Debug Log Invaluable
- **Key insight**: The `/opt/nanoclaw/data/sessions/<group>/.claude/debug/<session-id>.txt` file is the **primary source of truth** for diagnosing Claude Code subprocess crashes. It contains API calls, errors, and internal state.
- **Recommendation**: Document this file's location prominently in troubleshooting guides.

### Related Findings

- `debug-container-session-subdirectory-permissions.md` — EACCES permission errors on container restarts (fixed in this session by chmod logic, but initially masked this deeper issue)

---

## Agent Teams Teammates Killed Mid-Work Due to Premature Stream End

**Date**: 2026-02-28
**Category**: debug
**Affects**: `container/agent-runner/src/index.ts` (line 492), `docs/SDK_DEEP_DIVE.md` (referenced architectural context)

### Summary

Agent teams (multi-agent swarm scenarios like bender orchestrating professor for research + amy for review) were failing because teammates were being killed immediately after the first result message arrived. Root cause: `stream.end()` was called on the first result, which closed stdin to the CLI subprocess, triggering an automatic shutdown sequence that terminated in-progress teammates.

### Context / Problem

When an agent team scenario was triggered (e.g., bender assembling teammates for deep research and tech review work), the teammates would not complete their tasks. Instead, they would fail mid-work as if they were being forcefully shut down.

**Observed symptoms:**
- Bender successfully triggers agent team assembly
- Professor and Amy are spawned and start working
- Before completing their work, the process exits
- Error message indicates teammates were shut down prematurely
- Parent agent (bender) cannot access the results from teammates

### Investigation Steps

1. **Symptom identification**: Confirmed teammates were being killed, not failing due to execution errors or resource constraints
2. **Process flow analysis**: Examined the agent-runner query loop in `container/agent-runner/src/index.ts` to understand when teammates are spawned and when stdin is managed
3. **Stream lifecycle investigation**: Traced the `MessageStream` from SDK through the CLI stdin polling loop
4. **Shutdown sequence discovery**: Found that CLI polling loop detects stdin closed while teammates are still active, then injects a shutdown prompt
5. **Root cause isolation**: Located `stream.end()` call on first result message (line 492), which was closing stdin prematurely

### Root Cause / Key Discovery

The agent-runner was calling `stream.end()` immediately upon receiving the first `result` message from the SDK. This caused:

1. **Stream closure**: `stream.end()` closes the underlying stdin to the CLI subprocess
2. **AsyncIterable completion**: The CLI's polling loop (which reads from stdin) detects the stream has completed
3. **Shutdown trigger**: CLI injects a shutdown prompt when it detects stdin closed but teammates are still active
4. **Cascade termination**: Leader (bender) receives shutdown directive, which causes it to shut down all active teammates
5. **Data loss**: Professor and Amy are killed before completing work, no results are returned

**Why this was wrong:**

The `MessageStream` was specifically designed to prevent this exact scenario (documented as the `isSingleUserTurn` problem in `docs/SDK_DEEP_DIVE.md`). The intent is:
- First `result` → leader processes it and spawns teammates
- Teammates work while leader waits
- Second (or more) `result` messages arrive as teammates complete
- Only after all work is done should the stream close

By calling `stream.end()` on the first result, the code was undoing the architectural fix that `MessageStream` provides.

### Solution / Implementation

**Change made in `container/agent-runner/src/index.ts`:**

Removed the `stream.end()` call from the `message.type === 'result'` handler. The stream should remain open to allow teammates to send additional results while they work.

**Before (line 492):**
```typescript
if (message.type === 'result') {
  const result = message.result;
  stream.end();  // ❌ WRONG: Closes stdin prematurely, kills teammates
  return result;
}
```

**After:**
```typescript
if (message.type === 'result') {
  const result = message.result;
  // stream.end() must NOT be called here—it would close stdin while teammates are active.
  // The stream stays open to allow teammates to send additional results during their work.
  // Cleanup is handled by the host's idle timeout (_close sentinel via IPC, 30 min after last output)
  // and IPC follow-up messages that are polled during the query via pollIpcDuringQuery.
  return result;
}
```

**Why this works:**

The agent-runner's query loop already handles IPC messages during a running query via `pollIpcDuringQuery()`. This means:
- While the leader waits for teammates, the host can send IPC follow-ups
- The stream stays open, stdin remains readable
- CLI polling loop does not detect premature closure
- Teammates run to completion
- Final results are collected and returned

Cleanup when work is truly done:
- Host-side idle timeout (30 minutes after last output) sends `_close` sentinel via IPC
- CLI polling loop receives `_close`, knows all work is done, gracefully exits
- No premature termination of active teammates

### Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Removed `stream.end()` from result message handler (line 492); added explanatory comment about why it must stay open for agent teams |

### Caveats & Future Considerations

1. **Stream lifecycle assumption**: This fix relies on the host-side idle timeout (`_close` sentinel) to properly clean up after agent teams complete. If the idle timeout is disabled or not working, the stream may stay open indefinitely.

2. **Performance with long-running teams**: Agent teams that take longer than 30 minutes to complete will be closed by the idle timeout. For truly long-running scenarios, the idle timeout may need adjustment.

3. **Error handling**: If an error occurs while teammates are working, ensure it is properly propagated to the leader so teammates are shut down cleanly (not via premature `stream.end()`).

4. **Monitoring**: Watch for cases where agents remain spawned longer than expected after completing work, which would indicate the idle timeout is not triggering.

### Related Findings

- **Architecture reference**: `docs/SDK_DEEP_DIVE.md` — Contains the `isSingleUserTurn` problem documentation that explains why `MessageStream` was designed to stay open
- **Agent teams concept**: `docs/REQUIREMENTS.md` — Original design for multi-agent teams and leadership handoff

---

### Key Debugging Commands Reference

```bash
# Find current session ID:
sqlite3 /opt/nanoclaw/store/messages.db "SELECT group_folder, session_id FROM sessions"

# Read Claude Code's debug log for a session:
cat /opt/nanoclaw/data/sessions/<group>/.claude/debug/<session-id>.txt | tail -50

# List available sessions:
ls -lh /opt/nanoclaw/data/sessions/<group>/.claude/projects/-workspace-group/

# Back up and clear a corrupted session:
mv /opt/nanoclaw/data/sessions/<group>/.claude/projects/-workspace-group/<session-id>.jsonl{,.corrupted}
sqlite3 /opt/nanoclaw/store/messages.db "DELETE FROM sessions WHERE group_folder = '<group>'"
```
