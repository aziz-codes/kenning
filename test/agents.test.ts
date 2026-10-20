import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { patchTargets, undoEdits } from "../src/core/agentEdits";
import {
  addCursorHooks,
  addKenningHooks,
  CODEX_EVENTS,
  hasCursorHooks,
  hasKenningHooks,
  removeCursorHooks,
  removeKenningHooks,
} from "../src/core/hooksConfig";
import { Store } from "../src/services/store";
import { tempDir } from "./helpers";

const HOOK = path.resolve(__dirname, "../dist/hook.js");

beforeAll(() => {
  if (!fs.existsSync(HOOK)) execFileSync("npm", ["run", "build"], { cwd: path.resolve(__dirname, "..") });
});

/** Runs the hook the way Codex and Cursor do: from the project's .kenning folder, without CLAUDE_PROJECT_DIR. */
function install(dir: string) {
  fs.mkdirSync(path.join(dir, ".kenning"), { recursive: true });
  fs.copyFileSync(HOOK, path.join(dir, ".kenning", "hook.js"));
  return (agent: string, input: object, cwd = dir) => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync("node", [path.join(dir, ".kenning", "hook.js"), "--agent", agent], {
      input: JSON.stringify(input),
      env,
      cwd,
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout };
  };
}

describe("apply_patch targets", () => {
  test("finds added, updated, moved and deleted files", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/app.py",
      "*** Move to: src/main.py",
      "@@ def greet():",
      '-print("Hi")',
      '+print("Hello")',
      "*** Add File: notes.txt",
      "+hello",
      "*** Delete File: old.txt",
      "*** End Patch",
    ].join("\n");
    expect(patchTargets(patch)).toEqual([
      { path: "src/app.py", op: "update", moveTo: "src/main.py" },
      { path: "notes.txt", op: "add" },
      { path: "old.txt", op: "delete" },
    ]);
    expect(patchTargets(undefined)).toEqual([]);
  });
});

describe("undoing Cursor's edits", () => {
  test("rebuilds the content before a list of replacements", () => {
    const before = "a = 1\nb = 2\nc = 3\n";
    const after = "a = 10\nb = 2\nc = 30\n";
    expect(undoEdits(after, [{ old_string: "a = 1", new_string: "a = 10" }, { old_string: "c = 3", new_string: "c = 30" }])).toBe(before);
  });

  test("gives up rather than guessing", () => {
    expect(undoEdits("x", [{ old_string: "y", new_string: "z" }])).toBeUndefined();
    expect(undoEdits("x", [{ old_string: "gone", new_string: "" }])).toBeUndefined();
  });
});

describe("hook settings for Codex and Cursor", () => {
  test("Codex hooks go next to the developer's own and come out cleanly", () => {
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    const cmd = 'node "/p/.kenning/hook.js" --agent codex';
    const s = addKenningHooks(mine, cmd, CODEX_EVENTS);
    expect(hasKenningHooks(s, CODEX_EVENTS)).toBe(true);
    expect(s.hooks.PreToolUse[0]).toEqual({ matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: cmd }] });
    expect(s.hooks.Stop).toHaveLength(2);
    expect(removeKenningHooks(s)).toEqual(mine);
  });

  test("Cursor hooks use Cursor's flat format, with a version", () => {
    const mine = { version: 1, hooks: { afterFileEdit: [{ command: "prettier --write" }] } };
    const cmd = 'node "C:/p/.kenning/hook.js" --agent cursor';
    const s = addCursorHooks(mine, cmd);
    expect(hasCursorHooks(s)).toBe(true);
    expect(s.hooks.afterFileEdit).toEqual([{ command: "prettier --write" }, { command: cmd }]);
    expect(s.hooks.stop).toEqual([{ command: cmd }]);
    expect(removeCursorHooks(s)).toEqual(mine);
    expect(addCursorHooks({}, cmd).version).toBe(1);
    expect(addCursorHooks(addCursorHooks({}, cmd), cmd)).toEqual(addCursorHooks({}, cmd));
  });

  test("recognises Windows paths to the hook", () => {
    expect(hasCursorHooks(addCursorHooks({}, 'node "C:\\p\\.kenning\\hook.js" --agent cursor'))).toBe(true);
  });
});

describe("Codex hook (real process)", () => {
  test("keeps each file's content from just before apply_patch, even from a subfolder", () => {
    const dir = tempDir();
    const hook = install(dir);
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "app.py"), 'print("Hi")\n');
    const patch = "*** Begin Patch\n*** Update File: app.py\n@@\n-print(\"Hi\")\n+print(\"Hello\")\n*** Add File: new.py\n+x = 1\n*** End Patch";
    const input = { hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd: path.join(dir, "src"), tool_input: { command: patch } };
    expect(hook("codex", input, path.join(dir, "src")).code).toBe(0);
    fs.writeFileSync(path.join(dir, "src", "app.py"), 'print("Hello")\n');
    fs.writeFileSync(path.join(dir, "src", "new.py"), "x = 1\n");
    hook("codex", { ...input, hook_event_name: "PostToolUse" }, path.join(dir, "src"));
    const store = new Store(dir);
    expect(store.getBaseline("src/app.py")?.content).toBe('print("Hi")\n');
    expect(store.getBaseline("src/new.py")?.content).toBeNull();
    const events = store.readEvents(0).events;
    expect(events.map((e) => [e.type, "file" in e ? e.file : "", e.agent])).toEqual([
      ["edit", "src/app.py", "codex"],
      ["edit", "src/new.py", "codex"],
    ]);
  });

  test("flags arrive on the next prompt and stop the agent from finishing", () => {
    const dir = tempDir();
    const hook = install(dir);
    const store = new Store(dir);
    store.addFlag({ file: "a.py", line: 3, comment: "Keep the retry", excerpt: "" });
    const prompt = JSON.parse(hook("codex", { hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "go" }).out);
    expect(prompt.hookSpecificOutput.additionalContext).toContain("a.py:3 — Keep the retry");
    store.addFlag({ file: "b.py", line: 1, comment: "Add a test", excerpt: "" });
    const stop = JSON.parse(hook("codex", { hook_event_name: "Stop", cwd: dir, stop_hook_active: false }).out);
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("b.py:1 — Add a test");
    expect(hook("codex", { hook_event_name: "Stop", cwd: dir, stop_hook_active: true }).out).toBe("");
  });
});

describe("Cursor hook (real process)", () => {
  test("rebuilds the original from afterFileEdit and records the edit", () => {
    const dir = tempDir();
    const hook = install(dir);
    const file = path.join(dir, "price.ts");
    fs.writeFileSync(file, "export const vat = 1.25;\n");
    hook("cursor", { hook_event_name: "beforeSubmitPrompt", prompt: "raise vat", workspace_roots: [dir] });
    hook("cursor", {
      hook_event_name: "afterFileEdit",
      file_path: file,
      edits: [{ old_string: "1.2;", new_string: "1.25;" }],
      workspace_roots: [dir],
    });
    const store = new Store(dir);
    expect(store.getBaseline("price.ts")?.content).toBe("export const vat = 1.2;\n");
    expect(store.readEvents(0).events.map((e) => [e.type, e.agent])).toEqual([
      ["turn-start", "cursor"],
      ["edit", "cursor"],
    ]);
  });

  test("a created file has no original", () => {
    const dir = tempDir();
    const hook = install(dir);
    fs.writeFileSync(path.join(dir, "new.ts"), "export {};\n");
    hook("cursor", { hook_event_name: "afterFileEdit", file_path: path.join(dir, "new.ts"), edits: [{ old_string: "", new_string: "export {};\n" }] });
    expect(new Store(dir).getBaseline("new.ts")?.content).toBeNull();
  });

  test("flags become a follow-up message when the turn completes, not when it is aborted", () => {
    const dir = tempDir();
    const hook = install(dir);
    const store = new Store(dir);
    store.addFlag({ file: "a.ts", line: 2, comment: "Revert this change", excerpt: "" });
    expect(hook("cursor", { hook_event_name: "stop", status: "aborted", loop_count: 0 }).out).toBe("");
    expect(store.listFlags()[0].delivered).toBe(false);
    const out = JSON.parse(hook("cursor", { hook_event_name: "stop", status: "completed", loop_count: 0 }).out);
    expect(out.followup_message).toContain("a.ts:2 — Revert this change");
    expect(store.listFlags()[0].delivered).toBe(true);
    expect(JSON.parse(hook("cursor", { hook_event_name: "beforeSubmitPrompt", prompt: "x" }).out)).toEqual({ continue: true });
  });
});
