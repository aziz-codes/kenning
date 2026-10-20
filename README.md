# Kenning

**Understand the code your AI writes, while it writes it.**

Coding agents like Claude Code, Codex, Cursor and Copilot now write most of the code, often faster than anyone can read it. You end up waiting while the agent works, then approving changes you never really read. Kenning turns that waiting time into a quick, focused review.

While your agent works, every change it makes becomes a short card in the Kenning panel:

- **What changed, in plain English.** One line, plus the likely reason for the change.
- **What looks risky.** Removed tests or checks, deleted error handling, silenced type errors, secrets, new dependencies, shell calls, SQL built from strings, and more. All checks run locally.
- **One quick question.** A 15-second check on what the change actually does. It's not trivia.
- **Flag it, and the agent fixes it.** Write what's wrong and Kenning hands it straight to your agent (Claude Code, Codex or Cursor), which addresses it *before it finishes*. If the agent is idle, it arrives with your next message.

Code on the cards is syntax-highlighted in your theme's colours. In an edited line, only the part that changed lights up, so `1.2 → 1.25` stands out at a glance.

Need more room than the sidebar? Click **⤢** on a card (or press `E`) to open the **full review** in an editor tab:

- **Every changed file** in a list on the left, riskiest changes first.
- **Side by side or unified** diffs at full width (`V`).
- **The whole file** around a change, with the change marked (`W`).
- **History**: your understanding score and reviews over the last 30 days (`H`).
- **Copy review summary**: a Markdown summary of what you reviewed and flagged, ready to paste into a pull request.

Your **understanding score** and daily streak show how much of today's AI code you actually understood. The *lines waiting* counter shows what you haven't looked at yet. **Share today** saves an image of your score, ready to post.

## Getting started

1. Open the **Kenning** panel in the Activity Bar.
2. Click **Connect** for your agent. Kenning adds a few small hooks to your agent's personal settings file and keeps that file out of git:

   | Agent | Hooks file | |
   |---|---|---|
   | Claude Code | `.claude/settings.local.json` | |
   | Codex | `.codex/hooks.json` | Codex only runs hooks you trust: run `/hooks` in Codex once, in a trusted project. |
   | Cursor | `.cursor/hooks.json` | Flags reach Cursor's agent as a follow-up when its turn finishes. |

3. Prompt your agent as usual. Cards appear as it edits files.

Using **Copilot agent mode, Aider** or scripts? You don't need to connect anything. Kenning notices files changed outside the editor and compares them with what they looked like before (or with your last commit). Your own saves and git operations like checkout are ignored. You can also run **Kenning: Review uncommitted changes** at any time.

## Keyboard

| Key | Action |
|---|---|
| `1`–`4` | Answer the question |
| `G` | Got it (mark as understood) |
| `F` | Flag for the agent |
| `S` | Skip |
| `D` | Open the before/after diff |
| `E` | Open the full review in an editor tab |
| `W` | Whole file (full review) |
| `V` | Side by side / unified (full review) |
| `H` | History (full review) |
| `←` `→` | Previous / next change |

## AI questions

Summaries and questions come from **your own Claude Code login** (detected automatically), or from an **Anthropic API key** (**Kenning: Set Anthropic API key**, stored in VS Code's secret storage). Kenning prepares the next few cards in the background while the agent works, so they're ready when you get to them. Each card costs about one cent with the default model (`claude-opus-5-5`, low effort). You can change the model in settings, or set `kenning.ai.provider` to `off`. Without AI you still get the diff, the risk flags and the score.

Kenning's own calls to Claude Code run in an isolated temporary directory, without your project, its hooks or its MCP servers, so they never show up as agent activity.

## Privacy

- Everything Kenning records, including the review log behind History and summaries, stays in a `.kenning/` folder in your project, which is git-ignored automatically.
- Diffs are sent only to the AI provider you chose (your Claude Code, or the Anthropic API with your key). They are never sent to Kenning or any other service.
- Kenning has no telemetry.

## Settings

| Setting | Default | |
|---|---|---|
| `kenning.ai.provider` | `auto` | `auto`, `claudeCode`, `anthropicApi` or `off` |
| `kenning.ai.model` | `claude-opus-5-5` | Model for summaries and questions |
| `kenning.ai.prefetch` | `3` | Cards prepared ahead while the agent works |
| `kenning.claudePath` | `claude` | Path to the Claude Code executable |
| `kenning.watchExternalChanges` | `true` | Create cards for changes made by other agents and tools |
| `kenning.notifyOnFinish` | `true` | Notify when the agent finishes and changes are waiting |

## Commands

**Kenning: Open full review** · **Connect to Claude Code / Codex / Cursor** · **Connect an agent…** · **Disconnect an agent…** · **Review uncommitted changes** · **Copy review summary (for a PR)** · **Set / Remove Anthropic API key** · **Reset understanding stats**

## About

Kenning is built by [aziz-codes](https://github.com/aziz-codes) ([website](https://aziz-dev.vercel.app/)). Found a bug or have an idea? [Open an issue](https://github.com/aziz-codes/kenning/issues) or email [aziz.codes44@gmail.com](mailto:aziz.codes44@gmail.com).
