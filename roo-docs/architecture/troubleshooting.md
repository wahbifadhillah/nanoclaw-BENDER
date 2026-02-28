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
