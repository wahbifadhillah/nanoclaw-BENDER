# Message Loop

The Message Loop ([`src/index.ts`](src/index.ts)) is the central orchestrator that moves messages from the database to the agent execution queue.

## Operation

The loop runs continuously at a configurable interval ([`POLL_INTERVAL`](src/config.ts)).

### 1. Polling
It queries the database for all messages across all registered groups that have arrived since the `last_timestamp`.

### 2. Deduplication & Grouping
Messages are grouped by their `chat_jid`. This allows the system to process a batch of messages for a single group in one agent execution.

### 3. Trigger Validation
For groups that require a trigger ([`requiresTrigger`](src/types.ts)), the loop checks if any message in the batch matches the `TRIGGER_PATTERN`. If no trigger is found, the messages are ignored (they remain in the DB as context for future triggers).

### 4. Routing to Queue
- If an agent container is already active for the group, the loop pipes the new messages directly to the container's `stdin` via the [`GroupQueue`](src/group-queue.ts).
- If no container is active, it enqueues a "message check" for that group in the [`GroupQueue`](src/group-queue.ts), which will eventually spawn a new container.

## State Tracking
The loop maintains the `last_timestamp` in the `router_state` table to ensure no messages are processed twice and no messages are missed across restarts.
