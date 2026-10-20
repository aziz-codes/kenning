import { describe, expect, test } from "vitest";
import { buildHunks, fullFileDiff } from "../src/core/hunks";
import { buildReport } from "../src/core/report";
import { bestStreak, lastDays } from "../src/services/stats";
import type { JournalEntry } from "../src/services/store";

const entry = (over: Partial<JournalEntry>): JournalEntry => ({
  t: "2026-10-20T10:00:00.000Z",
  file: "src/a.ts",
  line: 4,
  kind: "edit",
  headline: "Changed in total",
  outcome: "understood",
  added: 2,
  removed: 1,
  risks: [],
  ...over,
});

describe("review summary", () => {
  test("summarises outcomes, flags and risky changes", () => {
    const md = buildReport(
      [
        entry({ summary: "Drops the empty-cart guard", outcome: "flagged", comment: "Keep the guard" }),
        entry({ file: "src/auth.ts", line: 9, outcome: "correct", risks: [{ severity: "high", title: "Auth check removed" }] }),
        entry({ file: "src/b.ts", outcome: "skipped", headline: "Added code in load" }),
      ],
      "Today",
    );
    expect(md).toContain("_Today · 3 changes in 3 files · +6 −3 lines · 67% understood_");
    expect(md).toContain("- `src/a.ts:4` — **Keep the guard** _(Drops the empty-cart guard)_");
    expect(md).toContain("- `src/auth.ts:9` — Auth check removed · answered correctly");
    expect(md).toContain("### Not reviewed (skipped)\n\n- `src/b.ts:4` — Added code in load");
  });

  test("says so when there is nothing", () => {
    expect(buildReport([], "Last 7 days")).toContain("Last 7 days: nothing reviewed yet.");
  });
});

describe("whole-file diff", () => {
  test("covers the whole file and points at the card's change", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 5\n", "line five\n").replace("line 30\n", "line thirty\n");
    const second = buildHunks("f.txt", before, after)[1];
    const { lines, focus } = fullFileDiff(before, after, second);
    expect(lines.filter((l) => l.kind !== "del")).toHaveLength(40);
    expect(lines[focus[0]]).toMatchObject({ kind: "del", text: "line 30" });
    expect(lines[focus[1]]).toMatchObject({ kind: "add", text: "line thirty" });
  });

  test("a new file is the whole file", () => {
    const h = buildHunks("n.txt", null, "a\nb\n")[0];
    expect(fullFileDiff(null, "a\nb\n", h)).toEqual({ lines: h.lines, focus: [0, 1] });
  });
});

describe("history", () => {
  const day = (n: number) => ({ correct: 0, wrong: 0, understood: n, flagged: 0, skipped: 0 });

  test("best streak counts consecutive days with 3+ reviews", () => {
    expect(bestStreak({ "2026-10-01": day(3), "2026-10-02": day(5), "2026-10-03": day(1), "2026-10-04": day(3), "2026-10-06": day(4) })).toBe(2);
    expect(bestStreak({ "2026-09-30": day(3), "2026-10-01": day(3), "2026-10-02": day(3) })).toBe(3);
    expect(bestStreak({})).toBe(0);
  });

  test("last days fills in empty days, oldest first", () => {
    const days = lastDays({ "2026-10-19": day(2) }, 3, new Date("2026-10-20T12:00:00"));
    expect(days.map((d) => [d.day, d.understood])).toEqual([
      ["2026-10-18", 0],
      ["2026-10-19", 2],
      ["2026-10-20", 0],
    ]);
  });
});
