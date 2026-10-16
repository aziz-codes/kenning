// The .kenning folder in a project. It is shared by the Claude Code hook
// (a separate process) and the extension, so every write is atomic.
//
//   .kenning/
//     .gitignore      "*" — nothing here is ever committed
//     hook.js         the hook Claude Code runs
//     events.jsonl    turn-start / edit / turn-end, appended by the hook
//     base/<id>.json  each file's content before the unreviewed changes
//     flags/<id>.json the developer's flags, waiting for the agent

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, Flag } from "../core/types";

export interface Baseline {
  file: string;
  /** null = the file did not exist before. */
  content: string | null;
  createdAt: string;
}

const MAX_EVENTS_BYTES = 512 * 1024;

export class Store {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, ".kenning");
  }

  private p(...parts: string[]) {
    return path.join(this.dir, ...parts);
  }

  ensure() {
    fs.mkdirSync(this.p("base"), { recursive: true });
    fs.mkdirSync(this.p("flags"), { recursive: true });
    const ignore = this.p(".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  }

  private writeAtomic(file: string, data: string) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  // ── Paths ────────────────────────────────────────────────────────────────
  rel(absPath: string): string | null {
    const rel = path.relative(this.root, absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const posix = rel.split(path.sep).join("/");
    return posix.startsWith(".kenning/") ? null : posix;
  }

  abs(rel: string) {
    return path.join(this.root, ...rel.split("/"));
  }

  readCurrent(rel: string): string | null {
    try {
      return fs.readFileSync(this.abs(rel), "utf8");
    } catch {
      return null;
    }
  }

  // ── Baselines ────────────────────────────────────────────────────────────
  private baseFile(rel: string) {
    return this.p("base", createHash("sha1").update(rel).digest("hex").slice(0, 20) + ".json");
  }

  hasBaseline(rel: string) {
    return fs.existsSync(this.baseFile(rel));
  }

  /** Records what a file looked like before unreviewed changes. Keeps the oldest. */
  setBaseline(rel: string, content: string | null, { overwrite = false } = {}) {
    this.ensure();
    const file = this.baseFile(rel);
    if (!overwrite && fs.existsSync(file)) return false;
    const data: Baseline = { file: rel, content, createdAt: new Date().toISOString() };
    this.writeAtomic(file, JSON.stringify(data));
    return true;
  }

  getBaseline(rel: string): Baseline | null {
    try {
      return JSON.parse(fs.readFileSync(this.baseFile(rel), "utf8")) as Baseline;
    } catch {
      return null;
    }
  }

  listBaselines(): Baseline[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.p("base")).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Baseline[] = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(fs.readFileSync(this.p("base", n), "utf8")) as Baseline);
      } catch {
        // Half-written or corrupt: ignore, the next write replaces it.
      }
    }
    return out;
  }

  removeBaseline(rel: string) {
    fs.rmSync(this.baseFile(rel), { force: true });
  }

  // ── Events ───────────────────────────────────────────────────────────────
  appendEvent(e: AgentEvent) {
    this.ensure();
    const file = this.p("events.jsonl");
    try {
      if (fs.statSync(file).size > MAX_EVENTS_BYTES) {
        const keep = fs.readFileSync(file, "utf8").split("\n").slice(-200).join("\n");
        this.writeAtomic(file, keep);
      }
    } catch {
      // No file yet.
    }
    fs.appendFileSync(file, JSON.stringify(e) + "\n");
  }

  /** Events written after `offset` bytes, plus the new offset. */
  readEvents(offset: number): { events: AgentEvent[]; offset: number } {
    const file = this.p("events.jsonl");
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { events: [], offset: 0 };
    }
    if (size < offset) offset = 0; // the file was trimmed
    if (size === offset) return { events: [], offset };
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n") + 1; // only complete lines
    const events: AgentEvent[] = [];
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AgentEvent);
      } catch {
        // Skip a corrupt line.
      }
    }
    return { events, offset: offset + Buffer.byteLength(text.slice(0, end)) };
  }

  eventsSize(): number {
    try {
      return fs.statSync(this.p("events.jsonl")).size;
    } catch {
      return 0;
    }
  }

  // ── Flags ────────────────────────────────────────────────────────────────
  addFlag(f: Omit<Flag, "id" | "createdAt" | "delivered">): Flag {
    this.ensure();
    const flag: Flag = { ...f, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), delivered: false };
    this.writeAtomic(this.p("flags", `${flag.id}.json`), JSON.stringify(flag));
    return flag;
  }

  listFlags(): Flag[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.p("flags")).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Flag[] = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(fs.readFileSync(this.p("flags", n), "utf8")) as Flag);
      } catch {
        // ignore
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Marks pending flags delivered and returns them (used by the hook). */
  takePendingFlags(): Flag[] {
    const pending = this.listFlags().filter((f) => !f.delivered);
    const now = new Date().toISOString();
    for (const f of pending) {
      this.writeAtomic(this.p("flags", `${f.id}.json`), JSON.stringify({ ...f, delivered: true, deliveredAt: now }));
    }
    return pending;
  }

  /** Delivered flags older than a day are just noise. */
  pruneFlags(maxAgeMs = 24 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const f of this.listFlags()) {
      if (f.delivered && Date.parse(f.deliveredAt ?? f.createdAt) < cutoff) {
        fs.rmSync(this.p("flags", `${f.id}.json`), { force: true });
      }
    }
  }
}
