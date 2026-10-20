# Changelog

## 0.3.0

- **Full review in an editor tab** (⤢ on a card, `E`, or “Kenning: Open full review”): every changed file in a list, full-width diffs side by side or unified (`V`), and the whole file around a change (`W`). Restores itself when VS Code restarts.
- **Codex and Cursor connect natively.** Codex hooks (`.codex/hooks.json`) record each file just before `apply_patch` lands; Cursor hooks (`.cursor/hooks.json`) rebuild the original from the edit. Flags reach both agents, and the deck shows which agent is working.
- **History** (`H`): understanding score and reviews per day over 30 days, best streak, issues flagged, with a table view.
- **Copy review summary**: a Markdown summary of reviewed, flagged, high-risk and skipped changes, for pull requests.
- Fix: changing a workspace setting no longer shows `.vscode/settings.json` as an agent change.
- Fix: a card no longer replays its entrance animation on every update.

## 0.2.0

- New typeface: Newsreader, an open-license serif, for titles, questions and scores.
- Syntax highlighting in diffs, using your theme's colours.
- Exact-change highlighting inside edited lines.
- “Share today”: saves a 1200×630 image of your understanding score.
- Getting Started walkthrough.

## 0.1.0

- First release: review cards for agent changes, with local risk flags, AI summaries and quick questions, an understanding score and streak, and flags that Claude Code addresses before it finishes.
- Claude Code integration through hooks; any other agent is supported by watching file changes.
