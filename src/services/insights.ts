import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import os from "node:os";
import { buildPrompt, INSIGHT_SCHEMA, parseInsight, shuffleOptions, SYSTEM_PROMPT } from "../core/insight";
import type { Card, Insight } from "../core/types";
import type { Memento } from "./stats";

export type Provider = "claudeCode" | "anthropicApi" | "off";

export interface InsightState {
  status: "loading" | "ready" | "error";
  insight?: Insight;
  error?: string;
}

export interface InsightConfig {
  provider: Provider;
  model: string;
  claudePath: string;
  apiKey?: string;
}

const CACHE_KEY = "kenning.insights";
const CACHE_MAX = 400;
const TIMEOUT_MS = 120_000;

/** Runs Claude Code headless, isolated from the project and the user's hooks. */
export function askClaudeCode(cfg: InsightConfig, prompt: string): Promise<unknown> {
  const args = [
    "-p",
    "--model", cfg.model,
    "--effort", "low",
    "--output-format", "json",
    "--json-schema", JSON.stringify(INSIGHT_SCHEMA),
    "--system-prompt", SYSTEM_PROMPT,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "local",
    "--no-session-persistence",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.claudePath, args, {
      cwd: os.tmpdir(),
      env: { ...process.env, KENNING_INTERNAL: "1" },
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude Code took too long"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out) as { is_error?: boolean; structured_output?: unknown; result?: string };
        if (result.is_error) return reject(new Error(result.result || "Claude Code returned an error"));
        resolve(result.structured_output ?? result.result);
      } catch {
        reject(new Error((err || out).trim().split("\n").pop() || "Claude Code did not answer"));
      }
    });
    child.stdin.end(prompt);
  });
}

/** Calls the Messages API with the developer's own key. */
export async function askAnthropicApi(cfg: InsightConfig, prompt: string): Promise<unknown> {
  const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 2, timeout: TIMEOUT_MS });
  const response = await client.beta.messages.create({
    model: cfg.model,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    output_config: { effort: "low", format: { type: "json_schema", schema: INSIGHT_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined to describe this change");
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return text;
}

/**
 * Prepares summaries and questions for cards, one at a time, and caches them
 * by change fingerprint so nothing is generated twice.
 */
export class Insights {
  private state = new Map<string, InsightState>();
  private queue: { id: string; card: Card; surrounding?: string }[] = [];
  private running = false;
  private stored: Record<string, Insight>;

  constructor(
    private memo: Memento,
    private config: () => InsightConfig,
    private onChange: () => void,
  ) {
    this.stored = memo.get<Record<string, Insight>>(CACHE_KEY) ?? {};
  }

  get(id: string): InsightState | undefined {
    const s = this.state.get(id);
    if (s) return s;
    const saved = this.stored[id];
    return saved ? { status: "ready", insight: saved } : undefined;
  }

  /** Queues a card unless it is ready, queued, or AI is off. */
  request(card: Card, surrounding?: string, { retry = false } = {}) {
    const id = card.hunk.id;
    if (this.config().provider === "off") return;
    const current = this.get(id);
    if (current && !(retry && current.status === "error")) return;
    this.state.set(id, { status: "loading" });
    this.queue.push({ id, card, surrounding });
    this.onChange();
    void this.pump();
  }

  /** Drops queued work for cards that are no longer in the deck. */
  retain(ids: Set<string>) {
    this.queue = this.queue.filter((q) => {
      if (ids.has(q.id)) return true;
      this.state.delete(q.id);
      return false;
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      const cfg = this.config();
      try {
        const prompt = buildPrompt(job.card, job.surrounding);
        const raw = cfg.provider === "claudeCode" ? await askClaudeCode(cfg, prompt) : await askAnthropicApi(cfg, prompt);
        const insight = shuffleOptions(parseInsight(raw), job.id);
        this.state.set(job.id, { status: "ready", insight });
        this.save(job.id, insight);
      } catch (e) {
        this.state.set(job.id, { status: "error", error: friendlyError(e) });
      }
      this.onChange();
    }
    this.running = false;
  }

  private save(id: string, insight: Insight) {
    this.stored[id] = insight;
    const ids = Object.keys(this.stored);
    for (const old of ids.slice(0, Math.max(0, ids.length - CACHE_MAX))) delete this.stored[old];
    void this.memo.update(CACHE_KEY, this.stored);
  }
}

function friendlyError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Try again shortly.";
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ""}`.trim();
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOENT/.test(msg)) return "Claude Code was not found. Set “kenning.claudePath” or use an API key.";
  if (/not logged in|\/login/i.test(msg)) return "Claude Code is not logged in. Run “claude” once to log in.";
  return msg.slice(0, 160);
}
