// Launches VS Code with Kenning in a throwaway profile and workspace.
// Usage: node test/vscode/run.mjs   (downloads a test copy of VS Code once, into .vscode-test/)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "../..");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "kenning-ws-"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kenning-profile-"));
fs.mkdirSync(path.join(ws, "src"));
fs.writeFileSync(path.join(ws, "src", "cart.js"), "function total(items) {\n  if (!items) return 0;\n  return items.reduce((s, i) => s + i.price, 0);\n}\n\nmodule.exports = { total };\n");
fs.writeFileSync(path.join(ws, "src", "price.js"), "function withVat(n) {\n  return n * 1.2;\n}\n\nmodule.exports = { withVat };\n");
const git = (...a) => execFileSync("git", a, { cwd: ws });
git("init", "-q");
git("add", ".");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

await runTests({
  version: "stable",
  extensionDevelopmentPath: ext,
  extensionTestsPath: path.join(here, "suite.js"),
  launchArgs: [ws, "--disable-extensions", "--user-data-dir", profile, "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--disable-gpu"],
});
