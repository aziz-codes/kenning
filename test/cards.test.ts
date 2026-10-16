import { describe, expect, test } from "vitest";
import { cardsForFile, headlineFor, sortCards } from "../src/core/cards";
import { buildHunks, firstChangedLine, hunkToText } from "../src/core/hunks";
import { enclosingSymbol } from "../src/core/symbols";

describe("buildHunks", () => {
  test("splits distant edits into separate hunks with line numbers", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 3\n", "line three\n").replace("line 35\n", "line thirty-five\n");
    const hunks = buildHunks("a.txt", before, after);
    expect(hunks).toHaveLength(2);
    expect(firstChangedLine(hunks[0])).toBe(3);
    expect(firstChangedLine(hunks[1])).toBe(35);
    expect(hunks[0].added).toBe(1);
    expect(hunks[0].removed).toBe(1);
  });

  test("ids are stable when the change moves", () => {
    const a = buildHunks("f.ts", "x\ny\n", "x\nz\n")[0];
    const b = buildHunks("f.ts", "pad\npad\npad\npad\npad\nx\ny\n", "pad\npad\npad\npad\npad\nx\nz\n")[0];
    expect(a.id).toBe(b.id);
    expect(buildHunks("g.ts", "x\ny\n", "x\nz\n")[0].id).not.toBe(a.id);
  });

  test("new and deleted files", () => {
    expect(buildHunks("n.ts", null, "a\nb\n")[0]).toMatchObject({ kind: "new", added: 2, removed: 0 });
    expect(buildHunks("d.ts", "a\n", null)[0]).toMatchObject({ kind: "deleted", added: 0, removed: 1 });
    expect(buildHunks("same.ts", "a\n", "a\n")).toEqual([]);
  });

  test("renders as a unified diff", () => {
    expect(hunkToText(buildHunks("a", "x\n", "y\n")[0])).toBe("-x\n+y");
  });
});

describe("enclosingSymbol", () => {
  const cases: [string, string][] = [
    ["export async function loadUser(id: string) {", "loadUser"],
    ["const handler = async (req, res) => {", "handler"],
    ["  async def fetch_rows(self, q):", "fetch_rows"],
    ["func (s *Server) Handle(w http.ResponseWriter) {", "Handle"],
    ["pub async fn connect(url: &str) -> Result<()> {", "connect"],
    ["  public List<User> findAll(int limit) {", "findAll"],
    ["  render() {", "render"],
    ["class Cart extends Base {", "Cart"],
  ];
  test.each(cases)("%s", (decl, name) => {
    expect(enclosingSymbol([decl, "  body();", "  more();"], 2)).toBe(name);
  });
  test("ignores control flow", () => {
    expect(enclosingSymbol(["if (x) {", "  y();"], 1)).toBeUndefined();
  });
});

describe("cards", () => {
  test("headline uses the function name", () => {
    const [card] = cardsForFile("src/a.ts", "function total(xs) {\n  return 0;\n}\n", "function total(xs) {\n  return xs.length;\n}\n");
    expect(card.symbol).toBe("total");
    expect(card.headline).toBe("Changed in total");
  });

  test("headlines for new and deleted files", () => {
    const [h] = buildHunks("n.ts", null, "a\n");
    expect(headlineFor(h)).toBe("New file · 1 line");
  });

  test("risky cards come first", () => {
    const safe = cardsForFile("a.ts", "x\n", "y\n");
    const risky = cardsForFile("b.ts", "x\n", "// @ts-ignore\n");
    expect(sortCards([...safe, ...risky])[0].hunk.file).toBe("b.ts");
  });
});
