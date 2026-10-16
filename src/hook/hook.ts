// The Claude Code hook. Claude Code runs it (with the event as JSON on stdin)
// on UserPromptSubmit, PostToolUse for file edits, and Stop. It records what
// the agent changed and hands the developer's flags back to the agent.
// It must never break the agent: every failure exits 0 silently.

import path from "node:path";
import { formatFlagsForAgent } from "../core/flags";
import { Store } from "../services/store";

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
  tool_response?: { originalFile?: string | null; type?: string };
  stop_hook_active?: boolean;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export async function run(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  // Kenning's own background calls to Claude Code must not record anything.
  if (env.KENNING_INTERNAL) return "";
  const input = JSON.parse(raw) as HookInput;
  const root = env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!root) return "";
  const store = new Store(root);
  const t = new Date().toISOString();
  const session = input.session_id;

  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      store.appendEvent({ t, type: "turn-start", session });
      const flags = store.takePendingFlags();
      if (!flags.length) return "";
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: formatFlagsForAgent(flags) },
      });
    }

    case "PostToolUse": {
      if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return "";
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (!target) return "";
      const rel = store.rel(path.resolve(input.cwd ?? root, target));
      if (!rel) return "";
      const response = input.tool_response ?? {};
      // Claude Code reports the file's content before this edit. A brand-new
      // file has no original. Only the first edit since the last review counts.
      if ("originalFile" in response) {
        const original = response.originalFile;
        store.setBaseline(rel, typeof original === "string" && !(response.type === "create" && original === "") ? original : null);
      }
      store.appendEvent({ t, type: "edit", file: rel, tool: input.tool_name, session });
      return "";
    }

    case "Stop": {
      const flags = store.takePendingFlags();
      store.appendEvent({ t, type: "turn-end", session, blocked: flags.length || undefined });
      if (!flags.length) return "";
      // Blocking the stop makes the agent keep going and address the flags now.
      return JSON.stringify({ decision: "block", reason: formatFlagsForAgent(flags) });
    }
  }
  return "";
}

if (require.main === module) {
  readStdin()
    .then((raw) => run(raw))
    .then((out) => {
      if (out) process.stdout.write(out);
    })
    .catch(() => {})
    .finally(() => process.exit(0));
}
