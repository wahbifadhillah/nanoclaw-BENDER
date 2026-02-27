# Communication Channels

Channels ([`src/channels/`](src/channels/)) are responsible for interfacing with external messaging platforms. They handle authentication, message reception, and message delivery.

## Supported Channels

### WhatsApp ([`src/channels/whatsapp.ts`](src/channels/whatsapp.ts))
- Uses the `baileys` library to interface with the WhatsApp Web API.
- Handles QR code authentication.
- Syncs group metadata and stores incoming messages in the database.
- Supports typing indicators and read receipts.

### Telegram ([`src/channels/telegram.ts`](src/channels/telegram.ts))
- Uses the `grammy` library to interface with the Telegram Bot API.
- Supports a "Bot Pool" ([`TELEGRAM_BOT_POOL`](src/config.ts)) to allow agents to respond as different bot identities within the same group.
- Handles webhook or polling for message reception.

## Channel Interface

All channels implement a common interface (defined in [`src/types.ts`](src/types.ts)):

- `connect()`: Establishes connection to the platform.
- `disconnect()`: Closes the connection.
- `sendMessage(jid, text)`: Sends a message to a specific chat.
- `setTyping(jid, typing)`: (Optional) Sets the typing indicator.

## Message Handling Flow

1.  **Reception**: The channel receives a message from the platform.
2.  **Storage**: The channel calls `onMessage` (provided by the host) which uses `storeMessage()` in [`src/db.ts`](src/db.ts) to persist the message.
3.  **Metadata**: The channel updates chat metadata (name, last activity) via `onChatMetadata`.
