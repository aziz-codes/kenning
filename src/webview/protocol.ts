import type { DiffLine, Risk } from "../core/types";

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

export interface ViewState {
  agent: { working: boolean; since?: number; name: string };
  connected: boolean;
  claudeAvailable: boolean;
  hasWorkspace: boolean;
  provider: "claudeCode" | "anthropicApi" | "off";
  today: { reviewed: number; score: number | null; streak: number; correct: number; wrong: number; flagged: number };
  pendingLines: number;
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
  | { type: "reviewUncommitted" }
  | { type: "setupAi" };
