// A Markdown summary of reviewed AI changes, for a pull request or a standup.
import type { JournalEntry } from "../services/store";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const OUTCOME: Record<string, string> = {
  correct: "answered correctly",
  wrong: "answered wrongly",
  understood: "understood",
  flagged: "flagged",
  skipped: "skipped",
};

const where = (e: JournalEntry) => `\`${e.file}:${e.line}\``;
const what = (e: JournalEntry) => (e.summary || e.headline).replace(/\s+/g, " ").trim();

export function buildReport(entries: JournalEntry[], period: string): string {
  if (!entries.length) return `## AI changes reviewed with Kenning\n\n_${period}: nothing reviewed yet._\n`;
  const files = new Set(entries.map((e) => e.file));
  const count = (o: string) => entries.filter((e) => e.outcome === o).length;
  const understood = count("correct") + count("understood") + count("flagged");
  const score = Math.round((understood / entries.length) * 100);
  const added = entries.reduce((n, e) => n + e.added, 0);
  const removed = entries.reduce((n, e) => n + e.removed, 0);

  const out = [
    "## AI changes reviewed with Kenning",
    "",
    `_${period} · ${plural(entries.length, "change")} in ${plural(files.size, "file")} · +${added} −${removed} lines · ${score}% understood_`,
    "",
    "| Outcome | Changes |",
    "|---|---|",
    ...["correct", "understood", "flagged", "wrong", "skipped"].filter((o) => count(o)).map((o) => `| ${OUTCOME[o]} | ${count(o)} |`),
  ];

  const flagged = entries.filter((e) => e.outcome === "flagged");
  if (flagged.length) {
    out.push("", "### Flagged for the agent", "");
    for (const e of flagged) out.push(`- ${where(e)} — ${e.comment ? `**${e.comment.trim()}**` : "flagged"} _(${what(e)})_`);
  }

  const risky = entries.filter((e) => e.outcome !== "flagged" && e.risks.some((r) => r.severity === "high"));
  if (risky.length) {
    out.push("", "### High-risk changes", "");
    for (const e of risky) {
      const risks = e.risks.filter((r) => r.severity === "high").map((r) => r.title).join(", ");
      out.push(`- ${where(e)} — ${risks} · ${OUTCOME[e.outcome]}`);
    }
  }

  const skipped = entries.filter((e) => e.outcome === "skipped");
  if (skipped.length) {
    out.push("", "### Not reviewed (skipped)", "");
    for (const e of skipped) out.push(`- ${where(e)} — ${what(e)}`);
  }

  out.push("", "<details><summary>Every change</summary>", "");
  for (const e of entries) out.push(`- ${where(e)} ${what(e)} · ${OUTCOME[e.outcome]}`);
  out.push("", "</details>", "");
  return out.join("\n");
}
