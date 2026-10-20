# Connect your agent

Kenning adds small hooks to your agent's **personal** settings file and keeps that file out of git for you.

| Agent | Settings file |
|---|---|
| Claude Code | `.claude/settings.local.json` |
| Codex | `.codex/hooks.json` (run `/hooks` in Codex once to trust them) |
| Cursor | `.cursor/hooks.json` |

- **When you send a prompt:** Kenning notes that the agent started working.
- **When the agent edits a file:** Kenning records what the file looked like before.
- **When the agent is about to finish:** any changes you flagged are handed back to it.

Nothing else in your settings changes. **Kenning: Disconnect an agent…** removes the hooks again.
