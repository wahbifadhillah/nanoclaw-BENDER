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
