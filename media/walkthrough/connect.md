# Connect Claude Code

Kenning adds three small hooks to `.claude/settings.local.json`, your **personal** Claude Code settings. Kenning keeps that file out of git for you.

- **When you send a prompt:** Kenning notes that the agent started working.
- **When Claude edits a file:** Kenning records what the file looked like before.
- **When Claude is about to finish:** any changes you flagged are handed back to it.

Nothing else in your settings changes. **Kenning: Disconnect from Claude Code** removes the hooks again.
