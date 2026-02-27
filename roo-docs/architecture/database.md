# Database Component

The Database component ([`src/db.ts`](src/db.ts)) manages all persistent state for NanoClaw using SQLite (via `better-sqlite3`).

## Schema Overview

The database consists of several key tables:

### `chats`
Stores metadata about all discovered chats.
- `jid`: Unique identifier for the chat (e.g., WhatsApp JID, Telegram ID).
- `name`: Display name of the chat.
- `last_message_time`: Timestamp of the most recent message.
- `channel`: The communication channel (whatsapp, telegram, discord).
- `is_group`: Boolean indicating if the chat is a group.

### `messages`
Stores the actual content of messages for registered groups.
- `id`: Message ID from the channel.
- `chat_jid`: Reference to the chat.
- `sender`: ID of the message sender.
- `content`: The text content of the message.
- `timestamp`: When the message was sent.
- `is_from_me`: Boolean indicating if the message was sent by the bot.
- `is_bot_message`: Boolean indicating if the message is a bot response (used for filtering context).

### `registered_groups`
Groups that NanoClaw is actively monitoring and responding to.
- `jid`: Chat JID.
- `folder`: The dedicated directory name for this group's data.
- `trigger_pattern`: Regex pattern that triggers the agent.
- `requires_trigger`: Whether the agent only responds to triggers or all messages.

### `scheduled_tasks`
Tasks scheduled by agents to run at specific times.
- `id`: Unique task ID.
- `prompt`: The prompt to send to the agent when the task runs.
- `schedule_type`: cron, interval, or once.
- `schedule_value`: The schedule definition.
- `next_run`: Timestamp of the next scheduled execution.

### `router_state`
Key-value store for system-wide state (e.g., `last_timestamp` for message polling).

### `sessions`
Maps group folders to their active Claude Code session IDs.

## Key Functions

- `initDatabase()`: Initializes the SQLite database and applies migrations.
- `storeMessage()`: Persists a new message to the database.
- `getNewMessages()`: Retrieves messages since a given timestamp for a set of JIDs.
- `getMessagesSince()`: Retrieves all messages for a specific chat since a timestamp (used for agent context).
- `setRegisteredGroup()`: Registers a new group for monitoring.
