# Snapshot and Refs

Compact element references that reduce context usage dramatically for AI agents.

## How Refs Work

Traditional approach:
```
Full DOM/HTML → AI parses → CSS selector → Action (~3000-5000 tokens)
```

agent-browser approach:
```
Compact snapshot → @refs assigned → Direct interaction (~200-400 tokens)
```

## The Snapshot Command

```bash
agent-browser snapshot -i   # Interactive elements only — RECOMMENDED
agent-browser snapshot      # Full accessibility tree
```

### Snapshot Output Format

```
@e1 [header]
  @e2 [nav]
    @e3 [a] "Home"
    @e4 [a] "Products"
  @e5 [button] "Sign In"

@e6 [main]
  @e7 [form]
    @e8 [input type="email"] placeholder="Email"
    @e9 [input type="password"] placeholder="Password"
    @e10 [button type="submit"] "Log In"
```

## Ref Lifecycle — IMPORTANT

Refs are invalidated when the page navigates or DOM changes significantly.

```bash
agent-browser snapshot -i       # @e1 is "Next" button
agent-browser click @e1         # Triggers navigation
agent-browser wait --load networkidle
agent-browser snapshot -i       # MUST re-snapshot — @e1 is now something else
```

## Best Practices

**Always snapshot before interacting:**
```bash
agent-browser open https://example.com
agent-browser wait --load networkidle
agent-browser snapshot -i        # Get refs first
agent-browser click @e3          # Then use them
```

**Re-snapshot after navigation:**
```bash
agent-browser click @e5          # Link click → new page
agent-browser wait --load networkidle
agent-browser snapshot -i        # Fresh refs for new page
```

**Re-snapshot after dynamic changes (dropdowns, modals):**
```bash
agent-browser click @e1          # Opens dropdown
agent-browser snapshot -i        # Dropdown items now visible
agent-browser click @e7          # Select item
```

**Snapshot a specific region (complex pages):**
```bash
agent-browser snapshot @e9       # Only snapshot inside @e9
```

## Ref Notation

```
@e1 [tag type="value"] "text content" placeholder="hint"
│    │                  │              └─ Additional attributes
│    │                  └─ Visible text
│    └─ HTML tag + key attributes
└─ Unique ref ID (local to current page state)
```

## Troubleshooting

**"Ref not found"** — page changed, re-snapshot:
```bash
agent-browser snapshot -i
```

**Element not in snapshot** — scroll down or wait for dynamic content:
```bash
agent-browser scroll down 1000
agent-browser snapshot -i
```

**Too many elements** — scope to a container:
```bash
agent-browser snapshot @e5
```
