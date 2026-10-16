import { describe, expect, test } from "vitest";
import { buildHunks } from "../src/core/hunks";
import { languageFor, markInlineChanges } from "../src/core/inline";

const pick = (file: string, before: string, after: string) => {
  const lines = markInlineChanges(buildHunks(file, before, after)[0].lines);
  const del = lines.find((l) => l.kind === "del")!;
  const add = lines.find((l) => l.kind === "add")!;
  const cut = (l: typeof del) => l.em?.map(([a, b]) => l.text.slice(a, b));
  return { del: cut(del), add: cut(add) };
};

describe("markInlineChanges", () => {
  test("marks just the changed value", () => {
    expect(pick("p.js", "  return n * 1.2;\n", "  return n * 1.25;\n")).toEqual({ del: ["1.2"], add: ["1.25"] });
  });
  test("marks a renamed identifier as a whole word", () => {
    expect(pick("a.ts", "const total = sumItems(cart);\n", "const total = sumPrices(cart);\n")).toEqual({ del: ["sumItems"], add: ["sumPrices"] });
  });
  test("pure insertion marks only the new part", () => {
    expect(pick("a.ts", "f(a);\n", "f(a, b);\n")).toEqual({ del: undefined, add: [", b"] });
  });
  test("marks two separate changes in one line", () => {
    expect(pick("p.js", "  return n * 1.2;\n", "  return n * 1.25; // TODO confirm VAT\n")).toEqual({
      del: ["1.2"],
      add: ["1.25", "// TODO confirm VAT"],
    });
  });
  test("leaves completely rewritten lines alone", () => {
    expect(pick("a.ts", "if (!id) return null;\n", "await sync();\n")).toEqual({ del: undefined, add: undefined });
  });
  test("only pairs equal-sized blocks", () => {
    const lines = markInlineChanges(buildHunks("a", "x = 1\ny = 2\n", "x = 10\n")[0].lines);
    expect(lines.some((l) => l.em)).toBe(false);
  });
});

test("languageFor", () => {
  expect(languageFor("src/app.tsx")).toBe("typescript");
  expect(languageFor("api/main.py")).toBe("python");
  expect(languageFor("Dockerfile")).toBe("dockerfile");
  expect(languageFor("notes.unknownext")).toBeUndefined();
});
