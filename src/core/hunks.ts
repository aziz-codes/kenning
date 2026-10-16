import { createHash } from "node:crypto";
import { structuredPatch } from "diff";
import type { DiffLine, Hunk } from "./types";

const fingerprint = (file: string, removed: string[], added: string[]) =>
  createHash("sha1").update(`${file}\n${removed.join("\n")}\u0000${added.join("\n")}`).digest("hex").slice(0, 16);

const splitLines = (s: string) => {
  const lines = s.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/**
 * Turns "before" and "after" file contents into review-sized hunks.
 * `before === null` means the file is new; `after === null` means it was deleted.
 */
export function buildHunks(file: string, before: string | null, after: string | null, context = 3): Hunk[] {
  if (before === after) return [];

  if (before === null || after === null) {
    const content = splitLines(before ?? after ?? "");
    const isNew = before === null;
    const lines: DiffLine[] = content.map((text, i) =>
      isNew ? { kind: "add", text, newNo: i + 1 } : { kind: "del", text, oldNo: i + 1 },
    );
    return [
      {
        id: fingerprint(file, isNew ? [] : content, isNew ? content : []),
        file,
        kind: isNew ? "new" : "deleted",
        oldStart: 1,
        newStart: 1,
        lines,
        added: isNew ? content.length : 0,
        removed: isNew ? 0 : content.length,
      },
    ];
  }

  const patch = structuredPatch(file, file, before, after, undefined, undefined, { context });
  return patch.hunks.map((h) => {
    const lines: DiffLine[] = [];
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    const added: string[] = [];
    const removed: string[] = [];
    for (const raw of h.lines) {
      const sign = raw[0];
      const text = raw.slice(1);
      if (sign === "+") {
        lines.push({ kind: "add", text, newNo: newNo++ });
        added.push(text);
      } else if (sign === "-") {
        lines.push({ kind: "del", text, oldNo: oldNo++ });
        removed.push(text);
      } else if (sign === " ") {
        lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
      }
      // "\ No newline at end of file" markers are skipped.
    }
    return {
      id: fingerprint(file, removed, added),
      file,
      kind: "edit" as const,
      oldStart: h.oldStart,
      newStart: h.newStart,
      lines,
      added: added.length,
      removed: removed.length,
    };
  });
}

/** The first changed line in the new file, for "open at line". */
export function firstChangedLine(h: Hunk): number {
  const first = h.lines.find((l) => l.kind !== "ctx");
  return first?.newNo ?? first?.oldNo ?? h.newStart;
}

/** A unified-diff rendering, used in prompts and flag messages. */
export function hunkToText(h: Hunk, maxLines = 120): string {
  const body = h.lines.slice(0, maxLines).map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
  if (h.lines.length > maxLines) body.push(`… (${h.lines.length - maxLines} more lines)`);
  return body.join("\n");
}
