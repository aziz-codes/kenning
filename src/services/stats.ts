import type { Outcome } from "../core/types";

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

export interface DayStats {
  correct: number;
  wrong: number;
  understood: number;
  flagged: number;
  skipped: number;
}

const KEY = "kenning.days";
const EMPTY: DayStats = { correct: 0, wrong: 0, understood: 0, flagged: 0, skipped: 0 };

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const reviewedCount = (s: DayStats) => s.correct + s.wrong + s.understood + s.flagged + s.skipped;

/**
 * Share of today's reviewed changes the developer showed they understood.
 * Correct answers, "got it" and flags count; wrong answers and skips don't.
 */
export function understandingScore(s: DayStats): number | null {
  const total = reviewedCount(s);
  return total ? Math.round(((s.correct + s.understood + s.flagged) / total) * 100) : null;
}

/** Consecutive days (ending today, or yesterday if today is empty) with 3+ reviews. */
export function streak(days: Record<string, DayStats>, today = new Date()): number {
  const d = new Date(today);
  if (reviewedCount(days[dayKey(d)] ?? EMPTY) < 3) d.setDate(d.getDate() - 1);
  let n = 0;
  while (reviewedCount(days[dayKey(d)] ?? EMPTY) >= 3) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** The longest run of days with 3+ reviews. */
export function bestStreak(days: Record<string, DayStats>): number {
  let best = 0;
  let run = 0;
  let prev: Date | undefined;
  for (const key of Object.keys(days).sort()) {
    if (reviewedCount(days[key]) < 3) {
      run = 0;
      prev = undefined;
      continue;
    }
    const d = new Date(`${key}T12:00:00`);
    const next = prev && new Date(prev.getTime() + 24 * 3600 * 1000);
    run = next && dayKey(next) === key ? run + 1 : 1;
    prev = d;
    best = Math.max(best, run);
  }
  return best;
}

/** The last `n` days, oldest first, with empty days filled in. */
export function lastDays(days: Record<string, DayStats>, n: number, today = new Date()): ({ day: string } & DayStats)[] {
  const out: ({ day: string } & DayStats)[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = dayKey(d);
    out.push({ day, ...EMPTY, ...(days[day] ?? {}) });
  }
  return out;
}

export class Stats {
  constructor(private memo: Memento) {}

  all(): Record<string, DayStats> {
    return this.memo.get<Record<string, DayStats>>(KEY) ?? {};
  }

  today(): DayStats {
    return { ...EMPTY, ...(this.all()[dayKey()] ?? {}) };
  }

  async record(outcome: Outcome) {
    const days = this.all();
    const key = dayKey();
    const day = { ...EMPTY, ...(days[key] ?? {}) };
    day[outcome]++;
    days[key] = day;
    // Keep a year of history.
    const keys = Object.keys(days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 366))) delete days[k];
    await this.memo.update(KEY, days);
  }

  async reset() {
    await this.memo.update(KEY, {});
  }
}
