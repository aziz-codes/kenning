import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { formatFlagsForAgent } from "./core/flags";
import {
  addCursorHooks,
  addKenningHooks,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  hasCursorHooks,
  hasKenningHooks,
  HOOK_COMMAND,
  removeCursorHooks,
  removeKenningHooks,
} from "./core/hooksConfig";
import { firstChangedLine, fullFileDiff, hunkToText } from "./core/hunks";
import { languageFor, markInlineChanges } from "./core/inline";
import { buildReport } from "./core/report";
import type { AgentId, Outcome } from "./core/types";
import { Insights, type InsightConfig, type Provider } from "./services/insights";
import { Review, type Entry } from "./services/review";
import { bestStreak, lastDays, reviewedCount, Stats, streak, understandingScore } from "./services/stats";
import { Store } from "./services/store";
import type { AgentView, CardView, FromView, ToView, ViewState } from "./webview/protocol";

const API_KEY_SECRET = "kenning.anthropicApiKey";
const BASE_SCHEME = "kenning-base";
const MAX_CARD_LINES = 400;
const STALE_TURN_MS = 30 * 60 * 1000;
const PANEL_TYPE = "kenning.review";
const MAX_FILE_LINES = 6000;

/** Paths that are build output, dependencies or tooling noise. */
const IGNORED =
  /(^|\/)(\.git|node_modules|\.kenning|\.claude|dist|out|build|\.next|\.nuxt|\.svelte-kit|coverage|__pycache__|\.venv|venv|target|\.gradle|\.idea|\.vscode-test|\.turbo|\.cache)(\/|$)|(^|\/)\.(codex|cursor)\/hooks\.json$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.(log|map|min\.js|lock|tmp|swp|DS_Store)$/;

interface Root {
  folder: vscode.WorkspaceFolder;
  store: Store;
  offset: number;
  /** Agents whose hooks are installed in this folder. */
  agents: Set<AgentId>;
  git?: boolean;
}

type Json = Record<string, unknown>;

/** How Kenning plugs into each agent's hook settings. */
interface AgentDef {
  id: AgentId;
  name: string;
  /** The agent's hook settings, relative to the folder. */
  file: string;
  add(settings: Json, root: string): Json;
  remove(settings: Json): Json;
  has(settings: Json): boolean;
  connected: string;
}

/** Forward slashes work for node on every platform and need no escaping in JSON. */
const hookCommand = (root: string, agent: AgentId) =>
  `node "${path.join(root, ".kenning", "hook.js").split(path.sep).join("/")}" --agent ${agent}`;

const AGENTS: AgentDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    file: ".claude/settings.local.json",
    add: (s) => addKenningHooks(s, HOOK_COMMAND, CLAUDE_EVENTS),
    remove: (s) => removeKenningHooks(s),
    has: (s) => hasKenningHooks(s, CLAUDE_EVENTS),
    connected: "Kenning is connected. Changes from your next Claude Code prompt will appear in the Kenning panel.",
  },
  {
    id: "codex",
    name: "Codex",
    file: ".codex/hooks.json",
    add: (s, root) => addKenningHooks(s, hookCommand(root, "codex"), CODEX_EVENTS),
    remove: (s) => removeKenningHooks(s),
    has: (s) => hasKenningHooks(s, CODEX_EVENTS),
    connected:
      "Kenning is connected to Codex. Codex runs new hooks only after you trust them: run /hooks in Codex once, and make sure this project is trusted.",
  },
  {
    id: "cursor",
    name: "Cursor",
    file: ".cursor/hooks.json",
    add: (s, root) => addCursorHooks(s, hookCommand(root, "cursor")),
    remove: (s) => removeCursorHooks(s),
    has: (s) => hasCursorHooks(s),
    connected: "Kenning is connected to Cursor. Changes from Cursor's agent will appear here, and your flags reach it when its turn finishes.",
  },
];
const agentDef = (id: AgentId) => AGENTS.find((a) => a.id === id)!;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );
}

class Kenning implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider {
  private roots: Root[] = [];
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private status: vscode.StatusBarItem;
  private review: Review;
  private stats: Stats;
  private insights: Insights;
  private entries: Entry[] = [];
  private currentKey?: string;
  private index = 0;
  private apiKey?: string;
  private claudeAvailable = false;
  private codexAvailable = false;
  private agent: { working: boolean; since: number; last: number; id?: AgentId } = { working: false, since: 0, last: 0 };
  private externalUntil = 0;
  private flagNote?: string;
  private flagNoteTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private tracker: ExternalTracker;

  constructor(private ctx: vscode.ExtensionContext) {
    this.stats = new Stats(ctx.globalState);
    this.review = new Review(() => this.roots.map((r) => r.store), ctx.workspaceState);
    this.insights = new Insights(ctx.workspaceState, () => this.insightConfig(), () => this.scheduleRefresh(50));
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "kenning.focus";
    this.tracker = new ExternalTracker(this);
  }

  // ── Setup ────────────────────────────────────────────────────────────────
  async start() {
    const { ctx } = this;
    ctx.subscriptions.push(
      this.status,
      vscode.window.registerWebviewViewProvider("kenning.deck", this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
        deserializeWebviewPanel: async (panel) => this.attachPanel(panel),
      }),
      vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, this),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.loadRoots()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kenning.claudePath")) void this.detectClaude();
        if (e.affectsConfiguration("kenning")) this.scheduleRefresh();
      }),
      ctx.secrets.onDidChange(async (e) => {
        if (e.key === API_KEY_SECRET) {
          this.apiKey = await ctx.secrets.get(API_KEY_SECRET);
          this.scheduleRefresh();
        }
      }),
      vscode.commands.registerCommand("kenning.connectClaude", () => this.connectAgent("claude")),
      vscode.commands.registerCommand("kenning.connectCodex", () => this.connectAgent("codex")),
      vscode.commands.registerCommand("kenning.connectCursor", () => this.connectAgent("cursor")),
      vscode.commands.registerCommand("kenning.connectAgent", (id?: AgentId) => this.connectAgent(id)),
      vscode.commands.registerCommand("kenning.disconnectClaude", () => this.disconnectAgent("claude")),
      vscode.commands.registerCommand("kenning.disconnectAgent", (id?: AgentId) => this.disconnectAgent(id)),
      vscode.commands.registerCommand("kenning.openPanel", () => this.openPanel()),
      vscode.commands.registerCommand("kenning.copyReport", () => this.copyReport()),
      vscode.commands.registerCommand("kenning.reviewUncommitted", () => this.reviewUncommitted()),
      vscode.commands.registerCommand("kenning.focus", () => vscode.commands.executeCommand("kenning.deck.focus")),
      vscode.commands.registerCommand("kenning.setApiKey", () => this.setApiKey()),
      vscode.commands.registerCommand("kenning.clearApiKey", async () => {
        await ctx.secrets.delete(API_KEY_SECRET);
        vscode.window.showInformationMessage("Kenning: API key removed.");
      }),
      vscode.commands.registerCommand("kenning.resetStats", async () => {
        await this.stats.reset();
        this.scheduleRefresh();
      }),
    );
    this.apiKey = await ctx.secrets.get(API_KEY_SECRET);
    this.loadRoots();
    this.tracker.register(ctx);
    await this.detectClaude();

    const poll = setInterval(() => this.poll(), 1000);
    ctx.subscriptions.push({ dispose: () => clearInterval(poll) });
    this.refresh();
    void this.maybeOfferConnect();
  }

  private loadRoots() {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
    this.roots = folders.map((folder) => {
      const existing = this.roots.find((r) => r.folder.uri.toString() === folder.uri.toString());
      if (existing) return existing;
      const store = new Store(folder.uri.fsPath);
      const root: Root = { folder, store, offset: store.eventsSize(), agents: new Set() };
      for (const a of AGENTS) if (this.readHooksInstalled(root, a)) root.agents.add(a.id);
      if (root.agents.size) this.installHookScript(root);
      store.pruneFlags();
      return root;
    });
    this.scheduleRefresh();
  }

  rootFor(uri: vscode.Uri): Root | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder && this.roots.find((r) => r.folder.uri.toString() === folder.uri.toString());
  }

  private async detectClaude() {
    const cmd = vscode.workspace.getConfiguration("kenning").get<string>("claudePath") || "claude";
    const has = (bin: string) =>
      new Promise<boolean>((resolve) =>
        execFile(bin, ["--version"], { timeout: 15000, shell: process.platform === "win32", windowsHide: true }, (err) => resolve(!err)),
      );
    [this.claudeAvailable, this.codexAvailable] = await Promise.all([has(cmd), has("codex")]);
    this.scheduleRefresh();
  }

  private isCursor() {
    return /cursor/i.test(vscode.env.appName) || fs.existsSync(path.join(os.homedir(), ".cursor"));
  }

  private agentViews(): AgentView[] {
    const available: Record<AgentId, boolean> = { claude: this.claudeAvailable, codex: this.codexAvailable, cursor: this.isCursor() };
    return AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      connected: this.roots.some((r) => r.agents.has(a.id)),
      available: available[a.id],
    }));
  }

  private isConnected() {
    return this.roots.some((r) => r.agents.size > 0);
  }

  /** Who is (or was last) at work: the agent from the latest hook event, else the only connected one. */
  private agentName(): string {
    const short = (id: AgentId) => (id === "claude" ? "Claude" : agentDef(id).name);
    if (this.agent.id) return short(this.agent.id);
    const connected = AGENTS.filter((a) => this.roots.some((r) => r.agents.has(a.id)));
    return connected.length === 1 ? short(connected[0].id) : "Agent";
  }

  private insightConfig(): InsightConfig {
    const cfg = vscode.workspace.getConfiguration("kenning");
    const wanted = cfg.get<string>("ai.provider") ?? "auto";
    let provider: Provider = "off";
    if (wanted === "claudeCode") provider = "claudeCode";
    else if (wanted === "anthropicApi") provider = this.apiKey ? "anthropicApi" : "off";
    else if (wanted === "auto") provider = this.claudeAvailable ? "claudeCode" : this.apiKey ? "anthropicApi" : "off";
    return {
      provider,
      model: cfg.get<string>("ai.model") || "claude-opus-5-5",
      claudePath: cfg.get<string>("claudePath") || "claude",
      apiKey: this.apiKey,
    };
  }

  // ── Agent hooks ──────────────────────────────────────────────────────────
  private settingsPath(root: Root, agent: AgentDef) {
    return path.join(root.folder.uri.fsPath, ...agent.file.split("/"));
  }

  private readSettings(root: Root, agent: AgentDef): Json | null {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath(root, agent), "utf8"));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
    }
  }

  private readHooksInstalled(root: Root, agent: AgentDef) {
    const s = this.readSettings(root, agent);
    return !!s && agent.has(s);
  }

  private installHookScript(root: Root) {
    root.store.ensure();
    fs.copyFileSync(this.ctx.asAbsolutePath(path.join("dist", "hook.js")), path.join(root.store.dir, "hook.js"));
  }

  private async pickRoots(placeHolder: string): Promise<Root[]> {
    if (this.roots.length <= 1) return this.roots;
    const picked = await vscode.window.showQuickPick(
      this.roots.map((r) => ({ label: r.folder.name, root: r, picked: true })),
      { canPickMany: true, placeHolder },
    );
    return picked?.map((p) => p.root) ?? [];
  }

  private async pickAgent(placeHolder: string, only?: (a: AgentView) => boolean): Promise<AgentId | undefined> {
    const views = this.agentViews().filter(only ?? (() => true));
    if (views.length === 1) return views[0].id;
    const pick = await vscode.window.showQuickPick(
      views.map((a) => ({
        label: a.name,
        description: a.connected ? "connected" : a.available ? "detected" : "",
        detail: `Adds Kenning's hooks to ${agentDef(a.id).file}`,
        id: a.id,
      })),
      { placeHolder },
    );
    return pick?.id;
  }

  async connectAgent(id?: AgentId) {
    if (!this.roots.length) return vscode.window.showWarningMessage("Kenning: open a folder first.");
    id ??= await this.pickAgent("Connect Kenning to which agent?");
    if (!id) return;
    const agent = agentDef(id);
    let done = 0;
    for (const root of await this.pickRoots(`Connect which folders to ${agent.name}?`)) {
      const settings = this.readSettings(root, agent);
      const file = this.settingsPath(root, agent);
      if (!settings) {
        vscode.window.showErrorMessage(`Kenning: ${file} is not valid JSON, so it was left untouched.`);
        continue;
      }
      this.installHookScript(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(agent.add(settings, root.folder.uri.fsPath), null, 2) + "\n");
      await this.keepOutOfGit(root, agent.file);
      root.agents.add(id);
      root.offset = root.store.eventsSize();
      done++;
    }
    this.refresh();
    if (done) vscode.window.showInformationMessage(agent.connected);
  }

  async disconnectAgent(id?: AgentId) {
    id ??= await this.pickAgent("Disconnect Kenning from which agent?", (a) => a.connected);
    if (!id) return;
    const agent = agentDef(id);
    for (const root of await this.pickRoots("Disconnect which folders?")) {
      const settings = this.readSettings(root, agent);
      if (!settings || !fs.existsSync(this.settingsPath(root, agent))) continue;
      fs.writeFileSync(this.settingsPath(root, agent), JSON.stringify(agent.remove(settings), null, 2) + "\n");
      root.agents.delete(id);
    }
    this.refresh();
  }

  /** Personal settings must never be committed by accident. */
  private async keepOutOfGit(root: Root, rel: string) {
    const cwd = root.folder.uri.fsPath;
    try {
      await run("git", ["check-ignore", "-q", rel], cwd);
      return; // already ignored
    } catch {
      // not ignored, or not a repo
    }
    try {
      const gitDir = (await run("git", ["rev-parse", "--git-dir"], cwd)).trim();
      const exclude = path.resolve(cwd, gitDir, "info", "exclude");
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
      if (!current.split("\n").includes(rel)) fs.appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}${rel}\n`);
    } catch {
      // Not a git repository: nothing to do.
    }
  }

  private async maybeOfferConnect() {
    const asked = this.ctx.workspaceState.get<boolean>("kenning.askedConnect");
    if (asked || !this.claudeAvailable || this.isConnected()) return;
    const likely = this.roots.some(
      (r) => fs.existsSync(path.join(r.folder.uri.fsPath, ".claude")) || fs.existsSync(path.join(r.folder.uri.fsPath, "CLAUDE.md")),
    );
    if (!likely) return;
    await this.ctx.workspaceState.update("kenning.askedConnect", true);
    const choice = await vscode.window.showInformationMessage(
      "Kenning can turn every change Claude Code makes in this project into a quick review card. Connect it?",
      "Connect",
      "Not now",
    );
    if (choice === "Connect") await this.connectAgent("claude");
  }

  // ── Events from the hook ─────────────────────────────────────────────────
  private poll() {
    let changed = false;
    for (const root of this.roots) {
      const size = root.store.eventsSize();
      if (size === root.offset) continue;
      const { events, offset } = root.store.readEvents(root.offset);
      root.offset = offset;
      for (const e of events) {
        const at = Date.parse(e.t) || Date.now();
        this.agent.last = Math.max(this.agent.last, at);
        this.agent.id = e.agent ?? "claude";
        if (e.type === "turn-start") {
          this.agent.working = true;
          this.agent.since = at;
        } else if (e.type === "edit") {
          if (!this.agent.working) {
            this.agent.working = true;
            this.agent.since = at;
          }
          this.tracker.syncFromDisk(root, e.file);
        } else if (e.type === "turn-end") {
          this.agent.working = !!e.blocked; // a blocked stop means it keeps working
          if (!e.blocked) this.onTurnEnd();
        }
        changed = true;
      }
    }
    if (this.agent.working && Date.now() - this.agent.last > STALE_TURN_MS) {
      this.agent.working = false;
      changed = true;
    }
    if (changed) this.scheduleRefresh(100);
  }

  private onTurnEnd() {
    const enabled = vscode.workspace.getConfiguration("kenning").get<boolean>("notifyOnFinish") ?? true;
    setTimeout(() => {
      const waiting = this.entries.filter((e) => !e.outcome).length;
      if (!enabled || !waiting || this.view?.visible || this.panel?.visible) return;
      void vscode.window
        .showInformationMessage(`${this.agentName()} finished. ${waiting} change${waiting === 1 ? "" : "s"} waiting in Kenning.`, "Review")
        .then((c) => c === "Review" && vscode.commands.executeCommand("kenning.focus"));
    }, 400);
  }

  noteExternalActivity() {
    this.externalUntil = Date.now() + 8000;
  }

  isAgentWorking() {
    return this.agent.working || Date.now() < this.externalUntil;
  }

  // ── Deck ─────────────────────────────────────────────────────────────────
  scheduleRefresh(ms = 300) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), ms);
  }

  refresh() {
    this.entries = this.review.entries();
    const found = this.currentKey ? this.entries.findIndex((e) => e.key === this.currentKey) : -1;
    this.index = found >= 0 ? found : Math.min(this.index, Math.max(0, this.entries.length - 1));
    this.currentKey = this.entries[this.index]?.key;

    const prefetch = vscode.workspace.getConfiguration("kenning").get<number>("ai.prefetch") ?? 3;
    const ahead = [...this.entries.slice(this.index), ...this.entries.slice(0, this.index)].filter((e) => !e.outcome);
    for (const e of ahead.slice(0, Math.max(1, prefetch))) this.insights.request(e.card, this.surrounding(e));
    this.insights.retain(new Set(this.entries.map((e) => e.card.hunk.id)));

    this.updateStatus();
    this.post({ type: "state", state: this.viewState() });
  }

  private post(m: ToView) {
    void this.view?.webview.postMessage(m);
    void this.panel?.webview.postMessage(m);
  }

  private surrounding(e: Entry): string | undefined {
    const text = e.store.readCurrent(e.card.hunk.file);
    if (!text || e.card.hunk.kind !== "edit") return undefined;
    const lines = text.split(/\r?\n/);
    const at = firstChangedLine(e.card.hunk) - 1;
    return lines.slice(Math.max(0, at - 25), at + 35).join("\n");
  }

  currentState(): ViewState {
    return this.viewState();
  }

  receive(m: FromView) {
    return this.onMessage(m);
  }

  panelOpen() {
    return !!this.panel;
  }

  fileFor(key: string) {
    const e = this.entry(key);
    return e && this.fileView(e);
  }

  private viewState(): ViewState {
    const cfg = this.insightConfig();
    const today = this.stats.today();
    const multi = this.roots.length > 1;
    const cards: CardView[] = this.entries.map((e) => {
      const { hunk } = e.card;
      const ins = this.insights.get(hunk.id);
      const insight = ins?.insight;
      return {
        key: e.key,
        file: multi ? `${path.basename(e.store.root)}/${hunk.file}` : hunk.file,
        line: firstChangedLine(hunk),
        kind: hunk.kind,
        headline: e.card.headline,
        symbol: e.card.symbol,
        added: hunk.added,
        removed: hunk.removed,
        risks: e.card.risks,
        lines: markInlineChanges(hunk.lines.slice(0, MAX_CARD_LINES)),
        lang: languageFor(hunk.file),
        hiddenLines: Math.max(0, hunk.lines.length - MAX_CARD_LINES),
        ai: !ins
          ? { status: cfg.provider === "off" ? "off" : "loading" }
          : ins.status === "ready" && insight
            ? { status: "ready", ...insight }
            : { status: ins.status, error: ins.error },
        result: e.outcome ? { outcome: e.outcome, picked: e.picked, answer: insight?.answer } : undefined,
      };
    });
    const days = this.stats.all();
    return {
      agent: { working: this.isAgentWorking(), since: this.agent.working ? this.agent.since : undefined, name: this.agentName() },
      connected: this.isConnected(),
      agents: this.agentViews(),
      claudeAvailable: this.claudeAvailable,
      hasWorkspace: this.roots.length > 0,
      provider: cfg.provider,
      today: {
        reviewed: reviewedCount(today),
        score: understandingScore(today),
        streak: streak(this.stats.all()),
        correct: today.correct,
        wrong: today.wrong,
        flagged: today.flagged,
      },
      pendingLines: this.entries.filter((e) => !e.outcome).reduce((n, e) => n + e.card.hunk.added, 0),
      history: lastDays(days, 30).map((d) => ({
        day: d.day,
        reviewed: reviewedCount(d),
        understood: d.correct + d.understood,
        wrong: d.wrong,
        flagged: d.flagged,
        skipped: d.skipped,
        score: understandingScore(d),
      })),
      bestStreak: bestStreak(days),
      cards,
      index: this.index,
      flagNote: this.flagNote,
    };
  }

  private updateStatus() {
    const waiting = this.entries.filter((e) => !e.outcome).length;
    const score = understandingScore(this.stats.today());
    this.status.text = this.isAgentWorking() ? `$(sync~spin) Kenning ${waiting || ""}`.trim() : waiting ? `$(eye) ${waiting} to review` : "$(eye) Kenning";
    this.status.tooltip = new vscode.MarkdownString(
      `**Kenning**  \n${waiting ? `${waiting} AI change${waiting === 1 ? "" : "s"} waiting` : "All caught up"}${score === null ? "" : ` · ${score}% understood today`}`,
    );
    this.status.show();
    if (this.view) this.view.badge = waiting ? { value: waiting, tooltip: `${waiting} changes to review` } : undefined;
  }

  // ── Webviews: the sidebar deck and the full review in an editor tab ─────
  private html(webview: vscode.Webview, mode: "sidebar" | "panel") {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist");
    webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"><title>Kenning</title></head>
<body data-mode="${mode}"><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.html = this.html(view.webview, "sidebar");
    view.webview.onDidReceiveMessage((m: FromView) => this.onMessage(m, view.webview));
    view.onDidChangeVisibility(() => view.visible && this.refresh());
    view.onDidDispose(() => (this.view = undefined));
  }

  openPanel() {
    if (this.panel) return this.panel.reveal();
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, "Kenning Review", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.attachPanel(panel);
  }

  private attachPanel(panel: vscode.WebviewPanel) {
    this.panel?.dispose();
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "icon.png");
    panel.webview.html = this.html(panel.webview, "panel");
    panel.webview.onDidReceiveMessage((m: FromView) => this.onMessage(m, panel.webview));
    panel.onDidChangeViewState(() => panel.visible && this.refresh());
    panel.onDidDispose(() => this.panel === panel && (this.panel = undefined));
  }

  private entry(key: string) {
    return this.entries.find((e) => e.key === key);
  }

  private async onMessage(m: FromView, from?: vscode.Webview) {
    switch (m.type) {
      case "ready":
        return this.refresh();
      case "answer": {
        const e = this.entry(m.key);
        const insight = e && this.insights.get(e.card.hunk.id)?.insight;
        if (!e || !insight || e.outcome) return;
        return this.resolve(e, m.option === insight.answer ? "correct" : "wrong", m.option, true);
      }
      case "understood": {
        const e = this.entry(m.key);
        return e && this.resolve(e, "understood");
      }
      case "skip": {
        const e = this.entry(m.key);
        return e && this.resolve(e, "skipped");
      }
      case "flag": {
        const e = this.entry(m.key);
        return e && this.flag(e, m.comment);
      }
      case "next":
        return this.move(this.index + 1);
      case "prev":
        return this.move(this.index - 1);
      case "goto":
        return this.move(m.index);
      case "openDiff": {
        const e = this.entry(m.key);
        // From the full review tab, open the diff next to it rather than over it.
        return e && this.openDiff(e, from && from === this.panel?.webview ? vscode.ViewColumn.Beside : undefined);
      }
      case "loadFile": {
        const e = this.entry(m.key);
        if (e && from) void from.postMessage(this.fileView(e));
        return;
      }
      case "openPanel":
        return this.openPanel();
      case "copyReport":
        return this.copyReport();
      case "connectAgent":
        return this.connectAgent(m.agent);
      case "retryAi": {
        const e = this.entry(m.key);
        if (e) this.insights.request(e.card, this.surrounding(e), { retry: true });
        return;
      }
      case "connectClaude":
        return this.connectAgent("claude");
      case "reviewUncommitted":
        return this.reviewUncommitted();
      case "setupAi":
        return this.setupAi();
      case "shareImage":
        return this.saveShareImage(m.dataUrl);
    }
  }

  private async resolve(e: Entry, outcome: Outcome, picked?: number, keepShowing = false, comment?: string) {
    await this.review.resolve(e, outcome, picked, { keepShowing });
    await this.stats.record(outcome);
    const { hunk } = e.card;
    try {
      e.store.appendJournal({
        t: new Date().toISOString(),
        file: hunk.file,
        line: firstChangedLine(hunk),
        kind: hunk.kind,
        headline: e.card.headline,
        summary: this.insights.get(hunk.id)?.insight?.summary,
        outcome,
        added: hunk.added,
        removed: hunk.removed,
        risks: e.card.risks.map((r) => ({ severity: r.severity, title: r.title })),
        comment,
      });
    } catch {
      // The journal only feeds reports; never block a review on it.
    }
    if (!keepShowing) this.currentKey = undefined; // the card leaves; the next one slides in
    this.refresh();
  }

  private move(to: number) {
    const leaving = this.entries[this.index];
    const leavingAnswered = leaving && this.review.isShowing(leaving.key);
    if (leavingAnswered) this.review.dismiss(leaving.key);
    const count = this.entries.length - (leavingAnswered ? 1 : 0);
    // When the answered card disappears, the card after it takes its index.
    let target = leavingAnswered && to > this.index ? to - 1 : to;
    target = Math.max(0, Math.min(target, count - 1));
    this.index = target;
    this.currentKey = undefined;
    this.entries = this.review.entries();
    this.currentKey = this.entries[target]?.key;
    this.refresh();
  }

  private async flag(e: Entry, comment: string) {
    const root = this.roots.find((r) => r.store === e.store);
    const flag = {
      file: e.card.hunk.file,
      line: firstChangedLine(e.card.hunk),
      comment,
      excerpt: hunkToText(e.card.hunk, 12),
    };
    if (root?.agents.size) {
      e.store.addFlag(flag);
      const name = this.agentName();
      const cursorOnly = root.agents.size === 1 && root.agents.has("cursor");
      this.setFlagNote(
        cursorOnly
          ? this.agent.working
            ? "Sent. Cursor will pick this up as soon as its turn finishes."
            : "Saved. Cursor gets this when its next turn finishes."
          : this.agent.working
            ? `Sent. ${name} will address this before it finishes.`
            : `Saved. ${name} will get this with your next message.`,
      );
    } else {
      await vscode.env.clipboard.writeText(
        formatFlagsForAgent([{ ...flag, id: "", createdAt: "", delivered: false }]),
      );
      this.setFlagNote("Copied. Paste it into your agent's chat.");
    }
    await this.resolve(e, "flagged", undefined, false, comment);
  }

  private setFlagNote(note: string) {
    this.flagNote = note;
    clearTimeout(this.flagNoteTimer);
    this.flagNoteTimer = setTimeout(() => {
      this.flagNote = undefined;
      this.refresh();
    }, 6000);
  }

  // ── Diffs ────────────────────────────────────────────────────────────────
  provideTextDocumentContent(uri: vscode.Uri): string {
    const root = this.roots[Number(uri.query)] ?? this.roots[0];
    return root?.store.getBaseline(uri.path.replace(/^\//, ""))?.content ?? "";
  }

  /** The card's whole file as one diff, for the full-file view. */
  private fileView(e: Entry): ToView {
    const { hunk } = e.card;
    const before = e.store.getBaseline(hunk.file)?.content ?? null;
    const after = e.store.readCurrent(hunk.file);
    let { lines, focus } = fullFileDiff(before, after, hunk);
    let truncated = false;
    if (lines.length > MAX_FILE_LINES) {
      const from = Math.max(0, Math.min(focus[0] - MAX_FILE_LINES / 2, lines.length - MAX_FILE_LINES));
      lines = lines.slice(from, from + MAX_FILE_LINES);
      focus = [focus[0] - from, focus[1] - from];
      truncated = true;
    }
    return { type: "file", key: e.key, lines: markInlineChanges(lines), focus, truncated };
  }

  private async openDiff(e: Entry, viewColumn?: vscode.ViewColumn) {
    const { hunk } = e.card;
    const rootIndex = this.roots.findIndex((r) => r.store === e.store);
    const fileUri = vscode.Uri.file(e.store.abs(hunk.file));
    const baseUri = vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${hunk.file}`, query: String(rootIndex) });
    const line = Math.max(0, firstChangedLine(hunk) - 1);
    const selection = new vscode.Range(line, 0, line, 0);
    if (hunk.kind === "new") return vscode.window.showTextDocument(fileUri, { selection, preview: true, viewColumn });
    if (hunk.kind === "deleted") return vscode.window.showTextDocument(baseUri, { preview: true, viewColumn });
    await vscode.commands.executeCommand("vscode.diff", baseUri, fileUri, `${path.basename(hunk.file)}: before AI ↔ now`, {
      selection,
      preview: true,
      viewColumn,
    });
  }

  // ── Any agent: compare with the last commit ──────────────────────────────
  async isGit(root: Root): Promise<boolean> {
    if (root.git === undefined) {
      try {
        await run("git", ["rev-parse", "--is-inside-work-tree"], root.folder.uri.fsPath);
        root.git = true;
      } catch {
        root.git = false;
      }
    }
    return root.git;
  }

  async headContent(root: Root, rel: string): Promise<string | undefined> {
    if (!(await this.isGit(root))) return undefined;
    try {
      return await run("git", ["show", `HEAD:${rel}`], root.folder.uri.fsPath);
    } catch {
      return undefined;
    }
  }

  async isGitIgnored(root: Root, rel: string): Promise<boolean> {
    try {
      await run("git", ["check-ignore", "-q", rel], root.folder.uri.fsPath);
      return true;
    } catch {
      return false;
    }
  }

  async reviewUncommitted() {
    let added = 0;
    let gitRoots = 0;
    for (const root of this.roots) {
      if (!(await this.isGit(root))) continue;
      gitRoots++;
      const cwd = root.folder.uri.fsPath;
      const tracked = await run("git", ["diff", "--name-only", "HEAD"], cwd).catch(() => "");
      const untracked = await run("git", ["ls-files", "--others", "--exclude-standard"], cwd).catch(() => "");
      for (const rel of tracked.split("\n").filter(Boolean)) {
        if (IGNORED.test(rel)) continue;
        if (root.store.setBaseline(rel, (await this.headContent(root, rel)) ?? null)) added++;
      }
      for (const rel of untracked.split("\n").filter(Boolean)) {
        if (IGNORED.test(rel)) continue;
        if (root.store.setBaseline(rel, null)) added++;
      }
    }
    if (!gitRoots) {
      vscode.window.showInformationMessage("Kenning: this needs a git repository to know what changed.");
      return;
    }
    this.refresh();
    await vscode.commands.executeCommand("kenning.focus");
    if (!added && !this.entries.length) vscode.window.showInformationMessage("Kenning: no uncommitted changes to review.");
  }

  // ── Report ───────────────────────────────────────────────────────────────
  async copyReport() {
    const periods = [
      { label: "Today", days: 0 },
      { label: "Last 7 days", days: 6 },
      { label: "Last 30 days", days: 29 },
    ];
    const pick = await vscode.window.showQuickPick(periods, { placeHolder: "Summarise the AI changes you reviewed…" });
    if (!pick) return;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - pick.days);
    const multi = this.roots.length > 1;
    const entries = this.roots
      .flatMap((r) => r.store.readJournal(since.toISOString()).map((e) => (multi ? { ...e, file: `${r.folder.name}/${e.file}` } : e)))
      .sort((a, b) => a.t.localeCompare(b.t));
    const markdown = buildReport(entries, pick.label);
    await vscode.env.clipboard.writeText(markdown);
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
    await vscode.window.showTextDocument(doc, { preview: true });
    vscode.window.showInformationMessage("Kenning: review summary copied, ready for your pull request.");
  }

  // ── Share card ───────────────────────────────────────────────────────────
  private async saveShareImage(dataUrl: string) {
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!match) return;
    const d = new Date();
    const name = `kenning-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.png`;
    const home = vscode.Uri.file(os.homedir());
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(home, name),
      filters: { Image: ["png"] },
      title: "Save today's Kenning card",
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(match[1], "base64"));
    const choice = await vscode.window.showInformationMessage("Your Kenning card is saved, ready to share.", "Open", "Show in folder");
    if (choice === "Open") await vscode.env.openExternal(target);
    if (choice === "Show in folder") await vscode.commands.executeCommand("revealFileInOS", target);
  }

  // ── AI setup ─────────────────────────────────────────────────────────────
  private async setupAi() {
    const items: (vscode.QuickPickItem & { value: string })[] = [
      {
        label: "$(terminal) Use Claude Code",
        description: this.claudeAvailable ? "detected" : "not found",
        detail: "Uses your Claude Code login. Nothing else to set up.",
        value: "claudeCode",
      },
      { label: "$(key) Use an Anthropic API key", detail: "Stored in VS Code's secret storage.", value: "anthropicApi" },
      { label: "$(circle-slash) No AI", detail: "Cards still show the change and risk flags.", value: "off" },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Where should Kenning get summaries and questions?" });
    if (!pick) return;
    if (pick.value === "anthropicApi" && !this.apiKey && !(await this.setApiKey())) return;
    await vscode.workspace.getConfiguration("kenning").update("ai.provider", pick.value, vscode.ConfigurationTarget.Global);
    this.refresh();
  }

  private async setApiKey(): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      prompt: "Anthropic API key",
      placeHolder: "sk-ant-…",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().startsWith("sk-") ? undefined : "This doesn't look like an Anthropic API key."),
    });
    if (!key) return false;
    await this.ctx.secrets.store(API_KEY_SECRET, key.trim());
    this.apiKey = key.trim();
    vscode.window.showInformationMessage("Kenning: API key saved.");
    return true;
  }
}

/**
 * Notices files changed outside the editor (other agents, scripts) and records
 * what they looked like before, from the open document or the last commit.
 * The developer's own saves and git operations (checkout, pull) are ignored.
 */
class ExternalTracker {
  private known = new Map<string, string>();
  private userSaved = new Map<string, number>();
  private gitBusyUntil = 0;
  private recent: number[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private k: Kenning) {}

  register(ctx: vscode.ExtensionContext) {
    const remember = (d: vscode.TextDocument) => d.uri.scheme === "file" && this.known.set(d.uri.fsPath, d.getText());
    vscode.workspace.textDocuments.forEach(remember);
    const files = vscode.workspace.createFileSystemWatcher("**/*");
    const git = vscode.workspace.createFileSystemWatcher("**/.git/{HEAD,index,ORIG_HEAD,MERGE_HEAD,FETCH_HEAD,REBASE_HEAD}");
    const gitBusy = () => (this.gitBusyUntil = Date.now() + 4000);
    ctx.subscriptions.push(
      files,
      git,
      vscode.workspace.onDidOpenTextDocument(remember),
      // Typing makes the document dirty; a reload from disk does not.
      vscode.workspace.onDidChangeTextDocument((e) => e.document.isDirty && remember(e.document)),
      vscode.workspace.onWillSaveTextDocument((e) => this.userSaved.set(e.document.uri.fsPath, Date.now())),
      vscode.workspace.onDidSaveTextDocument((d) => {
        this.userSaved.set(d.uri.fsPath, Date.now());
        remember(d);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.known.delete(d.uri.fsPath)),
      // Changing a setting makes VS Code itself rewrite .vscode/settings.json.
      vscode.workspace.onDidChangeConfiguration(() => {
        for (const f of vscode.workspace.workspaceFolders ?? []) this.userSaved.set(path.join(f.uri.fsPath, ".vscode", "settings.json"), Date.now());
      }),
      files.onDidChange((u) => this.changed(u, "change")),
      files.onDidCreate((u) => this.changed(u, "create")),
      files.onDidDelete((u) => this.changed(u, "delete")),
      git.onDidChange(gitBusy),
      git.onDidCreate(gitBusy),
      git.onDidDelete(gitBusy),
    );
  }

  /** After a hook-reported edit, the disk is the new "known" state. */
  syncFromDisk(root: Root, rel: string) {
    const abs = root.store.abs(rel);
    const text = root.store.readCurrent(rel);
    if (text !== null && this.known.has(abs)) this.known.set(abs, text);
  }

  private changed(uri: vscode.Uri, kind: "change" | "create" | "delete") {
    if (!vscode.workspace.getConfiguration("kenning").get<boolean>("watchExternalChanges", true)) return;
    const root = this.k.rootFor(uri);
    const rel = root?.store.rel(uri.fsPath);
    if (!root || !rel || IGNORED.test(rel)) return;
    const now = Date.now();
    if (now - (this.userSaved.get(uri.fsPath) ?? 0) < 2500 || now < this.gitBusyUntil) return;
    this.recent = [...this.recent.filter((t) => now - t < 3000), now];
    if (this.recent.length > 40 && !this.k.isAgentWorking()) return; // mass rewrite, e.g. a formatter or generator

    clearTimeout(this.timers.get(uri.fsPath));
    // Wait for the agent to finish writing, and for the Claude Code hook,
    // which knows the exact previous content, to record it first.
    this.timers.set(
      uri.fsPath,
      setTimeout(() => {
        this.timers.delete(uri.fsPath);
        void this.capture(root, rel, uri.fsPath, kind);
      }, 1200),
    );
  }

  private async capture(root: Root, rel: string, abs: string, kind: "change" | "create" | "delete") {
    if (Date.now() < this.gitBusyUntil || Date.now() - (this.userSaved.get(abs) ?? 0) < 4000) return;
    const current = root.store.readCurrent(rel);
    if (root.store.hasBaseline(rel)) {
      if (current !== null) this.known.set(abs, current);
      this.k.scheduleRefresh();
      return;
    }
    let before: string | null | undefined = this.known.get(abs);
    if (before === undefined) before = await this.k.headContent(root, rel);
    if (before === undefined && kind === "create" && (await this.k.isGit(root)) && !(await this.k.isGitIgnored(root, rel))) {
      before = null; // a new, untracked file
    }
    if (before === undefined || before === current) return;
    root.store.setBaseline(rel, before);
    if (current !== null) this.known.set(abs, current);
    this.k.noteExternalActivity();
    this.k.scheduleRefresh(100);
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  const kenning = new Kenning(ctx);
  await kenning.start();
  // Used by the integration tests; not a public API.
  return {
    state: () => kenning.currentState(),
    send: (m: FromView) => kenning.receive(m),
    refresh: () => kenning.refresh(),
    panelOpen: () => kenning.panelOpen(),
    file: (key: string) => kenning.fileFor(key),
  };
}

export function deactivate() {}
