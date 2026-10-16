import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { Store } from "../src/services/store";
import { tempDir } from "./helpers";

const HOOK = path.resolve(__dirname, "../dist/hook.js");

function runHook(project: string, input: object, env: Record<string, string> = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout };
}

beforeAll(() => {
  if (!fs.existsSync(HOOK)) execFileSync("npm", ["run", "build"], { cwd: path.resolve(__dirname, "..") });
});

describe("Claude Code hook (real process)", () => {
  test("records the original content of the first edit only", () => {
    const dir = tempDir();
    const file = path.join(dir, "src", "a.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "v2\n");
    const edit = (original: string) =>
      runHook(dir, {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        cwd: dir,
        tool_input: { file_path: file },
        tool_response: { originalFile: original },
      });
    expect(edit("v1\n").code).toBe(0);
    edit("v1.5\n");
    const store = new Store(dir);
    expect(store.getBaseline("src/a.ts")?.content).toBe("v1\n");
    expect(store.readEvents(0).events.map((e) => e.type)).toEqual(["edit", "edit"]);
    expect(fs.readFileSync(path.join(dir, ".kenning", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("a new file has no original", () => {
    const dir = tempDir();
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      cwd: dir,
      tool_input: { file_path: path.join(dir, "new.py") },
      tool_response: { type: "create", originalFile: null },
    });
    expect(new Store(dir).getBaseline("new.py")?.content).toBeNull();
  });

  test("ignores other tools, files outside the project, and Kenning's own calls", () => {
    const dir = tempDir();
    runHook(dir, { hook_event_name: "PostToolUse", tool_name: "Bash", cwd: dir, tool_input: {} });
    runHook(dir, { hook_event_name: "PostToolUse", tool_name: "Edit", cwd: dir, tool_input: { file_path: "/etc/hosts" }, tool_response: { originalFile: "x" } });
    runHook(dir, { hook_event_name: "UserPromptSubmit", cwd: dir }, { KENNING_INTERNAL: "1" });
    expect(new Store(dir).listBaselines()).toEqual([]);
    expect(new Store(dir).readEvents(0).events).toEqual([]);
  });

  test("Stop blocks once with pending flags, then lets the agent finish", () => {
    const dir = tempDir();
    const store = new Store(dir);
    store.addFlag({ file: "src/a.ts", line: 4, comment: "Keep the null check", excerpt: "-if (!u) return;" });
    const first = runHook(dir, { hook_event_name: "Stop", cwd: dir, stop_hook_active: false });
    const out = JSON.parse(first.out);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("src/a.ts:4 — Keep the null check");
    const second = runHook(dir, { hook_event_name: "Stop", cwd: dir, stop_hook_active: true });
    expect(second.out).toBe("");
    expect(store.listFlags()[0].delivered).toBe(true);
  });

  test("flags made while idle arrive with the next prompt", () => {
    const dir = tempDir();
    new Store(dir).addFlag({ file: "b.py", line: 1, comment: "Add a test", excerpt: "" });
    const r = runHook(dir, { hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "next task" });
    const out = JSON.parse(r.out);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("b.py:1 — Add a test");
  });

  test("never fails the agent, even on garbage input", () => {
    const r = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
