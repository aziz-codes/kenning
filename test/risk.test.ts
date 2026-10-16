import { describe, expect, test } from "vitest";
import { buildHunks } from "../src/core/hunks";
import { detectRisks } from "../src/core/risk";
import { hunk } from "./helpers";

const ids = (file: string, before: string, after: string) => detectRisks(hunk(file, before, after)).map((r) => r.id);

describe("detectRisks", () => {
  test("secrets", () => {
    expect(ids("src/a.ts", "x\n", 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwx";\n')).toContain("secret");
    expect(ids("src/a.py", "x\n", 'password = "hunter2hunter2"\n')).toContain("secret");
    expect(ids("README.md", "x\n", 'password = "hunter2hunter2"\n')).not.toContain("secret");
  });

  test("removed and skipped tests", () => {
    expect(ids("a.test.ts", 'it("works", () => {});\nok\n', "ok\n")).toContain("test-removed");
    expect(ids("a.test.ts", 'it("works", () => {});\n', 'it.skip("works", () => {});\n')).toContain("test-skipped");
    expect(ids("test_a.py", "def test_x():\n    assert f() == 1\n", "def test_x():\n    pass\n")).toContain("assertion-weakened");
  });

  test("a moved line is not a removal", () => {
    const before = "a\nif (!user) return null;\nb\n";
    const after = "if (!user) return null;\na\nb\n";
    expect(ids("src/a.ts", before, after)).not.toContain("guard-removed");
  });

  test("removed guards and error handling", () => {
    const before = "function f(u) {\n  if (!u) return null;\n  try {\n    go(u);\n  } catch (e) {\n    log(e);\n  }\n}\n";
    const after = "function f(u) {\n  go(u);\n}\n";
    const found = ids("src/f.ts", before, after);
    expect(found).toContain("guard-removed");
    expect(found).toContain("error-handling-removed");
  });

  test("silenced checks, TLS, shell, SQL", () => {
    expect(ids("a.ts", "x\n", "// @ts-ignore\n")).toContain("suppression");
    expect(ids("a.ts", "x\n", "const agent = new Agent({ rejectUnauthorized: false });\n")).toContain("tls-off");
    expect(ids("a.py", "x\n", "subprocess.run(cmd, shell=True)\n")).toContain("dangerous-call");
    expect(ids("a.ts", "x\n", 'db.query("SELECT * FROM users WHERE id = " + id);\n')).toContain("sql-concat");
  });

  test("dependencies are named", () => {
    const risks = detectRisks(hunk("package.json", '{\n  "dependencies": {\n  }\n}\n', '{\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n'));
    expect(risks.find((r) => r.id === "dependency")?.title).toBe("New dependency: left-pad");
  });

  test("most severe first, one flag per rule", () => {
    const risks = detectRisks(hunk("a.ts", "x\n", 'console.log(1);\nconsole.log(2);\nconst k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n'));
    expect(risks[0].severity).toBe("high");
    expect(risks.filter((r) => r.id === "debug")).toHaveLength(1);
  });

  test("a clean change has no flags", () => {
    expect(ids("src/math.ts", "export const add = (a, b) => a + b;\n", "export const add = (a: number, b: number) => a + b;\n")).toEqual([]);
  });

  test("deleted files don't pile on removal warnings", () => {
    const [h] = buildHunks("src/old.ts", "if (!x) return;\ntry { a() } catch {}\n", null);
    expect(detectRisks(h).map((r) => r.id)).toEqual([]);
  });
});
