# IPC Mechanism

The Inter-Process Communication (IPC) mechanism ([`src/ipc.ts`](src/ipc.ts)) allows containerized agents to request actions from the host application.

## Design: File-Based IPC

NanoClaw uses a simple, robust file-based IPC system. This avoids the complexity of network sockets or shared memory and works reliably across Docker volume mounts.

1.  **Request**: The agent writes a JSON file to a specific subdirectory in `/workspace/ipc/`.
2.  **Detection**: The host's `IPCWatcher` uses `fs.watch` (or polling) to detect new files in the host-side IPC directory.
3.  **Execution**: The host reads the file, performs the requested action, and deletes the file.
4.  **Response (Optional)**: For requests that require a response, the host writes a result file back to the IPC directory, which the agent then reads.

## IPC Subdirectories

- `messages/`: For sending outbound messages to the chat channel.
- `tasks/`: For creating, updating, or deleting scheduled tasks.
- `input/`: For registering new groups or syncing metadata.
- `*_results/`: Directories where the host writes responses to specific agent requests.

## Key Components

### IPC Watcher ([`src/ipc.ts`](src/ipc.ts))
Runs on the host. It monitors the `messages/`, `tasks/`, and `input/` directories. When a file is detected, it dispatches the request to the appropriate handler (e.g., `channel.sendMessage`, `db.createTask`).

### IPC MCP Tools ([`container/agent-runner/src/ipc-mcp-stdio.ts`](container/agent-runner/src/ipc-mcp-stdio.ts))
Runs inside the container. These tools provide a high-level API for the agent to perform IPC operations without manually handling files.

## Security
Each group has its own isolated IPC directory. An agent in one group cannot write to the IPC directory of another group, preventing cross-group privilege escalation.
