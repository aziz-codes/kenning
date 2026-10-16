import { buildHunks } from "./hunks";
import { detectRisks, severityRank } from "./risk";
import { enclosingSymbol } from "./symbols";
import type { Card, Hunk } from "./types";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function headlineFor(h: Hunk, symbol?: string): string {
  if (h.kind === "new") return `New file · ${plural(h.added, "line")}`;
  if (h.kind === "deleted") return `Deleted file · ${plural(h.removed, "line")}`;
  const what = h.added && h.removed ? "Changed" : h.added ? "Added code" : "Removed code";
  return symbol ? `${what} in ${symbol}` : `${what} near line ${h.newStart}`;
}

/** Builds review cards for one file from its baseline and current content. */
export function cardsForFile(file: string, before: string | null, after: string | null): Card[] {
  const afterLines = after?.split(/\r?\n/) ?? [];
  const beforeLines = before?.split(/\r?\n/) ?? [];
  return buildHunks(file, before, after).map((hunk) => {
    const first = hunk.lines.find((l) => l.kind !== "ctx");
    const symbol =
      hunk.kind === "edit"
        ? first?.newNo !== undefined
          ? enclosingSymbol(afterLines, first.newNo - 1)
          : enclosingSymbol(beforeLines, (first?.oldNo ?? hunk.oldStart) - 1)
        : undefined;
    return { hunk, symbol, risks: detectRisks(hunk), headline: headlineFor(hunk, symbol) };
  });
}

/** Riskiest first, then by file and position. */
export function sortCards(cards: Card[]): Card[] {
  const top = (c: Card) => (c.risks[0] ? severityRank(c.risks[0].severity) : 0);
  return [...cards].sort(
    (a, b) => top(b) - top(a) || a.hunk.file.localeCompare(b.hunk.file) || a.hunk.newStart - b.hunk.newStart,
  );
}
