import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHunks } from "../src/core/hunks";

export const hunk = (file: string, before: string, after: string) => buildHunks(file, before, after)[0];

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kenning-test-"));
}

/** An in-memory stand-in for VS Code's Memento. */
export function memento() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: (k: string, v: unknown) => void data.set(k, v),
  };
}
