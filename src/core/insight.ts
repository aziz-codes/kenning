import { hunkToText } from "./hunks";
import type { Card, Insight } from "./types";

/** JSON Schema for the model's answer (used by both the API and Claude Code). */
export const INSIGHT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What changed, in at most 16 words. Plain English, no code fences." },
    why: { type: "string", description: "The most likely purpose of the change, in at most 24 words." },
    question: {
      type: "string",
      description: "One question that checks the developer understands what this change does or its effect. Not trivia about names.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Exactly 4 short answer options (at most 14 words each). One is correct; the others are plausible.",
    },
    answer: { type: "integer", description: "Index (0-3) of the correct option." },
    explanation: { type: "string", description: "Why the correct option is right, in at most 30 words." },
    concerns: {
      type: "array",
      items: { type: "string" },
      description: "Up to 2 concrete bugs or risks in this change, each at most 20 words. Empty if none.",
    },
  },
  required: ["summary", "why", "question", "options", "answer", "explanation", "concerns"],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You help a developer understand code that an AI coding agent just wrote, while the agent keeps working.
For the change you are given, explain it briefly and write one multiple-choice question that a developer can answer in about 15 seconds by reading the diff.
Good questions ask about behaviour: what happens for a given input, what case is now handled, what the change breaks or fixes.
Never ask about variable names, line numbers or trivia. Keep every field short. Only list concerns you would raise in a real code review.`;

/** The user message: the diff plus a little surrounding code. */
export function buildPrompt(card: Card, surrounding?: string): string {
  const { hunk } = card;
  const where =
    hunk.kind === "new" ? "a new file" : hunk.kind === "deleted" ? "a deleted file" : card.symbol ? `\`${card.symbol}\`` : "this file";
  const parts = [
    `File: ${hunk.file}`,
    `Change: ${card.headline} (${where}, +${hunk.added} −${hunk.removed})`,
    "",
    "Diff:",
    "```diff",
    hunkToText(hunk, 160),
    "```",
  ];
  if (surrounding && hunk.kind === "edit") {
    parts.push("", "Surrounding code after the change, for context:", "```", surrounding, "```");
  }
  if (card.risks.length) {
    parts.push("", `Automatic checks flagged: ${card.risks.map((r) => r.title).join("; ")}.`);
  }
  return parts.join("\n");
}

const clip = (s: unknown, max: number) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** Validates and normalises a model answer. Throws if it is unusable. */
export function parseInsight(raw: unknown): Insight {
  const o = (typeof raw === "string" ? JSON.parse(extractJson(raw)) : raw) as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("Answer is not an object");
  const options = Array.isArray(o.options) ? o.options.map((x) => clip(x, 160)).filter(Boolean) : [];
  const answer = Number(o.answer);
  if (options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
    throw new Error("Answer has no usable question");
  }
  const insight: Insight = {
    summary: clip(o.summary, 200),
    why: clip(o.why, 260),
    question: clip(o.question, 300),
    options: options.slice(0, 4),
    answer: Math.min(answer, 3),
    explanation: clip(o.explanation, 360),
    concerns: Array.isArray(o.concerns) ? o.concerns.map((c) => clip(c, 200)).filter(Boolean).slice(0, 2) : [],
  };
  if (!insight.summary || !insight.question) throw new Error("Answer is missing fields");
  return insight;
}

/** Pulls the first JSON object out of a reply that may have extra text. */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON in reply");
  return text.slice(start, end + 1);
}

/**
 * Models like to put the right answer first. Shuffle the options with a
 * seed from the card id, so the order is stable across re-renders.
 */
export function shuffleOptions(insight: Insight, seed: string): Insight {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const order = insight.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...insight, options: order.map((i) => insight.options[i]), answer: order.indexOf(insight.answer) };
}
