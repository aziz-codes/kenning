import type { DiffLine } from "../../core/types";
import type { CardView, DayView, FromView, ToView, ViewState } from "../protocol";
import { drawReviewed, drawScore } from "./charts";
import { highlightLine } from "./highlight";
import { drawShareCard } from "./share";

interface Ui {
  layout: "unified" | "split";
  whole: boolean;
  tab: "review" | "history";
  table: boolean;
}

declare function acquireVsCodeApi(): { postMessage(m: FromView): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById("app")!;
const send = (m: FromView) => vscode.postMessage(m);
/** "sidebar": the deck in the Activity Bar. "panel": the full review in an editor tab. */
const wide = document.body.dataset.mode === "panel";

let state: ViewState | null = null;
const expanded = new Set<string>();
let flagFor: string | null = null;
let flagDraft = "";
let timer: number | undefined;
const ui: Ui = { layout: "split", whole: false, tab: "review", table: false, ...((vscode.getState() as Partial<Ui> | null) ?? {}) };
const saveUi = () => vscode.setState(ui);

/** Whole-file diffs, by card key, as the extension sent them. */
const files = new Map<string, { lines: DiffLine[]; focus: [number, number]; truncated: boolean; sig: number }>();

function signature(lines: DiffLine[], focus: [number, number]) {
  let h = 5381 + focus[0] * 31 + focus[1];
  for (const l of lines) {
    const t = l.kind + l.text;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  }
  return h;
}
/** Rendered diff HTML, so big files aren't highlighted again on every update. */
const diffCache = new Map<string, string>();
let scrolledTo = "";
let shownCard = "";
let shownNote = "";

const VISIBLE_DIFF = 14;
const FLAG_SUGGESTIONS = ["Keep the original check", "Add a test for this", "Explain why this is needed", "Revert this change"];

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function elapsed(since?: number) {
  if (!since) return "";
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function ring(score: number | null) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = score ?? 0;
  return `
  <svg class="ring" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="${r}" class="ring-track"/>
    <circle cx="32" cy="32" r="${r}" class="ring-value" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"/>
  </svg>`;
}

function pill(s: ViewState) {
  return s.agent.working
    ? `<span class="pill working" title="${esc(s.agent.name)} is editing files"><span class="dot"></span>${esc(s.agent.name)} is working <span class="clock" data-since="${s.agent.since ?? ""}">${elapsed(s.agent.since)}</span></span>`
    : `<span class="pill"><span class="dot"></span>${s.connected ? `${esc(s.agent.name)} idle` : "Watching changes"}</span>`;
}

function scoreBlock(s: ViewState) {
  const t = s.today;
  return `
  <section class="score" aria-label="Today's understanding">
    <div class="ring-wrap">${ring(t.score)}<div class="ring-label"><span>${t.score === null ? "—" : `${t.score}<small>%</small>`}</span></div></div>
    <div class="score-text">
      <div class="score-title">${t.reviewed ? "understood today" : "nothing reviewed yet today"}</div>
      <div class="score-stats">
        <span title="Changes reviewed today"><b>${t.reviewed}</b> reviewed</span>
        <span title="Days in a row with 3+ reviews"><b>${t.streak}</b> day streak</span>
        <span title="Added lines you haven't reviewed yet" class="${s.pendingLines ? "debt" : ""}"><b>${s.pendingLines}</b> lines waiting</span>
      </div>
      ${t.reviewed ? `<button class="link small share" data-act="share" title="Save an image of today's score to share">Share today ↗</button>` : ""}
    </div>
  </section>`;
}

function header(s: ViewState) {
  return `
  <header class="top">
    <div class="brand"><span class="mark" aria-hidden="true"></span>Kenning</div>
    ${pill(s)}
  </header>
  ${scoreBlock(s)}`;
}

function riskChips(c: CardView) {
  if (!c.risks.length) return "";
  return `<div class="risks">${c.risks
    .map((r) => `<span class="risk ${r.severity}" title="${esc(r.detail ?? "")}">${r.severity === "high" ? "▲" : r.severity === "medium" ? "◆" : "•"} ${esc(r.title)}</span>`)
    .join("")}</div>`;
}

// ── Diffs ───────────────────────────────────────────────────────────────────

const em = (l?: DiffLine) => (l?.em?.length ? ` data-em="${l.em.map(([a, b]) => `${a},${b}`).join(";")}"` : "");
const sign = (l: DiffLine) => (l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ");

function unifiedRow(l: DiffLine, lang: string | undefined, focus: boolean) {
  const no = l.kind === "del" ? l.oldNo : l.newNo;
  return `<div class="dl ${l.kind}${focus ? " focus" : ""}"><span class="no">${no ?? ""}</span><span class="sg">${sign(l)}</span><span class="tx"${em(l)}>${highlightLine(l.text, lang) || " "}</span></div>`;
}

function half(l: DiffLine | undefined, side: "old" | "new", lang: string | undefined) {
  if (!l) return `<div class="hl none"><span class="no"></span><span class="tx"> </span></div>`;
  const no = side === "old" ? l.oldNo : l.newNo;
  return `<div class="hl ${l.kind}"><span class="no">${no ?? ""}</span><span class="tx"${em(l)}>${highlightLine(l.text, lang) || " "}</span></div>`;
}

/** Side by side: context on both sides, each run of removed lines next to the added lines that replace it. */
function splitRows(lines: DiffLine[], lang: string | undefined, focus?: [number, number]) {
  const out: string[] = [];
  const inFocus = (i: number) => !!focus && i >= focus[0] && i <= focus[1];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "ctx") {
      out.push(`<div class="sl${inFocus(i) ? " focus" : ""}">${half(l, "old", lang)}${half(l, "new", lang)}</div>`);
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(i++);
    while (i < lines.length && lines[i].kind === "add") adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const f = inFocus(dels[k] ?? adds[k]);
      out.push(`<div class="sl${f ? " focus" : ""}">${half(lines[dels[k]], "old", lang)}${half(lines[adds[k]], "new", lang)}</div>`);
    }
  }
  return out.join("");
}

/** Wraps characters [start, end) of an element's text in <mark>, across highlight spans. */
function emphasize(el: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let pos = 0;
  for (const node of nodes) {
    const len = node.data.length;
    const from = Math.max(start, pos);
    const to = Math.min(end, pos + len);
    if (from < to) {
      const mid = node.splitText(from - pos);
      mid.splitText(to - from);
      const mark = document.createElement("mark");
      mark.className = "em";
      mid.replaceWith(mark);
      mark.appendChild(mid);
    }
    pos += len;
  }
}

function applyEmphasis(scope: ParentNode) {
  scope.querySelectorAll<HTMLElement>(".tx[data-em]").forEach((el) => {
    // Right to left, so earlier offsets stay valid as nodes are split.
    const ranges = el.dataset.em!.split(";").map((r) => r.split(",").map(Number));
    for (const [a, b] of ranges.reverse()) emphasize(el, a, b);
    el.removeAttribute("data-em");
  });
}

function diffHtml(c: CardView, lines: DiffLine[], focus?: [number, number]) {
  const split = wide && ui.layout === "split";
  const id = `${c.key}|${split ? "s" : "u"}|${focus ? `w${focus.join("-")}|${lines.length}` : lines.length}`;
  const hit = diffCache.get(id);
  if (hit) return hit;
  const rows = split
    ? splitRows(lines, c.lang, focus)
    : lines.map((l, i) => unifiedRow(l, c.lang, !!focus && i >= focus[0] && i <= focus[1])).join("");
  const tmp = document.createElement("div");
  tmp.innerHTML = rows;
  applyEmphasis(tmp);
  const html = tmp.innerHTML;
  if (diffCache.size > 60) diffCache.clear();
  diffCache.set(id, html);
  return html;
}

function diff(c: CardView) {
  const split = wide && ui.layout === "split";
  const cls = `diff${split ? " split" : ""}${wide ? " tall" : ""}`;
  if (wide && ui.whole) {
    const f = files.get(c.key);
    if (!f) return `<div class="${cls} whole" data-scroll="diff"><div class="hint pad">Loading the whole file…</div></div>`;
    return `
    <div class="${cls} whole" role="region" aria-label="Whole file" data-scroll="diff">${diffHtml(c, f.lines, f.focus)}</div>
    ${f.truncated ? `<p class="hint">This file is long, so only the part around the change is shown. <button class="link" data-act="openDiff" data-key="${esc(c.key)}">Open the full diff</button></p>` : ""}`;
  }
  const open = wide || expanded.has(c.key);
  const lines = open ? c.lines : c.lines.slice(0, VISIBLE_DIFF);
  const more = c.lines.length - lines.length + c.hiddenLines;
  return `
  <div class="${cls}" role="region" aria-label="Diff" data-scroll="diff">${diffHtml(c, lines)}</div>
  ${more > 0 ? `<button class="link small" data-act="${wide ? "openDiff" : "expand"}" data-key="${esc(c.key)}">${wide ? `${plural(c.hiddenLines, "more line")}: open the full diff` : `Show ${plural(more, "more line")}`}</button>` : ""}
  ${!wide && open && c.lines.length > VISIBLE_DIFF ? `<button class="link small" data-act="collapse" data-key="${esc(c.key)}">Show less</button>` : ""}`;
}

function diffToolbar(c: CardView) {
  const seg = (act: string, on: boolean, label: string, key: string) =>
    `<button class="seg ${on ? "on" : ""}" data-act="${act}" aria-pressed="${on}">${label} <span class="kbd">${key}</span></button>`;
  return `
  <div class="toolbar" role="toolbar" aria-label="Diff view">
    <div class="segs">${seg("showChanges", !ui.whole, "Change", "W")}${seg("showWhole", ui.whole, "Whole file", "W")}</div>
    <div class="segs">${seg("unified", ui.layout === "unified", "Unified", "V")}${seg("split", ui.layout === "split", "Side by side", "V")}</div>
    <button class="ghost small-btn push" data-act="openDiff" data-key="${esc(c.key)}" title="Open in VS Code's diff editor">Editor diff <span class="kbd">D</span></button>
  </div>`;
}

// ── Cards ───────────────────────────────────────────────────────────────────

function aiBlock(c: CardView, s: ViewState) {
  const ai = c.ai;
  const res = c.result;
  if (ai.status === "loading") {
    return `<div class="ai loading" aria-live="polite"><div class="sk w80"></div><div class="sk w60"></div><div class="sk w90"></div><p class="hint">Preparing a quick question…</p></div>`;
  }
  if (ai.status === "error") {
    return `<div class="ai error"><p>${esc(ai.error)}</p><button class="link" data-act="retry" data-key="${esc(c.key)}">Try again</button></div>`;
  }
  if (ai.status === "off") {
    return s.provider === "off"
      ? `<div class="ai off"><p class="hint">Turn on AI to get a plain-English summary and a quick question for every change.</p><button class="link" data-act="setupAi">Set up AI questions</button></div>`
      : "";
  }
  const options = (ai.options ?? [])
    .map((o, i) => {
      let cls = "opt";
      if (res && res.answer !== undefined) {
        if (i === res.answer) cls += " right";
        else if (i === res.picked) cls += " wrong";
        else cls += " dim";
      }
      return `<button class="${cls}" data-act="answer" data-key="${esc(c.key)}" data-opt="${i}" ${res ? "disabled" : ""}><span class="k">${i + 1}</span><span>${esc(o)}</span></button>`;
    })
    .join("");
  const verdict =
    res && res.answer !== undefined
      ? `<div class="verdict ${res.outcome === "correct" ? "good" : "bad"}"><b>${res.outcome === "correct" ? "Correct." : "Not quite."}</b> ${esc(ai.explanation)}</div>`
      : "";
  const concerns =
    res && ai.concerns?.length
      ? `<div class="concerns"><div class="label">Worth a second look</div><ul>${ai.concerns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      : "";
  return `
  <div class="ai ready">
    ${ai.why ? `<p class="why"><span class="label">Why</span> ${esc(ai.why)}</p>` : ""}
    ${ai.question ? `<div class="quiz"><div class="label">Quick check</div><p class="q">${esc(ai.question)}</p><div class="opts">${options}</div></div>` : ""}
    ${verdict}${concerns}
  </div>`;
}

function flagBox(c: CardView) {
  return `
  <div class="flagbox">
    <label for="flag-text" class="label">What should the agent change?</label>
    <div class="chips">${FLAG_SUGGESTIONS.map((x) => `<button class="chip" data-act="suggest" data-text="${esc(x)}">${esc(x)}</button>`).join("")}</div>
    <textarea id="flag-text" rows="3" placeholder="e.g. Keep the null check: user can be undefined here">${esc(flagDraft)}</textarea>
    <div class="row">
      <button class="primary" data-act="sendFlag" data-key="${esc(c.key)}">Send to agent</button>
      <button class="ghost" data-act="cancelFlag">Cancel</button>
    </div>
  </div>`;
}

function card(c: CardView, s: ViewState) {
  const title = c.ai.status === "ready" && c.ai.summary ? c.ai.summary : c.headline;
  const top = c.risks[0]?.severity;
  const answered = !!c.result;
  const hasQuiz = c.ai.status === "ready" && !!c.ai.question;
  const actions = answered
    ? `<button class="primary" data-act="next">Next change <span class="kbd">→</span></button>`
    : `${hasQuiz ? "" : `<button class="primary" data-act="understood" data-key="${esc(c.key)}">Got it <span class="kbd">G</span></button>`}
       <button class="ghost" data-act="flag" data-key="${esc(c.key)}">Flag <span class="kbd">F</span></button>
       <button class="ghost" data-act="skip" data-key="${esc(c.key)}">Skip <span class="kbd">S</span></button>
       ${hasQuiz ? `<button class="link small push" data-act="understood" data-key="${esc(c.key)}">I already know this</button>` : ""}`;
  const head = `
    <div class="where">
      <button class="file" data-act="openDiff" data-key="${esc(c.key)}" title="Open the diff">${esc(c.file)}<span class="ln">:${c.line}</span></button>
      <span class="delta"><span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span></span>
      ${wide ? "" : `<button class="icon expand" data-act="openPanel" title="Open the full review in an editor tab (E)" aria-label="Open the full review">⤢</button>`}
    </div>
    <h2 class="title">${esc(title)}</h2>
    ${c.ai.status === "ready" && c.ai.summary ? `<div class="sub">${esc(c.headline)}</div>` : ""}
    ${riskChips(c)}`;
  const side = `${aiBlock(c, s)}${flagFor === c.key ? flagBox(c) : `<div class="actions">${actions}</div>`}`;
  const cls = `card ${wide ? "wide" : ""} ${top ? `risk-${top}` : ""} ${answered ? `done ${c.result!.outcome}` : ""}`;
  if (!wide) return `<article class="${cls}">${head}${diff(c)}${side}</article>`;
  return `
  <article class="${cls}">
    <div class="card-head">${head}</div>
    <div class="card-body">
      <div class="card-code">${diffToolbar(c)}${diff(c)}</div>
      <div class="card-side">${side}</div>
    </div>
  </article>`;
}

function deckNav(s: ViewState) {
  const n = s.cards.length;
  const dots =
    n <= 12
      ? `<div class="dots">${s.cards
          .map((c, i) => `<button class="d ${i === s.index ? "on" : ""} ${c.risks[0]?.severity === "high" ? "hot" : ""}" data-act="goto" data-i="${i}" aria-label="Change ${i + 1}"></button>`)
          .join("")}</div>`
      : `<div class="bar"><div style="width:${((s.index + 1) / n) * 100}%"></div></div>`;
  return `
  <nav class="nav">
    <button class="icon" data-act="prev" ${s.index === 0 ? "disabled" : ""} aria-label="Previous">‹</button>
    <span class="count">Change <b>${s.index + 1}</b> of ${n}</span>
    <button class="icon" data-act="next" ${s.index >= n - 1 ? "disabled" : ""} aria-label="Next">›</button>
  </nav>
  ${dots}`;
}

function connectButtons(s: ViewState) {
  const ready = s.agents.filter((a) => a.available && !a.connected);
  const buttons = ready.map(
    (a, i) => `<button class="${i === 0 ? "primary" : "ghost"} wide" data-act="connectAgent" data-agent="${a.id}">Connect ${esc(a.name)}</button>`,
  );
  return buttons.length
    ? buttons.join("")
    : `<p class="hint">No supported agent was found. Kenning still watches changes made by any agent.</p>
       <button class="ghost wide" data-act="connectAgent">Connect an agent…</button>`;
}

function emptyState(s: ViewState) {
  if (!s.hasWorkspace) {
    return `<div class="empty"><h2>Open a folder</h2><p>Kenning reviews changes inside a project folder.</p></div>`;
  }
  if (!s.connected && !s.today.reviewed) {
    return `
    <div class="welcome">
      <h2>Understand every change your AI makes.</h2>
      <ol>
        <li>Your agent edits code as usual.</li>
        <li>Each change becomes a short card: what changed, what looks risky, one quick question.</li>
        <li>Spot a problem? <b>Flag</b> it, and the agent fixes it before it finishes.</li>
      </ol>
      ${connectButtons(s)}
      <button class="ghost wide" data-act="reviewUncommitted">Review uncommitted changes</button>
      <p class="fine">Claude Code, Codex and Cursor connect with hooks. Copilot, Aider and scripts need nothing: changes they write to disk show up here automatically.</p>
    </div>`;
  }
  if (s.agent.working) {
    return `<div class="empty"><div class="ink"><span></span><span></span><span></span></div><h2>${esc(s.agent.name)} is working</h2><p>Cards appear here as it edits files.</p></div>`;
  }
  return `
  <div class="empty caught-up">
    <div class="seal" aria-hidden="true">✓</div>
    <h2>All caught up.</h2>
    <p>${s.today.reviewed ? `You reviewed ${plural(s.today.reviewed, "change")} today.` : "No unreviewed changes."}</p>
    <button class="link" data-act="reviewUncommitted">Review uncommitted changes</button>
  </div>`;
}

// ── The full review (editor tab) ────────────────────────────────────────────

function fileList(s: ViewState) {
  const groups = new Map<string, { c: CardView; i: number }[]>();
  s.cards.forEach((c, i) => groups.set(c.file, [...(groups.get(c.file) ?? []), { c, i }]));
  const waiting = s.cards.filter((c) => !c.result).length;
  const items = [...groups].map(([file, list]) => {
    const slash = file.lastIndexOf("/");
    return `
    <li class="fg">
      <div class="fg-name" title="${esc(file)}"><span class="base">${esc(file.slice(slash + 1))}</span><span class="dir">${esc(file.slice(0, slash + 1))}</span></div>
      <ul>${list
        .map(({ c, i }) => {
          const sev = c.risks[0]?.severity;
          const title = c.ai.status === "ready" && c.ai.summary ? c.ai.summary : c.headline;
          return `<li><button class="fi ${i === s.index ? "on" : ""} ${c.result ? "done" : ""}" data-act="goto" data-i="${i}" ${i === s.index ? 'aria-current="true"' : ""}>
            <span class="sev ${sev ?? "none"}" aria-label="${sev ? `${sev} risk` : "no risk flags"}">${c.result ? "✓" : sev === "high" ? "▲" : sev === "medium" ? "◆" : "•"}</span>
            <span class="fi-title">${esc(title)}</span>
            <span class="fi-meta">:${c.line} <span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span></span>
          </button></li>`;
        })
        .join("")}</ul>
    </li>`;
  });
  return `
  <div class="files-head"><span class="label">Changes</span><span class="count">${waiting} waiting · ${plural(groups.size, "file")}</span></div>
  ${s.cards.length ? `<ul class="files" aria-label="Changed files">${items.join("")}</ul>` : `<p class="hint">Nothing waiting.</p>`}`;
}

function tabs() {
  const tab = (id: Ui["tab"], label: string) => `<button class="tab ${ui.tab === id ? "on" : ""}" data-act="tab" data-tab="${id}" role="tab" aria-selected="${ui.tab === id}">${label}</button>`;
  return `<div class="tabs" role="tablist">${tab("review", "Review")}${tab("history", "History")}</div>`;
}

function history(s: ViewState) {
  const days = s.history;
  const sum = (f: (d: DayView) => number) => days.reduce((n, d) => n + f(d), 0);
  const reviewed = sum((d) => d.reviewed);
  const understood = sum((d) => d.understood + d.flagged);
  const score = reviewed ? Math.round((understood / reviewed) * 100) : null;
  const tile = (value: string, label: string, note = "") =>
    `<div class="tile"><div class="tile-v">${value}</div><div class="tile-l">${label}</div>${note ? `<div class="tile-n">${note}</div>` : ""}</div>`;
  const table = `
    <table class="data">
      <thead><tr><th>Day</th><th>Reviewed</th><th>Understood</th><th>Flagged</th><th>Wrong</th><th>Skipped</th><th>Score</th></tr></thead>
      <tbody>${[...days]
        .reverse()
        .filter((d) => d.reviewed)
        .map(
          (d) =>
            `<tr><td>${esc(new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</td><td>${d.reviewed}</td><td>${d.understood}</td><td>${d.flagged}</td><td>${d.wrong}</td><td>${d.skipped}</td><td>${d.score === null ? "—" : `${d.score}%`}</td></tr>`,
        )
        .join("") || `<tr><td colspan="7" class="hint">No reviews in the last 30 days.</td></tr>`}</tbody>
    </table>`;
  return `
  <section class="history" aria-label="History">
    <div class="tiles">
      ${tile(s.today.score === null ? "—" : `${s.today.score}%`, "understood today", plural(s.today.reviewed, "change"))}
      ${tile(score === null ? "—" : `${score}%`, "understood, 30 days", plural(reviewed, "change"))}
      ${tile(String(sum((d) => d.flagged)), "issues flagged", "last 30 days")}
      ${tile(String(s.today.streak), "day streak", `best: ${s.bestStreak}`)}
    </div>
    <div class="chart-card">
      <div class="chart-title">Changes reviewed per day</div>
      <div class="chart" data-chart="reviewed"></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Understanding score</div>
      <div class="chart" data-chart="score"></div>
    </div>
    <div class="row">
      <button class="ghost" data-act="toggleTable" aria-expanded="${ui.table}">${ui.table ? "Hide" : "Show"} as a table</button>
      <button class="ghost" data-act="copyReport">Copy review summary for a PR</button>
      ${s.today.reviewed ? `<button class="ghost" data-act="share">Share today ↗</button>` : ""}
    </div>
    ${ui.table ? table : ""}
  </section>`;
}

function panel(s: ViewState) {
  const current = s.cards[s.index];
  const body =
    ui.tab === "history"
      ? history(s)
      : current
        ? `<div class="review"><aside class="aside">${fileList(s)}<button class="link small" data-act="copyReport">Copy review summary</button></aside><main class="main">${deckNav(s)}${card(current, s)}</main></div>`
        : `<div class="review solo">${emptyState(s)}</div>`;
  return `
  <header class="top panel-top">
    <div class="brand"><span class="mark" aria-hidden="true"></span>Kenning</div>
    ${tabs()}
    <div class="top-right">
      <span class="mini-score" title="Understood today">${s.today.score === null ? "—" : `${s.today.score}%`} <small>today</small></span>
      ${pill(s)}
    </div>
  </header>
  ${s.flagNote ? `<div class="toast" role="status">${esc(s.flagNote)}</div>` : ""}
  ${body}
  ${current && ui.tab === "review" ? `<footer class="keys"><span><span class="kbd">1</span>–<span class="kbd">4</span> answer</span><span><span class="kbd">G</span> got it</span><span><span class="kbd">F</span> flag</span><span><span class="kbd">W</span> whole file</span><span><span class="kbd">V</span> side by side</span><span><span class="kbd">←</span><span class="kbd">→</span> move</span></footer>` : ""}`;
}

// ── Render ──────────────────────────────────────────────────────────────────

function drawCharts() {
  if (!state) return;
  const reviewed = root.querySelector<HTMLElement>('[data-chart="reviewed"]');
  const score = root.querySelector<HTMLElement>('[data-chart="score"]');
  if (reviewed) drawReviewed(reviewed, state.history);
  if (score) drawScore(score, state.history);
}

function render() {
  if (!state) return;
  const s = state;
  const current = s.cards[s.index];
  if (flagFor && !s.cards.some((c) => c.key === flagFor)) flagFor = null;

  // innerHTML replaces the scrolling boxes, so keep where the reader was.
  const scrolls = new Map<string, number>();
  root.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => scrolls.set(el.dataset.scroll!, el.scrollTop));
  const aside = root.querySelector<HTMLElement>(".files")?.scrollTop;

  const entering = !!current && current.key !== shownCard;
  shownCard = current?.key ?? "";
  const noteEntering = !!s.flagNote && s.flagNote !== shownNote;
  shownNote = s.flagNote ?? "";

  root.innerHTML = wide
    ? panel(s)
    : `
    ${header(s)}
    ${s.flagNote ? `<div class="toast" role="status">${esc(s.flagNote)}</div>` : ""}
    <main>
      ${current ? `${deckNav(s)}${card(current, s)}` : emptyState(s)}
    </main>
    ${current ? `<footer class="keys"><span><span class="kbd">1</span>–<span class="kbd">4</span> answer</span><span><span class="kbd">D</span> diff</span><span><span class="kbd">E</span> expand</span><span><span class="kbd">←</span><span class="kbd">→</span> move</span></footer>` : ""}`;

  const scrollKey = current && wide && ui.whole && files.has(current.key) ? `${current.key}|${ui.layout}` : "";
  root.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => {
    const top = scrolls.get(el.dataset.scroll!);
    if (top !== undefined && (!scrollKey || scrollKey === scrolledTo)) el.scrollTop = top;
  });
  if (aside !== undefined) root.querySelector<HTMLElement>(".files")?.scrollTo({ top: aside });
  root.querySelector<HTMLElement>(".fi.on")?.scrollIntoView({ block: "nearest" });
  if (scrollKey && scrollKey !== scrolledTo) {
    // First look at a whole file: bring the change to the middle.
    scrolledTo = scrollKey;
    const box = root.querySelector<HTMLElement>(".diff.whole");
    const first = box?.querySelector<HTMLElement>(".focus");
    if (box && first) box.scrollTop = Math.max(0, first.offsetTop - box.clientHeight / 3);
  }

  if (entering) root.querySelector(".card")?.classList.add("enter");
  if (noteEntering) root.querySelector(".toast")?.classList.add("enter");
  drawCharts();

  const ta = document.getElementById("flag-text") as HTMLTextAreaElement | null;
  if (ta) {
    ta.addEventListener("input", () => (flagDraft = ta.value));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  clearInterval(timer);
  if (s.agent.working) {
    timer = window.setInterval(() => {
      document.querySelectorAll<HTMLElement>(".clock").forEach((el) => (el.textContent = elapsed(Number(el.dataset.since))));
    }, 1000);
  }
}

/** The whole-file view needs the file from the extension; ask again on every update, since the agent may still be editing. */
function wantFile() {
  const c = state?.cards[state.index];
  if (wide && ui.whole && ui.tab === "review" && c) send({ type: "loadFile", key: c.key });
}

function setUi(patch: Partial<Ui>) {
  Object.assign(ui, patch);
  saveUi();
  if (patch.whole) wantFile();
  render();
}

// ── Events ──────────────────────────────────────────────────────────────────

root.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  const key = el.dataset.key ?? "";
  switch (el.dataset.act) {
    case "answer":
      return send({ type: "answer", key, option: Number(el.dataset.opt) });
    case "understood":
      return send({ type: "understood", key });
    case "skip":
      return send({ type: "skip", key });
    case "flag":
      flagFor = key;
      flagDraft = "";
      return render();
    case "suggest":
      flagDraft = el.dataset.text ?? "";
      return render();
    case "cancelFlag":
      flagFor = null;
      return render();
    case "sendFlag": {
      const comment = flagDraft.trim();
      if (!comment) return (document.getElementById("flag-text") as HTMLTextAreaElement | null)?.focus();
      flagFor = null;
      flagDraft = "";
      return send({ type: "flag", key, comment });
    }
    case "expand":
      expanded.add(key);
      return render();
    case "collapse":
      expanded.delete(key);
      return render();
    case "next":
      return send({ type: "next" });
    case "prev":
      return send({ type: "prev" });
    case "goto":
      return send({ type: "goto", index: Number(el.dataset.i) });
    case "openDiff":
      return send({ type: "openDiff", key });
    case "openPanel":
      return send({ type: "openPanel" });
    case "retry":
      return send({ type: "retryAi", key });
    case "connectClaude":
      return send({ type: "connectClaude" });
    case "connectAgent":
      return send({ type: "connectAgent", agent: (el.dataset.agent as "claude" | "codex" | "cursor" | undefined) || undefined });
    case "reviewUncommitted":
      return send({ type: "reviewUncommitted" });
    case "setupAi":
      return send({ type: "setupAi" });
    case "copyReport":
      return send({ type: "copyReport" });
    case "tab":
      return setUi({ tab: el.dataset.tab as Ui["tab"] });
    case "showChanges":
      return setUi({ whole: false });
    case "showWhole":
      return setUi({ whole: true });
    case "unified":
      return setUi({ layout: "unified" });
    case "split":
      return setUi({ layout: "split" });
    case "toggleTable":
      return setUi({ table: !ui.table });
    case "share":
      if (state) void drawShareCard(state).then((dataUrl) => send({ type: "shareImage", dataUrl }));
      return;
  }
});

document.addEventListener("keydown", (e) => {
  if (!state || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
    if (e.key === "Escape") {
      flagFor = null;
      render();
    } else if (e.key === "Enter" && !e.shiftKey && flagFor) {
      e.preventDefault();
      (document.querySelector('[data-act="sendFlag"]') as HTMLElement | null)?.click();
    }
    return;
  }
  const c = state.cards[state.index];
  const k = e.key.toLowerCase();
  if (wide && k === "h") setUi({ tab: ui.tab === "history" ? "review" : "history" });
  else if (k === "arrowright" || k === "n") send({ type: "next" });
  else if (k === "arrowleft" || k === "p") send({ type: "prev" });
  else if (!c) return;
  else if (/^[1-4]$/.test(k) && c.ai.status === "ready" && !c.result && Number(k) <= (c.ai.options?.length ?? 0))
    send({ type: "answer", key: c.key, option: Number(k) - 1 });
  else if (k === "g" && !c.result) send({ type: "understood", key: c.key });
  else if (k === "s" && !c.result) send({ type: "skip", key: c.key });
  else if (k === "d") send({ type: "openDiff", key: c.key });
  else if (k === "e" && !wide) send({ type: "openPanel" });
  else if (k === "w" && wide) setUi({ whole: !ui.whole, tab: "review" });
  else if (k === "v" && wide) setUi({ layout: ui.layout === "split" ? "unified" : "split" });
  else if (k === "f" && !c.result) {
    flagFor = c.key;
    flagDraft = "";
    render();
    e.preventDefault();
  } else return;
  e.preventDefault();
});

window.addEventListener("message", (e: MessageEvent<ToView>) => {
  const m = e.data;
  if (m?.type === "state") {
    state = m.state;
    const keys = new Set(state.cards.map((c) => c.key));
    for (const k of files.keys()) if (!keys.has(k)) files.delete(k);
    render();
    wantFile();
  } else if (m?.type === "file") {
    // The same file arrives on every update; only redraw when it actually changed.
    const sig = signature(m.lines, m.focus);
    if (files.get(m.key)?.sig === sig) return;
    files.set(m.key, { lines: m.lines, focus: m.focus, truncated: m.truncated, sig });
    for (const id of diffCache.keys()) if (id.startsWith(`${m.key}|`)) diffCache.delete(id);
    if (state?.cards[state.index]?.key === m.key) render();
  }
});

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(drawCharts, 80);
}).observe(document.body);

send({ type: "ready" });
