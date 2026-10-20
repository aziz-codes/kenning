// The agent hook. Claude Code, Codex and Cursor run it (with the event as JSON
// on stdin) when a prompt is sent, when a file is edited and when the agent
// is about to finish. It records what the agent changed and hands the
// developer's flags back to the agent.
// It must never break the agent: every failure exits 0 silently.
//
//   node .kenning/hook.js                 Claude Code
//   node .kenning/hook.js --agent codex   Codex
//   node .kenning/hook.js --agent cursor  Cursor

import fs from "node:fs";
import path from "node:path";
import { patchTargets, undoEdits, type StringEdit } from "../core/agentEdits";
import { formatFlagsForAgent } from "../core/flags";
import type { AgentId } from "../core/types";
import { Store } from "../services/store";

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: unknown };
  tool_response?: { originalFile?: string | null; type?: string };
  stop_hook_active?: boolean;
  // Cursor
  file_path?: string;
  edits?: StringEdit[];
  status?: string;
}

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CODEX_EDIT_TOOLS = new Set(["apply_patch", "Edit", "Write"]);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function agentFrom(argv: string[]): AgentId {
  const i = argv.indexOf("--agent");
  const name = i >= 0 ? argv[i + 1] : undefined;
  return name === "codex" || name === "cursor" ? name : "claude";
}

/** The project this hook belongs to: the folder that holds .kenning/hook.js. */
function projectRoot(input: HookInput, env: NodeJS.ProcessEnv, scriptDir?: string): string | undefined {
  if (scriptDir && path.basename(scriptDir) === ".kenning") return path.dirname(scriptDir);
  return env.CLAUDE_PROJECT_DIR || env.CURSOR_PROJECT_DIR || input.workspace_roots?.[0] || input.cwd;
}

const readOrNull = (abs: string) => {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

export async function run(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  agent: AgentId = "claude",
  scriptDir?: string,
): Promise<string> {
  // Kenning's own background calls to Claude Code must not record anything.
  if (env.KENNING_INTERNAL) return "";
  const input = JSON.parse(raw) as HookInput;
  const root = projectRoot(input, env, scriptDir);
  if (!root) return "";
  const store = new Store(root);
  const t = new Date().toISOString();
  const session = input.session_id ?? input.conversation_id;
  const relOf = (target: string) => store.rel(path.resolve(input.cwd ?? root, target));
  const edited = (rel: string, tool: string) => store.appendEvent({ t, type: "edit", file: rel, tool, session, agent });

  if (agent === "cursor") {
    switch (input.hook_event_name) {
      case "beforeSubmitPrompt":
        store.appendEvent({ t, type: "turn-start", session, agent });
        return JSON.stringify({ continue: true });

      case "afterFileEdit": {
        const rel = input.file_path && relOf(input.file_path);
        if (!rel) return "";
        if (!store.hasBaseline(rel)) {
          const current = store.readCurrent(rel);
          const edits = input.edits ?? [];
          const original = current === null ? undefined : undoEdits(current, edits);
          const created = edits.length > 0 && edits.every((e) => !e.old_string) && original === "";
          if (original !== undefined) store.setBaseline(rel, created ? null : original);
        }
        edited(rel, "edit");
        return "";
      }

      case "stop": {
        // A stop the developer caused (aborted) or a failure shouldn't restart the agent.
        const flags = input.status === "completed" ? store.takePendingFlags() : [];
        store.appendEvent({ t, type: "turn-end", session, agent, blocked: flags.length || undefined });
        return flags.length ? JSON.stringify({ followup_message: formatFlagsForAgent(flags) }) : "";
      }
    }
    return "";
  }

  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      store.appendEvent({ t, type: "turn-start", session, agent });
      const flags = store.takePendingFlags();
      if (!flags.length) return "";
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: formatFlagsForAgent(flags) },
      });
    }

    case "PreToolUse": {
      // Codex doesn't report a file's previous content, so keep it just before the patch lands.
      if (agent !== "codex" || !input.tool_name || !CODEX_EDIT_TOOLS.has(input.tool_name)) return "";
      for (const target of codexTargets(input)) {
        const rel = relOf(target.path);
        if (rel) store.setBaseline(rel, readOrNull(store.abs(rel)));
        const moved = target.moveTo && relOf(target.moveTo);
        if (moved) store.setBaseline(moved, readOrNull(store.abs(moved)));
      }
      return "";
    }

    case "PostToolUse": {
      if (agent === "codex") {
        if (!input.tool_name || !CODEX_EDIT_TOOLS.has(input.tool_name)) return "";
        for (const target of codexTargets(input)) {
          const rel = relOf(target.moveTo ?? target.path);
          if (rel) edited(rel, input.tool_name);
        }
        return "";
      }
      if (!input.tool_name || !CLAUDE_EDIT_TOOLS.has(input.tool_name)) return "";
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (!target) return "";
      const rel = relOf(target);
      if (!rel) return "";
      const response = input.tool_response ?? {};
      // Claude Code reports the file's content before this edit. A brand-new
      // file has no original. Only the first edit since the last review counts.
      if ("originalFile" in response) {
        const original = response.originalFile;
        store.setBaseline(rel, typeof original === "string" && !(response.type === "create" && original === "") ? original : null);
      }
      edited(rel, input.tool_name);
      return "";
    }

    case "Stop": {
      const flags = store.takePendingFlags();
      store.appendEvent({ t, type: "turn-end", session, agent, blocked: flags.length || undefined });
      if (!flags.length) return "";
      // Blocking the stop makes the agent keep going and address the flags now.
      return JSON.stringify({ decision: "block", reason: formatFlagsForAgent(flags) });
    }
  }
  return "";
}

/** Codex sends a patch for apply_patch, and a plain path for Edit/Write. */
function codexTargets(input: HookInput) {
  const fromPatch = patchTargets(input.tool_input?.command);
  if (fromPatch.length) return fromPatch;
  const file = input.tool_input?.file_path;
  return file ? [{ path: file, op: "update" as const, moveTo: undefined }] : [];
}

if (require.main === module) {
  readStdin()
    .then((raw) => run(raw, process.env, agentFrom(process.argv), __dirname))
    .then((out) => {
      if (out) process.stdout.write(out);
    })
    .catch(() => {})
    .finally(() => process.exit(0));
}
