# Vault Tools

Atomic vault primitives — file I/O and URL utilities. Designed to be chained.

## Tools

### `write_vault_file`
Write or append content to any `.md` file in the vault. The agent decides the format.

**Input:** `vault_path`, `content`, `mode: 'write' | 'append'`
**Output:** `✅ Written to: research/ai-notes.md` (vaultPath for chaining)
**Security:** path-escape validation, `.md` only, 1 MB limit.

### `get_vault_url`
Convert a vault-relative path to a full browser URL via SilverBullet.

**Input:** `vault_path` — e.g., `dumps/my-tag.md`
**Output:** `https://notes.im7try1ng.com/dumps/my-tag.md`

### `get_short_url`
Create a short URL via Shlink for any long URL.

**Input:** `url` — any full URL
**Output:** `https://s.im7try1ng.com/abc123`

## Chain Patterns

**Write + link:**
```
1. mcp__nanoclaw__write_vault_file({ vault_path: "research/ai-notes.md", content: "...", mode: "append" })
   → "✅ Appended to: research/ai-notes.md"

2. mcp__nanoclaw__get_vault_url({ vault_path: "research/ai-notes.md" })
   → "https://notes.im7try1ng.com/research/ai-notes.md"

3. mcp__nanoclaw__get_short_url({ url: "https://notes.im7try1ng.com/research/ai-notes.md" })
   → "https://s.im7try1ng.com/abc123"
```

**URL only (for existing vault files):**
```
1. mcp__nanoclaw__get_vault_url({ vault_path: "dumps/my-tag.md" })
2. mcp__nanoclaw__get_short_url({ url: "..." })
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `NOTES_URL` | SilverBullet public URL base (e.g., `https://notes.im7try1ng.com`) |
| `SHLINK_URL` | Shlink public short URL base (e.g., `https://s.im7try1ng.com`) |
| `SHLINK_API_KEY` | Shlink REST API key |
| `SHLINK` | Shlink internal endpoint `host:port` (e.g., `localhost:8080`) |

## Security

Secrets passed via stdin (never in `process.env`), whitelisted to what each script needs.

## IPC Task Types

| Tool | IPC type | Result dir |
|------|----------|------------|
| `get_vault_url` | `vault_url` | `vault_url_results/` |
| `get_short_url` | `short_url` | `short_url_results/` |

## Files

| File | Role |
|------|------|
| `get_vault_url.ts` | Host subprocess — builds vault URL from path + NOTES_URL |
| `get_short_url.ts` | Host subprocess — calls Shlink API, returns short URL |
