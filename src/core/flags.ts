import type { Flag } from "./types";

/** The message the agent receives for the developer's flags. */
export function formatFlagsForAgent(flags: Flag[]): string {
  const items = flags.map((f, i) => {
    const excerpt = f.excerpt
      .split("\n")
      .slice(0, 8)
      .map((l) => `     ${l}`)
      .join("\n");
    return `${i + 1}. ${f.file}:${f.line} — ${f.comment}${excerpt ? `\n   The change in question:\n${excerpt}` : ""}`;
  });
  return [
    "Kenning: the developer reviewed your recent changes and flagged the following.",
    "Address each item (fix it, or explain briefly why it is correct), then continue.",
    "",
    ...items,
  ].join("\n");
}
