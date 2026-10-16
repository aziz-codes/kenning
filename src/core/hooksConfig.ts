// Adds and removes Kenning's hooks in a Claude Code settings object
// (.claude/settings.local.json), leaving every other setting untouched.

export const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.kenning/hook.js"';
const MARK = ".kenning/hook.js";

type HookEntry = { type: string; command?: string; [k: string]: unknown };
type Matcher = { matcher?: string; hooks: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, Matcher[]>; [k: string]: unknown };

const OURS: Record<string, string | undefined> = {
  UserPromptSubmit: undefined,
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  Stop: undefined,
};

const isOurs = (h: HookEntry) => typeof h.command === "string" && h.command.includes(MARK);

export function removeKenningHooks<T extends Settings>(settings: T): T {
  if (!settings.hooks) return settings;
  const hooks: Record<string, Matcher[]> = {};
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    const kept = matchers
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((m) => m.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = settings;
  return (Object.keys(hooks).length ? { ...rest, hooks } : rest) as T;
}

export function addKenningHooks<T extends Settings>(settings: T, command = HOOK_COMMAND): T & { hooks: Record<string, Matcher[]> } {
  const clean = removeKenningHooks(settings);
  const hooks: Record<string, Matcher[]> = { ...(clean.hooks ?? {}) };
  for (const [event, matcher] of Object.entries(OURS)) {
    const entry: Matcher = { hooks: [{ type: "command", command }] };
    if (matcher) entry.matcher = matcher;
    hooks[event] = [...(hooks[event] ?? []), entry];
  }
  return { ...clean, hooks };
}

export function hasKenningHooks(settings: Settings): boolean {
  return Object.keys(OURS).every((event) =>
    (settings.hooks?.[event] ?? []).some((m) => (m.hooks ?? []).some(isOurs)),
  );
}
