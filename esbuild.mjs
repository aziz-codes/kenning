// Bundles the extension (Node, CommonJS), the Claude Code hook (a standalone
// Node script with no dependencies) and the webview script (browser).
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const shared = { bundle: true, minify: production, sourcemap: !production, logLevel: "info" };
const builds = [
  { ...shared, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", target: "node18", external: ["vscode"] },
  { ...shared, entryPoints: ["src/hook/hook.ts"], outfile: "dist/hook.js", platform: "node", format: "cjs", target: "node18", sourcemap: false },
  { ...shared, entryPoints: ["src/webview/ui/main.ts"], outfile: "dist/webview.js", platform: "browser", format: "iife", target: "es2022" },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
