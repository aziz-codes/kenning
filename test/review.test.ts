import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { Review } from "../src/services/review";
import { dayKey, Stats, streak, understandingScore } from "../src/services/stats";
import { Store } from "../src/services/store";
import { memento, tempDir } from "./helpers";

function project() {
  const dir = tempDir();
  const store = new Store(dir);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  return { dir, store, write, review: new Review(() => [store], memento()) };
}

describe("Review deck", () => {
  test("shows each unreviewed change and drops the baseline when all are reviewed", async () => {
    const { store, write, review } = project();
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n";
    write("a.txt", before.replace("l2\n", "two\n").replace("l25\n", "twenty-five\n"));
    store.setBaseline("a.txt", before);

    let deck = review.entries();
    expect(deck).toHaveLength(2);
    await review.resolve(deck[0], "understood");
    deck = review.entries();
    expect(deck).toHaveLength(1);
    await review.resolve(deck[0], "correct", 1, { keepShowing: true });
    expect(review.entries()).toHaveLength(1); // still on screen
    review.dismiss(deck[0].key);
    expect(review.entries()).toHaveLength(0);
    expect(store.hasBaseline("a.txt")).toBe(false);
  });

  test("a later edit to a reviewed file starts from the reviewed state", async () => {
    const { store, write, review } = project();
    write("a.txt", "b\n");
    store.setBaseline("a.txt", "a\n");
    await review.resolve(review.entries()[0], "understood");
    review.entries(); // baseline dropped
    // The agent edits again: the hook records the reviewed content as the new baseline.
    store.setBaseline("a.txt", "b\n");
    write("a.txt", "c\n");
    const deck = review.entries();
    expect(deck).toHaveLength(1);
    expect(deck[0].card.hunk.lines.map((l) => l.text)).toEqual(["b", "c"]);
  });

  test("changes that were undone disappear", () => {
    const { store, write, review } = project();
    write("a.txt", "same\n");
    store.setBaseline("a.txt", "same\n");
    expect(review.entries()).toEqual([]);
    expect(store.hasBaseline("a.txt")).toBe(false);
  });

  test("binary files are skipped", () => {
    const { store, write, review } = project();
    write("img.png", "\u0000PNG");
    store.setBaseline("img.png", null);
    expect(review.entries()).toEqual([]);
  });
});

describe("Stats", () => {
  test("score counts correct, understood and flagged", () => {
    expect(understandingScore({ correct: 2, wrong: 1, understood: 1, flagged: 0, skipped: 0 })).toBe(75);
    expect(understandingScore({ correct: 0, wrong: 0, understood: 0, flagged: 0, skipped: 0 })).toBeNull();
  });

  test("records outcomes for today", async () => {
    const s = new Stats(memento());
    await s.record("correct");
    await s.record("skipped");
    expect(s.today()).toMatchObject({ correct: 1, skipped: 1 });
  });

  test("streak counts consecutive days with 3+ reviews", () => {
    const day = (offset: number) => {
      const d = new Date(2026, 9, 17);
      d.setDate(d.getDate() - offset);
      return dayKey(d);
    };
    const full = { correct: 3, wrong: 0, understood: 0, flagged: 0, skipped: 0 };
    const days = { [day(0)]: full, [day(1)]: full, [day(3)]: full };
    expect(streak(days, new Date(2026, 9, 17))).toBe(2);
    // Today not started yet: the streak still counts from yesterday.
    expect(streak({ [day(1)]: full, [day(2)]: full }, new Date(2026, 9, 17))).toBe(2);
  });
});

describe("Store", () => {
  test("reads only new events and survives partial lines", () => {
    const { dir, store } = project();
    store.appendEvent({ t: "1", type: "turn-start" });
    const first = store.readEvents(0);
    expect(first.events).toHaveLength(1);
    fs.appendFileSync(path.join(dir, ".kenning", "events.jsonl"), '{"t":"2","type":"turn-end"}\n{"t":"3","ty');
    const next = store.readEvents(first.offset);
    expect(next.events.map((e) => e.type)).toEqual(["turn-end"]);
  });

  test("paths outside the project or inside .kenning are rejected", () => {
    const { dir, store } = project();
    expect(store.rel(path.join(dir, "src", "a.ts"))).toBe("src/a.ts");
    expect(store.rel("/etc/hosts")).toBeNull();
    expect(store.rel(path.join(dir, ".kenning", "hook.js"))).toBeNull();
  });
});
