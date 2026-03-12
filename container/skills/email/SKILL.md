---
name: email
description: Read the email inbox and send emails. Use when the user asks to check, read, summarise, reply to, or send emails.
allowed-tools: Bash(cat:*), mcp__nanoclaw__send_email
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

## Sending Email

Use `mcp__nanoclaw__send_email` to send a new email to any address:

```
mcp__nanoclaw__send_email(to="alice@example.com", subject="Hello", body="Hi Alice, ...")
```

To **reply** to a received email, use `mcp__nanoclaw__send_message` — the email channel automatically threads the reply back to the original sender.

## Notes

- The inbox file is updated every 30 seconds and also synced fresh when an email-related question is detected
- If the file doesn't exist, no emails have been received yet since startup
