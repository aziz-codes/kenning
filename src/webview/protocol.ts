import type { AgentId, DiffLine, Risk } from "../core/types";

export interface CardView {
  key: string;
  file: string;
  line: number;
  kind: "edit" | "new" | "deleted";
  headline: string;
  symbol?: string;
  added: number;
  removed: number;
  risks: Risk[];
  lines: DiffLine[];
  hiddenLines: number;
  /** highlight.js language id. */
  lang?: string;
  ai: {
    status: "off" | "loading" | "ready" | "error";
    summary?: string;
    why?: string;
    question?: string;
    options?: string[];
    explanation?: string;
    concerns?: string[];
    error?: string;
  };
  /** Present once the developer has acted on the card. */
  result?: { outcome: string; picked?: number; answer?: number };
}

export interface AgentView {
  id: AgentId;
  name: string;
  /** Kenning's hooks are installed in at least one folder. */
  connected: boolean;
  /** The agent looks installed (on PATH, or this editor is Cursor). */
  available: boolean;
}

export interface DayView {
  day: string;
  reviewed: number;
  understood: number;
  wrong: number;
  flagged: number;
  skipped: number;
  score: number | null;
}

export interface ViewState {
  agent: { working: boolean; since?: number; name: string };
  connected: boolean;
  agents: AgentView[];
  claudeAvailable: boolean;
  hasWorkspace: boolean;
  provider: "claudeCode" | "anthropicApi" | "off";
  today: { reviewed: number; score: number | null; streak: number; correct: number; wrong: number; flagged: number };
  pendingLines: number;
  /** The last 30 days, oldest first. */
  history: DayView[];
  bestStreak: number;
  cards: CardView[];
  index: number;
  flagNote?: string;
}

export type FromView =
  | { type: "ready" }
  | { type: "answer"; key: string; option: number }
  | { type: "understood"; key: string }
  | { type: "skip"; key: string }
  | { type: "flag"; key: string; comment: string }
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "openDiff"; key: string }
  | { type: "retryAi"; key: string }
  | { type: "connectClaude" }
  | { type: "connectAgent"; agent?: AgentId }
  | { type: "openPanel" }
  | { type: "loadFile"; key: string }
  | { type: "copyReport" }
  | { type: "reviewUncommitted" }
  | { type: "setupAi" }
  | { type: "shareImage"; dataUrl: string };

/** Messages from the extension to a webview. */
export type ToView =
  | { type: "state"; state: ViewState }
  | { type: "file"; key: string; lines: DiffLine[]; focus: [number, number]; truncated: boolean };
