---
name: email
description: Read the email inbox. Use when the user asks to check, read, or summarise emails. The inbox is available as a JSON file updated on each poll cycle.
allowed-tools: Bash(cat:*)
---

# Reading Email

The inbox is available at `/workspace/ipc/inbox.json`. It contains up to 20 recent received emails, newest first.

```bash
cat /workspace/ipc/inbox.json
```

Each entry has:
- `id` — message ID
- `from` — sender address
- `from_name` — sender display name
- `subject` — email subject
- `body` — email body (quoted replies stripped)
- `timestamp` — ISO 8601 timestamp

## Example: summarise latest email

```bash
cat /workspace/ipc/inbox.json
```

Parse the first entry (index 0) — that's the most recent email.

## Notes

- The file is updated every 30 seconds when new mail arrives
- If the file doesn't exist, no emails have been received yet since startup
- To **reply** to an email, use `mcp__nanoclaw__send_message` — the email channel will send it back to the sender via SMTP automatically
