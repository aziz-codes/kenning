import { describe, expect, test } from "vitest";
import { cardsForFile } from "../src/core/cards";
import { buildPrompt, extractJson, parseInsight, shuffleOptions } from "../src/core/insight";

const good = {
  summary: "Returns the item count instead of zero",
  why: "Fixes totals for non-empty carts",
  question: "What does total([1,2,3]) return now?",
  options: ["3", "0", "6", "undefined"],
  answer: 0,
  explanation: "It returns xs.length.",
  concerns: [],
};

describe("parseInsight", () => {
  test("accepts a valid answer", () => {
    expect(parseInsight(good).options).toHaveLength(4);
  });
  test("parses JSON text with extra words around it", () => {
    expect(parseInsight(`Here you go: ${JSON.stringify(good)} done`).answer).toBe(0);
  });
  test("rejects answers that can't be graded", () => {
    expect(() => parseInsight({ ...good, answer: 7 })).toThrow();
    expect(() => parseInsight({ ...good, options: ["only one"] })).toThrow();
    expect(() => extractJson("no json")).toThrow();
  });
  test("trims and caps long fields", () => {
    const p = parseInsight({ ...good, summary: `  ${"x".repeat(500)}  `, concerns: ["a", "b", "c"] });
    expect(p.summary.length).toBe(200);
    expect(p.concerns).toEqual(["a", "b"]);
  });
});

describe("shuffleOptions", () => {
  test("keeps the right answer pointing at the same text, deterministically", () => {
    const a = shuffleOptions(parseInsight(good), "card-1");
    expect(a.options[a.answer]).toBe("3");
    expect(shuffleOptions(parseInsight(good), "card-1")).toEqual(a);
  });
  test("spreads the correct answer across positions", () => {
    const positions = new Set(Array.from({ length: 40 }, (_, i) => shuffleOptions(parseInsight(good), `seed-${i}`).answer));
    expect(positions.size).toBeGreaterThan(2);
  });
});

test("prompt includes file, diff, context and risks", () => {
  const [card] = cardsForFile("src/a.ts", "x\n", "// @ts-ignore\n");
  const p = buildPrompt(card, "surrounding code");
  expect(p).toContain("File: src/a.ts");
  expect(p).toContain("+// @ts-ignore");
  expect(p).toContain("surrounding code");
  expect(p).toContain("Type or lint check silenced");
});
