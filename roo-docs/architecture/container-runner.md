# Container Runner

The Container Runner ([`src/container-runner.ts`](src/container-runner.ts)) is responsible for spawning and managing the Docker containers that host the agents.

## Container Lifecycle

### 1. Configuration & Mounts
Before spawning, the runner determines the necessary volume mounts:
- **Project Root**: Mounted read-only to `/workspace/project` (Main group only).
- **Group Folder**: Mounted writable to `/workspace/group`.
- **IPC Directory**: Mounted writable to `/workspace/ipc`.
- **Session State**: Mounted writable to `/home/node/.claude`.
- **Agent Runner Source**: Mounted writable to `/app/src` (allows for host-side tool updates).

### 2. Spawning
The runner uses `spawn` to execute the Docker (or Orbstack) CLI. It passes environment variables like `TZ` (timezone) and `ANTHROPIC_BASE_URL` (pointing to the host's LiteLLM proxy).

### 3. Input Delivery
The initial prompt, session ID, and other metadata are delivered to the agent via `stdin` as a JSON object.

### 4. Output Parsing
The runner monitors `stdout` for specific sentinel markers:
- `---NANOCLAW_OUTPUT_START---`
- `---NANOCLAW_OUTPUT_END---`

JSON objects between these markers are parsed as `ContainerOutput`, which can contain the agent's response text or a new session ID.

### 5. Resource Limits & Timeouts
- **Hard Timeout**: Containers are killed if they exceed the `CONTAINER_TIMEOUT`.
- **Output Limit**: `stdout` and `stderr` are truncated if they exceed `CONTAINER_MAX_OUTPUT_SIZE` to prevent memory exhaustion.

## Security Features
- **Read-only Mounts**: Prevents agents from modifying the host application code.
- **User Mapping**: Runs the container as the host user's UID/GID to ensure correct file permissions on bind mounts.
- **Secret Management**: Secrets (API keys) are passed via `stdin` and never written to the container's disk.

## Known Issues & Gotchas

### Session Directory Subdirectory Permissions (EACCES Crash)

Containers can crash immediately on second and subsequent runs with `EACCES: permission denied` when the Claude SDK tries to initialize its debug logger.

#### The Problem
The `.claude/` session directory is bind-mounted at `/home/node/.claude` inside the container.
1.  **First Run**: The Claude SDK creates subdirectories like `debug/` and `telemetry/` using the default umask (typically 0o022).
2.  **Host Ownership**: These subdirs are created with mode `0o755` (rwxr-xr-x) and are owned by the host user's UID.
3.  **Subsequent Runs**: The container's `node` user (UID 1000) lacks write permission to these `0o755` directories owned by the host. The SDK fails to initialize, and the container exits silently with code 1.

#### The Fix
`fs.chmodSync()` on a directory does not recurse into children. To fix this, `src/container-runner.ts` (lines 128-138) now performs a shallow recursive chmod before each spawn:

```typescript
fs.chmodSync(groupSessionsDir, 0o777);
for (const entry of fs.readdirSync(groupSessionsDir)) {
  const entryPath = path.join(groupSessionsDir, entry);
  if (fs.statSync(entryPath).isDirectory()) {
    fs.chmodSync(entryPath, 0o777);
  }
}
```

#### Manual Remediation
For existing corrupted session directories, run:
```bash
find /opt/nanoclaw/data/sessions -type d \( -name "debug" -o -name "telemetry" \) -exec chmod 777 {} \;
```

### Session Transcript Corruption (Parallel Tool Calls)

When using non-Anthropic models (Gemini, Claude via third-party, etc.) that support parallel tool calls, session transcripts can become corrupted with mismatched tool call/result pairs. This causes Claude Code to crash on resume with "process exited with code 1".

**Symptoms**:
- Container logs show `error_during_execution` + "Claude Code process exited with code 1"
- A `type=result` message appears before `type=system/init` (session never initialized)
- The same session ID is retried on every run

**How to diagnose**:
1. Find the session ID: `sqlite3 /opt/nanoclaw/store/messages.db "SELECT session_id FROM sessions WHERE group_folder = '<group>'"`
2. Check the debug log: `/opt/nanoclaw/data/sessions/<group>/.claude/debug/<session-id>.txt`
3. Look for `ensureToolResultPairing` errors — this indicates a corrupted transcript

**How to fix**:
1. Back up the transcript: `mv /opt/nanoclaw/data/sessions/<group>/.claude/projects/-workspace-group/<session-id>.jsonl{,.corrupted}`
2. Clear the session: `sqlite3 /opt/nanoclaw/store/messages.db "DELETE FROM sessions WHERE group_folder = '<group>'"`
3. Next container run will create a fresh session

See also: [Troubleshooting & Debugging Findings](troubleshooting.md) for full investigation details.
