import { describe, expect, test } from "vitest";
import { addKenningHooks, hasKenningHooks, HOOK_COMMAND, removeKenningHooks } from "../src/core/hooksConfig";

const userHook = { type: "command", command: "afplay done.aiff" };
const existing = {
  permissions: { allow: ["Bash(npm test)"] },
  hooks: { Stop: [{ hooks: [userHook] }] },
};

describe("hooks config", () => {
  test("adds Kenning's three hooks and keeps everything else", () => {
    const s = addKenningHooks(existing);
    expect(hasKenningHooks(s)).toBe(true);
    expect(s.permissions).toEqual(existing.permissions);
    expect(s.hooks!.Stop).toHaveLength(2);
    expect(s.hooks!.Stop[0].hooks[0]).toEqual(userHook);
    expect(s.hooks!.PostToolUse[0]).toEqual({ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: HOOK_COMMAND }] });
  });

  test("is idempotent", () => {
    expect(addKenningHooks(addKenningHooks(existing))).toEqual(addKenningHooks(existing));
  });

  test("removal restores the original settings", () => {
    expect(removeKenningHooks(addKenningHooks(existing))).toEqual(existing);
    expect(removeKenningHooks(addKenningHooks({}))).toEqual({});
    expect(hasKenningHooks(existing)).toBe(false);
  });
});
