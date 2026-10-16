import type { CardView, FromView, ViewState } from "../protocol";
import { highlightLine } from "./highlight";
import { drawShareCard } from "./share";

declare function acquireVsCodeApi(): { postMessage(m: FromView): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById("app")!;
const send = (m: FromView) => vscode.postMessage(m);

let state: ViewState | null = null;
const expanded = new Set<string>();
let flagFor: string | null = null;
let flagDraft = "";
let timer: number | undefined;

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

function header(s: ViewState) {
  const pill = s.agent.working
    ? `<span class="pill working" title="${esc(s.agent.name)} is editing files"><span class="dot"></span>${esc(s.agent.name)} is working <span class="clock" data-since="${s.agent.since ?? ""}">${elapsed(s.agent.since)}</span></span>`
    : `<span class="pill"><span class="dot"></span>${s.connected ? `${esc(s.agent.name)} idle` : "Watching changes"}</span>`;
  const t = s.today;
  return `
  <header class="top">
    <div class="brand"><span class="mark" aria-hidden="true"></span>Kenning</div>
    ${pill}
  </header>
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

function riskChips(c: CardView) {
  if (!c.risks.length) return "";
  return `<div class="risks">${c.risks
    .map((r) => `<span class="risk ${r.severity}" title="${esc(r.detail ?? "")}">${r.severity === "high" ? "▲" : r.severity === "medium" ? "◆" : "•"} ${esc(r.title)}</span>`)
    .join("")}</div>`;
}

function diff(c: CardView) {
  const open = expanded.has(c.key);
  const lines = open ? c.lines : c.lines.slice(0, VISIBLE_DIFF);
  const more = c.lines.length - lines.length + c.hiddenLines;
  const rows = lines
    .map((l) => {
      const no = l.kind === "del" ? l.oldNo : l.newNo;
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
      const em = l.em?.length ? ` data-em="${l.em.map(([a, b]) => `${a},${b}`).join(";")}"` : "";
      return `<div class="dl ${l.kind}"><span class="no">${no ?? ""}</span><span class="sg">${sign}</span><span class="tx"${em}>${highlightLine(l.text, c.lang) || " "}</span></div>`;
    })
    .join("");
  return `
  <div class="diff" role="region" aria-label="Diff">${rows}</div>
  ${more > 0 ? `<button class="link small" data-act="expand" data-key="${esc(c.key)}">Show ${plural(more, "more line")}</button>` : ""}
  ${open && c.lines.length > VISIBLE_DIFF ? `<button class="link small" data-act="collapse" data-key="${esc(c.key)}">Show less</button>` : ""}`;
}

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
  return `
  <article class="card ${top ? `risk-${top}` : ""} ${answered ? `done ${c.result!.outcome}` : ""}">
    <div class="where">
      <button class="file" data-act="openDiff" data-key="${esc(c.key)}" title="Open the diff">${esc(c.file)}<span class="ln">:${c.line}</span></button>
      <span class="delta"><span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span></span>
    </div>
    <h2 class="title">${esc(title)}</h2>
    ${c.ai.status === "ready" && c.ai.summary ? `<div class="sub">${esc(c.headline)}</div>` : ""}
    ${riskChips(c)}
    ${diff(c)}
    ${aiBlock(c, s)}
    ${flagFor === c.key ? flagBox(c) : `<div class="actions">${actions}</div>`}
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
      ${
        s.claudeAvailable
          ? `<button class="primary wide" data-act="connectClaude">Connect Claude Code</button>`
          : `<p class="hint">Claude Code wasn't found. Kenning still watches changes made by any agent.</p>`
      }
      <button class="ghost wide" data-act="reviewUncommitted">Review uncommitted changes</button>
      <p class="fine">Using Codex, Cursor, Copilot or Aider? Changes they write to disk show up here automatically.</p>
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

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
  if (!state) return;
  const s = state;
  const current = s.cards[s.index];
  if (flagFor && !s.cards.some((c) => c.key === flagFor)) flagFor = null;
  root.innerHTML = `
    ${header(s)}
    ${s.flagNote ? `<div class="toast" role="status">${esc(s.flagNote)}</div>` : ""}
    <main>
      ${current ? `${deckNav(s)}${card(current, s)}` : emptyState(s)}
    </main>
    ${current ? `<footer class="keys"><span><span class="kbd">1</span>–<span class="kbd">4</span> answer</span><span><span class="kbd">D</span> diff</span><span><span class="kbd">←</span><span class="kbd">→</span> move</span></footer>` : ""}`;

  root.querySelectorAll<HTMLElement>(".tx[data-em]").forEach((el) => {
    // Right to left, so earlier offsets stay valid as nodes are split.
    const ranges = el.dataset.em!.split(";").map((r) => r.split(",").map(Number));
    for (const [a, b] of ranges.reverse()) emphasize(el, a, b);
  });

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
    case "retry":
      return send({ type: "retryAi", key });
    case "connectClaude":
      return send({ type: "connectClaude" });
    case "reviewUncommitted":
      return send({ type: "reviewUncommitted" });
    case "setupAi":
      return send({ type: "setupAi" });
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
  if (k === "arrowright" || k === "n") send({ type: "next" });
  else if (k === "arrowleft" || k === "p") send({ type: "prev" });
  else if (!c) return;
  else if (/^[1-4]$/.test(k) && c.ai.status === "ready" && !c.result && Number(k) <= (c.ai.options?.length ?? 0))
    send({ type: "answer", key: c.key, option: Number(k) - 1 });
  else if (k === "g" && !c.result) send({ type: "understood", key: c.key });
  else if (k === "s" && !c.result) send({ type: "skip", key: c.key });
  else if (k === "d") send({ type: "openDiff", key: c.key });
  else if (k === "f" && !c.result) {
    flagFor = c.key;
    flagDraft = "";
    render();
    e.preventDefault();
  } else return;
  e.preventDefault();
});

window.addEventListener("message", (e: MessageEvent<{ type: "state"; state: ViewState }>) => {
  if (e.data?.type === "state") {
    state = e.data.state;
    render();
  }
});

send({ type: "ready" });
