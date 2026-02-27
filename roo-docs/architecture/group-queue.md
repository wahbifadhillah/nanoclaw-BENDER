# Group Queue

The Group Queue ([`src/group-queue.ts`](src/group-queue.ts)) manages the lifecycle of agent processes and ensures serialized execution per chat group.

## Key Responsibilities

### 1. Concurrency Control
The queue ensures that only one agent container is running for a specific `chatJid` at any given time. This prevents race conditions and conflicting responses.

### 2. Process Registration
When a container is spawned, it is registered with the queue. The queue tracks the `ChildProcess` object, the container name, and the group folder.

### 3. Message Piping
If a message arrives for a group that already has an active container, the queue handles writing that message to the container's `stdin`. This allows for low-latency multi-turn conversations without the overhead of restarting containers.

### 4. Idle Timeout & Cleanup
The queue monitors agent activity. If an agent remains idle for longer than the [`IDLE_TIMEOUT`](src/config.ts), the queue closes the container's `stdin`, allowing it to exit gracefully.

### 5. Shutdown Handling
During system shutdown, the queue ensures all active containers are stopped gracefully before the host process exits.

## Internal State

- `activeProcesses`: A map of `chatJid` to the currently running process and its metadata.
- `queue`: A set of JIDs that are pending an agent execution check.
