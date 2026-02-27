# Agent Tool Architecture (MCP & Task IPC)

This document describes how high-level agent commands (like `+journal` and `+dump`) are implemented using a combination of **MCP Tools**, **File-based IPC**, and **Host Subprocesses**.

## Overview

When an agent (running in a Docker container) needs to perform a privileged operation on the host (like writing to a vault or shortening a URL), it uses a multi-layer communication path:

1.  **Agent SDK**: The agent calls an MCP tool (e.g., `mcp__nanoclaw__save_journal`).
2.  **MCP Server**: The MCP server inside the container ([`container/agent-runner/src/ipc-mcp-stdio.ts`](container/agent-runner/src/ipc-mcp-stdio.ts)) receives the call and writes a **Task IPC file**.
3.  **IPC Bridge**: The task file is written to a shared volume mount, appearing on the host.
4.  **Host IPC Watcher**: The host ([`src/ipc.ts`](src/ipc.ts)) detects the task and spawns a **Subprocess**.
5.  **Subprocess**: A specialized script (e.g., `.claude/skills/journal/journal.ts`) performs the actual work (file I/O, API calls) and returns a JSON result.
6.  **Result IPC**: The host writes the result back to a specific results directory in the shared volume.
7.  **MCP Polling**: The MCP server inside the container polls for the result file, reads it, and returns the response to the agent.

## Data Flow Diagram

```mermaid
sequenceDiagram
    participant Agent as Agent (Container)
    participant MCP as MCP Server (Container)
    participant IPC as IPC Directory (Shared)
    participant Host as IPC Watcher (Host)
    participant Script as Subprocess (Host)

    Agent->>MCP: Call mcp__nanoclaw__save_journal
    MCP->>IPC: Write tasks/{taskId}.json
    Note over MCP,IPC: Polling for results/{taskId}.json
    Host->>IPC: Detect new task
    Host->>Script: Spawn (with secrets via stdin)
    Script-->>Host: Return JSON result (stdout)
    Host->>IPC: Write results/{taskId}.json
    IPC-->>MCP: Result file detected
    MCP->>Agent: Return tool result
    Agent->>User: Reply with verbatim result
```

## Chain Tooling Pattern

Some complex tools use an atomic "chaining" pattern within the MCP handler to separate concerns. For example, `save_journal` doesn't just write a file; it also generates a URL and shortens it.

```text
MCP handler (ipc-mcp-stdio.ts)
  │
  ├─ ipcCall('journal')     → journal.ts (Writes file, returns vaultPath)
  ├─ ipcCall('vault_url')   → get_vault_url.ts (Converts path to full URL)
  └─ ipcCall('short_url')   → get_short_url.ts (Shortens URL via Shlink)
```

This allows individual host scripts to remain simple and focused on a single task (e.g., `journal.ts` only handles file I/O, not URL logic).

## Key Components

### 1. MCP Server ([`container/agent-runner/src/ipc-mcp-stdio.ts`](container/agent-runner/src/ipc-mcp-stdio.ts))
Registers tools and manages the IPC lifecycle (writing tasks, polling for results). It uses an `ipcCall()` helper to abstract the file-based communication.

### 2. IPC Dispatcher ([`src/ipc.ts`](src/ipc.ts))
The `processTaskIpc()` function on the host dispatches tasks based on their `type`. It handles secret injection by reading from `.env` and passing them to subprocesses via `stdin`.

### 3. Host Subprocesses
Specialized TypeScript scripts run via `tsx`.
- **Vault Writers**: `journal.ts`, `dump.ts`, `write_vault_file.ts`.
- **Utility Tools**: `get_vault_url.ts`, `get_short_url.ts`.

## Debugging & Troubleshooting

If a tool like `+journal` or `+dump` fails, check the following layers:

### Layer 1: Agent/Model Level
- **"Unknown skill" error**: The agent might be trying to use the `Skill()` tool instead of the MCP tool. Ensure the system prompt explicitly directs the agent to use `mcp__nanoclaw__*` tools.
- **Poisoned Session**: If an agent fails once, it may "learn" that it doesn't have the tool. Reset the session in the database and archive the `.jsonl` log to force a fresh start.

### Layer 2: Container/MCP Level
- **Permission Denied**: Ensure the `*_results/` directories exist in the group's IPC directory and are writable (777) by the container user (UID 1000).
- **Stale Code**: Changes to `ipc-mcp-stdio.ts` require a container rebuild (`./container/build.sh`) and a sync to the group's session directory.

### Layer 3: Host/IPC Level
- **`ts-node: not found`**: The host uses `tsx` to run scripts. Ensure the absolute path to `node_modules/.bin/tsx` is used in `spawn()` calls.
- **Timezone Issues**: If timestamps are wrong (UTC instead of local), ensure the `TZ` environment variable is NOT passed as an empty string to the subprocess, allowing it to fall back to `/etc/localtime`.

### Layer 4: Subprocess Level
- **Secrets**: Verify that the required secrets (e.g., `NOTES_URL`, `SHLINK_API_KEY`) are present in the host's `.env` and whitelisted in `src/ipc.ts`.
