// What the Codex and Cursor hooks tell us about an edit, turned into the
// file paths touched and, where possible, the content before the edit.

export interface PatchTarget {
  path: string;
  op: "add" | "update" | "delete";
  /** Set when an update also renames the file. */
  moveTo?: string;
}

/**
 * The files an apply_patch call touches. Codex patches look like:
 *   *** Begin Patch
 *   *** Update File: src/app.py
 *   *** Move to: src/main.py
 *   @@ …
 *   *** Add File: notes.txt
 *   *** Delete File: old.txt
 *   *** End Patch
 */
export function patchTargets(patch: unknown): PatchTarget[] {
  if (typeof patch !== "string") return [];
  const out: PatchTarget[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
    if (file) {
      out.push({ path: file[2], op: file[1].toLowerCase() as PatchTarget["op"] });
      continue;
    }
    const move = /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    if (move && out.length) out[out.length - 1].moveTo = move[1];
  }
  return out;
}

export interface StringEdit {
  old_string?: string;
  new_string?: string;
}

/**
 * Rebuilds a file's content before a list of string replacements (what
 * Cursor's afterFileEdit reports), by undoing them last to first.
 * Returns undefined when the edits can't be located in the current text.
 */
export function undoEdits(current: string, edits: StringEdit[]): string | undefined {
  let text = current;
  for (const e of [...edits].reverse()) {
    const before = e.old_string ?? "";
    const after = e.new_string ?? "";
    if (before === after) continue;
    if (!after) return undefined; // a pure deletion leaves nothing to find
    const at = text.indexOf(after);
    if (at < 0) return undefined;
    text = text.slice(0, at) + before + text.slice(at + after.length);
  }
  return text;
}
