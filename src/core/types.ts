export type Severity = "high" | "medium" | "low";

export interface Risk {
  id: string;
  severity: Severity;
  title: string;
  /** The line that triggered it, trimmed. */
  detail?: string;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export type HunkKind = "edit" | "new" | "deleted";

export interface Hunk {
  /** Stable fingerprint: same change → same id, even if line numbers shift. */
  id: string;
  file: string;
  kind: HunkKind;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** What the model says about one change. */
export interface Insight {
  summary: string;
  why: string;
  question: string;
  options: string[];
  answer: number;
  explanation: string;
  concerns: string[];
}

export type Outcome = "correct" | "wrong" | "understood" | "flagged" | "skipped";

export interface Card {
  hunk: Hunk;
  symbol?: string;
  risks: Risk[];
  headline: string;
}

export interface Flag {
  id: string;
  file: string;
  line: number;
  comment: string;
  excerpt: string;
  createdAt: string;
  delivered: boolean;
  deliveredAt?: string;
}

/** One line of .kenning/events.jsonl, written by the Claude Code hook. */
export type AgentEvent =
  | { t: string; type: "turn-start"; session?: string }
  | { t: string; type: "edit"; file: string; tool: string; session?: string }
  | { t: string; type: "turn-end"; session?: string; blocked?: number };
