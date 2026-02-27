# Agent Runner

The Agent Runner ([`container/agent-runner/`](container/agent-runner/)) is the code that executes *inside* the Docker container. It acts as the interface between the host and the LLM (Claude Code).

## Responsibilities

### 1. Initialization
Upon startup, the runner reads the configuration JSON from `stdin`. This includes the prompt, session ID, and any secrets.

### 2. Claude Code Orchestration
The runner spawns a `claude` process (Claude Code CLI). It configures the environment to use the provided session ID and routes API calls through the host's LiteLLM proxy.

### 3. Tool Integration (MCP)
The runner provides a set of Model Context Protocol (MCP) tools to the agent. These tools allow the agent to:
- Read and write files in the group folder.
- Interact with the host via IPC (e.g., `send_message`, `schedule_task`).
- Access group-specific snapshots (available groups, current tasks).

### 4. Output Formatting
The runner captures the agent's output and wraps it in the sentinel markers (`---NANOCLAW_OUTPUT_START---`) expected by the host's [`ContainerRunner`](src/container-runner.ts).

### 5. Reasoning Extraction
The runner supports extracting internal reasoning from `<internal>` tags, allowing the agent to "think" before providing a final response to the user.

## Environment
The runner executes in a Node.js environment inside the container. It has access to:
- `/workspace/group`: The writable group-specific directory.
- `/workspace/ipc`: The directory for host communication.
- `/home/node/.claude`: The persistent session state.
