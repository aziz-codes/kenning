// The History tab's two charts, drawn as SVG at the container's real width:
// changes reviewed per day (columns) and the understanding score (a line).
// One series each, in the accent colour; hover shows the day's details.
import type { DayView } from "../protocol";

const H = 150;
const PAD = { top: 12, right: 34, bottom: 22, left: 30 };
const NS = "http://www.w3.org/2000/svg";

const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, opts);

function niceMax(n: number) {
  if (n <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(n)));
  const m = n / step;
  return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * step;
}

function svg(width: number) {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("width", String(width));
  el.setAttribute("height", String(H));
  el.setAttribute("viewBox", `0 0 ${width} ${H}`);
  return el;
}

function add(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

function tooltip(host: HTMLElement) {
  let tip = host.querySelector<HTMLDivElement>(".tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.setAttribute("role", "status");
    host.appendChild(tip);
  }
  return {
    show(x: number, value: string, label: string, detail?: string) {
      tip!.replaceChildren();
      const v = document.createElement("b");
      v.textContent = value;
      const l = document.createElement("span");
      l.textContent = label;
      tip!.append(v, l);
      if (detail) {
        const d = document.createElement("small");
        d.textContent = detail;
        tip!.append(d);
      }
      tip!.style.display = "block";
      const w = tip!.offsetWidth;
      tip!.style.left = `${Math.max(0, Math.min(host.clientWidth - w, x - w / 2))}px`;
    },
    hide() {
      tip!.style.display = "none";
    },
  };
}

function axes(g: Element, width: number, max: number, days: DayView[], x: (i: number) => number, fmt: (n: number) => string) {
  const plotH = H - PAD.top - PAD.bottom;
  for (const f of [0, 0.5, 1]) {
    const y = PAD.top + plotH * (1 - f);
    add(g, "line", { x1: PAD.left, x2: width - PAD.right, y1: y, y2: y, class: f === 0 ? "axis" : "grid" });
    add(g, "text", { x: PAD.left - 6, y: y + 3.5, class: "tick", "text-anchor": "end" }, fmt(max * f));
  }
  // A date under every 7th day, counting back from today so today is always labelled.
  for (let i = days.length - 1; i >= 0; i -= 7) {
    add(g, "text", { x: x(i), y: H - 6, class: "tick", "text-anchor": "middle" }, i === days.length - 1 ? "Today" : dayLabel(days[i].day));
  }
}

const breakdown = (d: DayView) =>
  [d.understood && `${d.understood} understood`, d.flagged && `${d.flagged} flagged`, d.wrong && `${d.wrong} wrong`, d.skipped && `${d.skipped} skipped`]
    .filter(Boolean)
    .join(" · ");

/** Columns: changes reviewed per day. */
export function drawReviewed(host: HTMLElement, days: DayView[]) {
  const width = Math.max(260, host.clientWidth);
  const el = svg(width);
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...days.map((d) => d.reviewed)));
  const slot = plotW / days.length;
  const bar = Math.min(24, Math.max(2, slot - 2));
  const x = (i: number) => PAD.left + slot * i + slot / 2;
  axes(el, width, max, days, x, (n) => String(Math.round(n)));
  const tip = tooltip(host);
  const base = PAD.top + plotH;
  days.forEach((d, i) => {
    const h = (d.reviewed / max) * plotH;
    if (h > 0) {
      const r = Math.min(4, bar / 2, h);
      const x0 = x(i) - bar / 2;
      const top = base - h;
      // Rounded at the data end, square at the baseline.
      add(el, "path", {
        class: "col",
        "data-i": i,
        d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bar - r}Q${x0 + bar},${top} ${x0 + bar},${top + r}V${base}Z`,
      });
    }
    const hit = add(el, "rect", { x: PAD.left + slot * i, y: PAD.top, width: slot, height: plotH, class: "hit" });
    hit.addEventListener("pointerenter", () => {
      el.querySelectorAll(".col.on").forEach((c) => c.classList.remove("on"));
      el.querySelector(`.col[data-i="${i}"]`)?.classList.add("on");
      tip.show(x(i), String(d.reviewed), d.reviewed === 1 ? "change reviewed" : "changes reviewed", `${dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" })}${d.reviewed ? ` · ${breakdown(d)}` : ""}`);
    });
  });
  el.addEventListener("pointerleave", () => {
    el.querySelectorAll(".col.on").forEach((c) => c.classList.remove("on"));
    tip.hide();
  });
  host.querySelector("svg")?.remove();
  host.prepend(el);
}

/** A line: the understanding score, broken on days with no reviews. */
export function drawScore(host: HTMLElement, days: DayView[]) {
  const width = Math.max(260, host.clientWidth);
  const el = svg(width);
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / Math.max(1, days.length - 1);
  const x = (i: number) => PAD.left + step * i;
  const y = (v: number) => PAD.top + plotH * (1 - v / 100);
  axes(el, width, 100, days, x, (n) => `${Math.round(n)}%`);

  let d = "";
  let pen = false;
  days.forEach((day, i) => {
    if (day.score === null) return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i)},${y(day.score)}`;
    pen = true;
  });
  if (d) add(el, "path", { d, class: "line" });
  days.forEach((day, i) => day.score !== null && add(el, "circle", { cx: x(i), cy: y(day.score), r: 4, class: "dot" }));

  // Label only the latest value, at the end of the line.
  const last = [...days.keys()].reverse().find((i) => days[i].score !== null);
  if (last !== undefined) add(el, "text", { x: x(last) + 8, y: y(days[last].score!) + 4, class: "end" }, `${days[last].score}%`);

  const hair = add(el, "line", { y1: PAD.top, y2: PAD.top + plotH, class: "hair" });
  const tip = tooltip(host);
  el.addEventListener("pointermove", (e) => {
    const box = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(days.length - 1, Math.round((e.clientX - box.left - PAD.left) / step)));
    const day = days[i];
    hair.setAttribute("x1", String(x(i)));
    hair.setAttribute("x2", String(x(i)));
    hair.style.display = "block";
    const when = dayLabel(day.day, { weekday: "short", month: "short", day: "numeric" });
    if (day.score === null) tip.show(x(i), "—", "nothing reviewed", when);
    else tip.show(x(i), `${day.score}%`, "understood", `${when} · ${day.reviewed} reviewed`);
  });
  el.addEventListener("pointerleave", () => {
    hair.style.display = "none";
    tip.hide();
  });
  host.querySelector("svg")?.remove();
  host.prepend(el);
}
