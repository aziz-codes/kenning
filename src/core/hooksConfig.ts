// Adds and removes Kenning's hooks in an agent's hook settings, leaving every
// other setting untouched:
//   Claude Code  .claude/settings.local.json   { hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }
//   Codex        .codex/hooks.json             same shape as Claude Code
//   Cursor       .cursor/hooks.json            { version: 1, hooks: { event: [{ command }] } }

export const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.kenning/hook.js"';
const isOursCommand = (c: unknown) => typeof c === "string" && /\.kenning[\\/]hook\.js/.test(c);

type HookEntry = { type: string; command?: string; [k: string]: unknown };
type Matcher = { matcher?: string; hooks: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, Matcher[]>; [k: string]: unknown };

/** Event → matcher (undefined = every occurrence). */
export type EventMap = Record<string, string | undefined>;

export const CLAUDE_EVENTS: EventMap = {
  UserPromptSubmit: undefined,
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  Stop: undefined,
};

/** Codex reports every file edit as apply_patch; PreToolUse sees the file before it changes. */
export const CODEX_EVENTS: EventMap = {
  UserPromptSubmit: undefined,
  PreToolUse: "apply_patch|Edit|Write",
  PostToolUse: "apply_patch|Edit|Write",
  Stop: undefined,
};

const isOurs = (h: HookEntry) => isOursCommand(h.command);

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

export function addKenningHooks<T extends Settings>(
  settings: T,
  command = HOOK_COMMAND,
  events: EventMap = CLAUDE_EVENTS,
): T & { hooks: Record<string, Matcher[]> } {
  const clean = removeKenningHooks(settings);
  const hooks: Record<string, Matcher[]> = { ...(clean.hooks ?? {}) };
  for (const [event, matcher] of Object.entries(events)) {
    const entry: Matcher = { hooks: [{ type: "command", command }] };
    if (matcher) entry.matcher = matcher;
    hooks[event] = [...(hooks[event] ?? []), entry];
  }
  return { ...clean, hooks };
}

export function hasKenningHooks(settings: Settings, events: EventMap = CLAUDE_EVENTS): boolean {
  return Object.keys(events).every((event) =>
    (settings.hooks?.[event] ?? []).some((m) => (m.hooks ?? []).some(isOurs)),
  );
}

// ── Cursor ───────────────────────────────────────────────────────────────────
type CursorHook = { command: string; [k: string]: unknown };
type CursorSettings = { version?: number; hooks?: Record<string, CursorHook[]>; [k: string]: unknown };

export const CURSOR_EVENTS = ["beforeSubmitPrompt", "afterFileEdit", "stop"] as const;

export function removeCursorHooks<T extends CursorSettings>(settings: T): T {
  if (!settings.hooks) return settings;
  const hooks: Record<string, CursorHook[]> = {};
  for (const [event, list] of Object.entries(settings.hooks)) {
    const kept = (list ?? []).filter((h) => !isOursCommand(h.command));
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = settings;
  return (Object.keys(hooks).length ? { ...rest, hooks } : rest) as T;
}

export function addCursorHooks<T extends CursorSettings>(settings: T, command: string): T & { version: number; hooks: Record<string, CursorHook[]> } {
  const clean = removeCursorHooks(settings);
  const hooks: Record<string, CursorHook[]> = { ...(clean.hooks ?? {}) };
  for (const event of CURSOR_EVENTS) hooks[event] = [...(hooks[event] ?? []), { command }];
  return { ...clean, version: clean.version ?? 1, hooks };
}

export function hasCursorHooks(settings: CursorSettings): boolean {
  return CURSOR_EVENTS.every((event) => (settings.hooks?.[event] ?? []).some((h) => isOursCommand(h.command)));
}
