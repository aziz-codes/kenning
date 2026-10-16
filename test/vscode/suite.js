// Runs inside a real VS Code extension host (see run.mjs).
const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

exports.run = async function run() {
  const results = [];
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n    ") : e}`);
      throw e;
    }
    results.push(name);
    console.log(`  ✓ ${name}`);
  };
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const ext = vscode.extensions.getExtension("azizcodes.kenning");
  const api = await ext.activate();
  await vscode.workspace.getConfiguration("kenning").update("ai.provider", "off", vscode.ConfigurationTarget.Workspace);

  await step("activates and shows the welcome state", async () => {
    const s = api.state();
    assert.equal(s.hasWorkspace, true);
    assert.equal(s.connected, false);
    assert.equal(s.cards.length, 0);
  });

  await step("connects to Claude Code without touching other settings", async () => {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    await api.send({ type: "connectClaude" });
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes(".kenning/hook.js"));
    assert.ok(fs.existsSync(path.join(root, ".kenning", "hook.js")));
    assert.ok(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8").includes(".claude/settings.local.json"));
    assert.equal(api.state().connected, true);
  });

  const hook = (input) =>
    cp.spawnSync("node", [path.join(root, ".kenning", "hook.js")], {
      input: JSON.stringify(input),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    });
  const file = path.join(root, "src", "cart.js");
  const original = fs.readFileSync(file, "utf8");

  await step("a Claude edit becomes a card with risk flags, and the agent shows as working", async () => {
    hook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "simplify" });
    const edited = original.replace("  if (!items) return 0;\n", "");
    fs.writeFileSync(file, edited);
    hook({ hook_event_name: "PostToolUse", tool_name: "Edit", cwd: root, tool_input: { file_path: file }, tool_response: { originalFile: original } });
    await until(() => api.state().cards.length === 1, "card from hook");
    const s = api.state();
    assert.equal(s.agent.working, true);
    assert.equal(s.cards[0].file, "src/cart.js");
    assert.equal(s.cards[0].symbol, "total");
    assert.ok(s.cards[0].risks.some((r) => r.id === "guard-removed"));
    assert.equal(s.cards[0].ai.status, "off");
  });

  await step("the turn ends and the agent shows as idle", async () => {
    hook({ hook_event_name: "Stop", cwd: root, stop_hook_active: false });
    await until(() => !api.state().agent.working, "agent idle");
  });

  await step("opens the before/after diff", async () => {
    await api.send({ type: "openDiff", key: api.state().cards[0].key });
    await until(() => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab && tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "kenning-base";
    }, "diff tab");
  });

  await step("a flag is queued for the agent and the card counts as reviewed", async () => {
    const key = api.state().cards[0].key;
    await api.send({ type: "flag", key, comment: "Keep the empty-cart check" });
    const flags = fs.readdirSync(path.join(root, ".kenning", "flags"));
    assert.equal(flags.length, 1);
    const flag = JSON.parse(fs.readFileSync(path.join(root, ".kenning", "flags", flags[0]), "utf8"));
    assert.equal(flag.comment, "Keep the empty-cart check");
    assert.equal(flag.delivered, false);
    const s = api.state();
    assert.equal(s.cards.length, 0);
    assert.equal(s.today.flagged, 1);
    assert.equal(s.today.score, 100);
    assert.ok(s.flagNote);
  });

  await step("the next prompt delivers the flag to the agent", async () => {
    const out = JSON.parse(hook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "next" }).stdout);
    assert.ok(out.hookSpecificOutput.additionalContext.includes("Keep the empty-cart check"));
  });

  await step("changes by another agent (no hooks) are captured from git", async () => {
    const other = path.join(root, "src", "price.js");
    fs.writeFileSync(other, fs.readFileSync(other, "utf8").replace("return n * 1.2;", "return n * 1.25; // TODO confirm VAT"));
    await until(() => api.state().cards.some((c) => c.file === "src/price.js"), "card from external change", 20000);
    const card = api.state().cards.find((c) => c.file === "src/price.js");
    assert.ok(card.risks.some((r) => r.id === "todo"));
    assert.equal(card.lang, "javascript");
    const del = card.lines.find((l) => l.kind === "del");
    const add = card.lines.find((l) => l.kind === "add");
    const cut = (l) => l.em.map(([a, b]) => l.text.slice(a, b));
    assert.deepEqual(cut(del), ["1.2"]);
    assert.deepEqual(cut(add), ["1.25", "// TODO confirm VAT"]);
    await api.send({ type: "understood", key: card.key });
    assert.equal(api.state().cards.length, 0);
  });

  await step("the developer's own saves are not treated as agent changes", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root, "src", "price.js"));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), "// edited by hand\n"));
    await doc.save();
    await sleep(3000);
    assert.equal(api.state().cards.filter((c) => c.file === "src/price.js").length, 0);
  });

  await step("git checkout does not flood the deck", async () => {
    cp.execFileSync("git", ["checkout", "--", "."], { cwd: root });
    await sleep(3000);
    assert.equal(api.state().cards.length, 0);
  });

  await step("review uncommitted changes", async () => {
    fs.writeFileSync(path.join(root, "src", "new.js"), "module.exports = 1;\n");
    await sleep(2000);
    await api.send({ type: "reviewUncommitted" });
    await until(() => api.state().cards.some((c) => c.file === "src/new.js" && c.kind === "new"), "new-file card");
  });

  await step("the review panel opens and the walkthrough is registered", async () => {
    await vscode.commands.executeCommand("kenning.focus");
    const walkthroughs = ext.packageJSON.contributes.walkthroughs;
    assert.equal(walkthroughs[0].steps.length, 5);
    for (const step of walkthroughs[0].steps) {
      const media = step.media.image || step.media.markdown;
      assert.ok(fs.existsSync(path.join(ext.extensionPath, media)), media);
    }
    assert.ok(fs.existsSync(path.join(ext.extensionPath, "media", "fonts", "newsreader-latin-opsz-normal.woff2")));
  });

  await step("disconnect removes only Kenning's hooks", async () => {
    await api.send({ type: "connectClaude" });
    await vscode.commands.executeCommand("kenning.disconnectClaude");
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"));
    assert.equal(settings.hooks, undefined);
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
  });

  console.log(`\n${results.length} integration checks passed`);
};
