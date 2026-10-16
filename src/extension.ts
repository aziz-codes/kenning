import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { formatFlagsForAgent } from "./core/flags";
import { addKenningHooks, hasKenningHooks, removeKenningHooks } from "./core/hooksConfig";
import { firstChangedLine, hunkToText } from "./core/hunks";
import type { Outcome } from "./core/types";
import { Insights, type InsightConfig, type Provider } from "./services/insights";
import { Review, type Entry } from "./services/review";
import { reviewedCount, Stats, streak, understandingScore } from "./services/stats";
import { Store } from "./services/store";
import type { CardView, FromView, ViewState } from "./webview/protocol";

const API_KEY_SECRET = "kenning.anthropicApiKey";
const BASE_SCHEME = "kenning-base";
const MAX_CARD_LINES = 400;
const STALE_TURN_MS = 30 * 60 * 1000;

/** Paths that are build output, dependencies or tooling noise. */
const IGNORED =
  /(^|\/)(\.git|node_modules|\.kenning|\.claude|dist|out|build|\.next|\.nuxt|\.svelte-kit|coverage|__pycache__|\.venv|venv|target|\.gradle|\.idea|\.vscode-test|\.turbo|\.cache)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.(log|map|min\.js|lock|tmp|swp|DS_Store)$/;

interface Root {
  folder: vscode.WorkspaceFolder;
  store: Store;
  offset: number;
  connected: boolean;
  git?: boolean;
}

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
  private status: vscode.StatusBarItem;
  private review: Review;
  private stats: Stats;
  private insights: Insights;
  private entries: Entry[] = [];
  private currentKey?: string;
  private index = 0;
  private apiKey?: string;
  private claudeAvailable = false;
  private agent = { working: false, since: 0, last: 0 };
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
      vscode.commands.registerCommand("kenning.connectClaude", () => this.connectClaude()),
      vscode.commands.registerCommand("kenning.disconnectClaude", () => this.disconnectClaude()),
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
      const root: Root = { folder, store, offset: store.eventsSize(), connected: false };
      root.connected = this.readHooksInstalled(root);
      if (root.connected) this.installHookScript(root);
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
    this.claudeAvailable = await new Promise<boolean>((resolve) =>
      execFile(cmd, ["--version"], { timeout: 15000, shell: process.platform === "win32", windowsHide: true }, (err) => resolve(!err)),
    );
    this.scheduleRefresh();
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

  // ── Claude Code hooks ────────────────────────────────────────────────────
  private settingsPath(root: Root) {
    return path.join(root.folder.uri.fsPath, ".claude", "settings.local.json");
  }

  private readSettings(root: Root): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath(root), "utf8"));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
    }
  }

  private readHooksInstalled(root: Root) {
    const s = this.readSettings(root);
    return !!s && hasKenningHooks(s as never);
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

  async connectClaude() {
    if (!this.roots.length) return vscode.window.showWarningMessage("Kenning: open a folder first.");
    for (const root of await this.pickRoots("Connect which folders to Claude Code?")) {
      const settings = this.readSettings(root);
      if (!settings) {
        vscode.window.showErrorMessage(`Kenning: ${this.settingsPath(root)} is not valid JSON, so it was left untouched.`);
        continue;
      }
      this.installHookScript(root);
      fs.mkdirSync(path.dirname(this.settingsPath(root)), { recursive: true });
      fs.writeFileSync(this.settingsPath(root), JSON.stringify(addKenningHooks(settings as never), null, 2) + "\n");
      await this.keepOutOfGit(root, ".claude/settings.local.json");
      root.connected = true;
      root.offset = root.store.eventsSize();
    }
    this.refresh();
    vscode.window.showInformationMessage(
      "Kenning is connected. Changes from your next Claude Code prompt will appear in the Kenning panel.",
    );
  }

  async disconnectClaude() {
    for (const root of await this.pickRoots("Disconnect which folders?")) {
      const settings = this.readSettings(root);
      if (!settings) continue;
      fs.writeFileSync(this.settingsPath(root), JSON.stringify(removeKenningHooks(settings as never), null, 2) + "\n");
      root.connected = false;
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
    if (asked || !this.claudeAvailable || this.roots.some((r) => r.connected)) return;
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
    if (choice === "Connect") await this.connectClaude();
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
      if (!enabled || !waiting || this.view?.visible) return;
      void vscode.window
        .showInformationMessage(`Claude finished. ${waiting} change${waiting === 1 ? "" : "s"} waiting in Kenning.`, "Review")
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
    void this.view?.webview.postMessage({ type: "state", state: this.viewState() });
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
        lines: hunk.lines.slice(0, MAX_CARD_LINES),
        hiddenLines: Math.max(0, hunk.lines.length - MAX_CARD_LINES),
        ai: !ins
          ? { status: cfg.provider === "off" ? "off" : "loading" }
          : ins.status === "ready" && insight
            ? { status: "ready", ...insight }
            : { status: ins.status, error: ins.error },
        result: e.outcome ? { outcome: e.outcome, picked: e.picked, answer: insight?.answer } : undefined,
      };
    });
    return {
      agent: { working: this.isAgentWorking(), since: this.agent.working ? this.agent.since : undefined, name: this.agent.working ? "Claude" : this.roots.some((r) => r.connected) ? "Claude" : "Agent" },
      connected: this.roots.some((r) => r.connected),
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

  // ── Webview ──────────────────────────────────────────────────────────────
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
    view.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${view.webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"><title>Kenning</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: FromView) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.refresh());
    view.onDidDispose(() => (this.view = undefined));
  }

  private entry(key: string) {
    return this.entries.find((e) => e.key === key);
  }

  private async onMessage(m: FromView) {
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
        return e && this.openDiff(e);
      }
      case "retryAi": {
        const e = this.entry(m.key);
        if (e) this.insights.request(e.card, this.surrounding(e), { retry: true });
        return;
      }
      case "connectClaude":
        return this.connectClaude();
      case "reviewUncommitted":
        return this.reviewUncommitted();
      case "setupAi":
        return this.setupAi();
    }
  }

  private async resolve(e: Entry, outcome: Outcome, picked?: number, keepShowing = false) {
    await this.review.resolve(e, outcome, picked, { keepShowing });
    await this.stats.record(outcome);
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
    if (root?.connected) {
      e.store.addFlag(flag);
      this.setFlagNote(
        this.agent.working
          ? "Sent. Claude will address this before it finishes."
          : "Saved. Claude will get this with your next message.",
      );
    } else {
      await vscode.env.clipboard.writeText(
        formatFlagsForAgent([{ ...flag, id: "", createdAt: "", delivered: false }]),
      );
      this.setFlagNote("Copied. Paste it into your agent's chat.");
    }
    await this.resolve(e, "flagged");
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

  private async openDiff(e: Entry) {
    const { hunk } = e.card;
    const rootIndex = this.roots.findIndex((r) => r.store === e.store);
    const fileUri = vscode.Uri.file(e.store.abs(hunk.file));
    const baseUri = vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${hunk.file}`, query: String(rootIndex) });
    const line = Math.max(0, firstChangedLine(hunk) - 1);
    const selection = new vscode.Range(line, 0, line, 0);
    if (hunk.kind === "new") return vscode.window.showTextDocument(fileUri, { selection, preview: true });
    if (hunk.kind === "deleted") return vscode.window.showTextDocument(baseUri, { preview: true });
    await vscode.commands.executeCommand("vscode.diff", baseUri, fileUri, `${path.basename(hunk.file)}: before AI ↔ now`, {
      selection,
      preview: true,
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
    if (Date.now() < this.gitBusyUntil) return;
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
  };
}

export function deactivate() {}
