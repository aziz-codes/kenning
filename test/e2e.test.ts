// Real Claude Code, real hooks. Opt-in because it uses the developer's Claude
// plan: KENNING_E2E=1 npx vitest run test/e2e.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { addKenningHooks } from "../src/core/hooksConfig";
import { askClaudeCode } from "../src/services/insights";
import { parseInsight } from "../src/core/insight";
import { buildPrompt } from "../src/core/insight";
import { Review } from "../src/services/review";
import { Store } from "../src/services/store";
import { memento, tempDir } from "./helpers";

const enabled = !!process.env.KENNING_E2E;
const HOOK = path.resolve(__dirname, "../dist/hook.js");

function setupProject() {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src", "users.js"),
    `function getUser(db, id) {\n  if (!id) return null;\n  try {\n    return db.find(id);\n  } catch (err) {\n    console.error(err);\n    return null;\n  }\n}\n\nmodule.exports = { getUser };\n`,
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  // Exactly what “Kenning: Connect to Claude Code” does.
  const store = new Store(dir);
  store.ensure();
  fs.copyFileSync(HOOK, path.join(store.dir, "hook.js"));
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify(addKenningHooks({}), null, 2));
  return { dir, store };
}

function claude(dir: string, prompt: string) {
  const r = spawnSync(
    "claude",
    ["-p", prompt, "--model", "claude-opus-5-5", "--permission-mode", "acceptEdits", "--output-format", "json"],
    { cwd: dir, encoding: "utf8", input: "", timeout: 240_000 },
  );
  return JSON.parse(r.stdout) as { result: string; is_error: boolean };
}

describe.runIf(enabled)("end to end with Claude Code", () => {
  const { dir, store } = setupProject();

  test("agent edits become review cards with risk flags", () => {
    const r = claude(dir, "In src/users.js, simplify getUser to a single line: return db.find(id). Remove the id check and the try/catch. Do nothing else.");
    expect(r.is_error).toBe(false);
    const types = store.readEvents(0).events.map((e) => e.type);
    expect(types[0]).toBe("turn-start");
    expect(types).toContain("edit");
    expect(types.at(-1)).toBe("turn-end");

    const deck = new Review(() => [store], memento()).entries();
    expect(deck.length).toBeGreaterThan(0);
    const risks = deck.flatMap((e) => e.card.risks.map((x) => x.id));
    expect(risks).toContain("guard-removed");
    expect(risks).toContain("error-handling-removed");
    expect(deck[0].card.symbol).toBe("getUser");
  }, 300_000);

  test("Claude Code writes a gradable question for the card", async () => {
    const [entry] = new Review(() => [store], memento()).entries();
    const raw = await askClaudeCode(
      { provider: "claudeCode", model: "claude-opus-5-5", claudePath: "claude" },
      buildPrompt(entry.card, store.readCurrent(entry.card.hunk.file) ?? undefined),
    );
    const insight = parseInsight(raw);
    console.log("\nAI card:", JSON.stringify(insight, null, 2));
    expect(insight.options.length).toBeGreaterThanOrEqual(2);
    expect(insight.question.length).toBeGreaterThan(10);
    // Kenning's own call must not show up as agent activity.
    expect(store.readEvents(0).events.filter((e) => e.type === "turn-start")).toHaveLength(1);
  }, 180_000);

  test("a flag reaches the agent and it acts on it", () => {
    store.addFlag({
      file: "src/users.js",
      line: 1,
      comment: "Put back the check that returns null when id is missing.",
      excerpt: "-  if (!id) return null;",
    });
    const r = claude(dir, "Add a JSDoc comment above getUser describing its parameters. Do nothing else.");
    expect(r.is_error).toBe(false);
    const code = fs.readFileSync(path.join(dir, "src", "users.js"), "utf8");
    console.log("\nFinal file:\n" + code);
    expect(code).toMatch(/if\s*\(\s*!id\s*\)/);
    expect(store.listFlags().every((f) => f.delivered)).toBe(true);
  }, 300_000);
});
