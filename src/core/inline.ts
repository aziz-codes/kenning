import { diffWordsWithSpace } from "diff";
import type { DiffLine } from "./types";

/**
 * In a block of removed lines followed by the same number of added lines,
 * pairs them up and marks only the parts of each line that changed, so
 * `return n * 1.2;` → `return n * 1.25;` highlights just `1.2` / `1.25`.
 * Lines that changed almost entirely are left unmarked.
 */
export function markInlineChanges(lines: DiffLine[]): DiffLine[] {
  const out = lines.map((l) => ({ ...l }));
  let i = 0;
  while (i < out.length) {
    if (out[i].kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < out.length && out[d].kind === "del") d++;
    let a = d;
    while (a < out.length && out[a].kind === "add") a++;
    const dels = d - i;
    const adds = a - d;
    if (dels === adds) {
      for (let k = 0; k < dels; k++) mark(out[i + k], out[d + k]);
    }
    i = Math.max(a, i + 1);
  }
  return out;
}

function mark(del: DiffLine, add: DiffLine) {
  const delRanges: [number, number][] = [];
  const addRanges: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (const part of diffWordsWithSpace(del.text, add.text)) {
    const len = part.value.length;
    if (part.removed) delRanges.push([x, x + len]);
    else if (part.added) addRanges.push([y, y + len]);
    if (!part.added) x += len;
    if (!part.removed) y += len;
  }
  const changed = (ranges: [number, number][]) => ranges.reduce((n, [a, b]) => n + b - a, 0);
  const longest = Math.max(del.text.trim().length, add.text.trim().length);
  if (!longest || Math.max(changed(delRanges), changed(addRanges)) > longest * 0.7) return;
  const d = tidy(del.text, delRanges);
  const a = tidy(add.text, addRanges);
  if (d.length) del.em = d;
  if (a.length) add.em = a;
}

/** Grows ranges to whole words (1.2 → 1.25 marks the numbers), trims spaces, merges neighbours. */
function tidy(text: string, ranges: [number, number][]): [number, number][] {
  const word = (c: string | undefined) => !!c && /[\w$.]/.test(c);
  const out: [number, number][] = [];
  for (let [a, b] of ranges) {
    if (word(text[a])) while (a > 0 && word(text[a - 1])) a--;
    if (word(text[b - 1])) while (b < text.length && word(text[b])) b++;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a >= b) continue;
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const LANGS: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  cs: "csharp", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", rb: "ruby", php: "php",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", css: "css", scss: "scss",
  html: "xml", xml: "xml", svg: "xml", vue: "xml", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", md: "markdown", dart: "dart", lua: "lua", scala: "scala", r: "r",
};

/** highlight.js language for a file path, if we bundle one for it. */
export function languageFor(file: string): string | undefined {
  const base = file.split("/").pop() ?? "";
  if (/^Dockerfile/i.test(base)) return "dockerfile";
  if (/^Makefile$/i.test(base)) return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return LANGS[ext];
}
