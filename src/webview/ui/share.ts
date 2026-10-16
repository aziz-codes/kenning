import type { ViewState } from "../protocol";

const W = 1200;
const H = 630;
const INK = "#efe6d6";
const MUTED = "#a99f8f";
const AMBER = "#e3a33b";
const SERIF = "Newsreader, Georgia, serif";

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function diamond(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  g.beginPath();
  g.moveTo(cx, cy - r);
  g.lineTo(cx + r, cy);
  g.lineTo(cx, cy + r);
  g.lineTo(cx - r, cy);
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

/** Today's score as a 1200×630 PNG, the size social networks preview best. */
export async function drawShareCard(s: ViewState): Promise<string> {
  await Promise.all([
    document.fonts.load(`600 200px Newsreader`),
    document.fonts.load(`italic 400 40px Newsreader`),
    document.fonts.load(`400 24px Newsreader`),
  ]).catch(() => undefined);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;

  // Background: warm black with a soft amber glow.
  g.fillStyle = "#14110d";
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.78, H * 0.42, 20, W * 0.78, H * 0.42, 520);
  glow.addColorStop(0, "rgba(227,163,59,0.16)");
  glow.addColorStop(1, "rgba(227,163,59,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  roundRect(g, 24, 24, W - 48, H - 48, 26);
  g.strokeStyle = "rgba(227,163,59,0.28)";
  g.lineWidth = 2;
  g.stroke();

  // Wordmark and date.
  diamond(g, 86, 92, 11, AMBER);
  g.fillStyle = INK;
  g.font = `500 34px ${SERIF}`;
  g.textBaseline = "middle";
  g.fillText("Kenning", 110, 92);
  g.fillStyle = MUTED;
  g.font = `400 22px ${SERIF}`;
  g.textAlign = "right";
  g.fillText(new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), W - 76, 92);
  g.textAlign = "left";

  // The score ring.
  const t = s.today;
  const score = t.score ?? 0;
  const cx = 880;
  const cy = 330;
  const r = 150;
  g.lineCap = "round";
  g.lineWidth = 18;
  g.strokeStyle = "rgba(239,230,214,0.10)";
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = AMBER;
  g.beginPath();
  g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * score) / 100);
  g.stroke();
  g.fillStyle = INK;
  g.textAlign = "center";
  g.font = `600 112px ${SERIF}`;
  g.fillText(`${score}`, cx - 14, cy + 4);
  g.font = `500 44px ${SERIF}`;
  g.fillStyle = AMBER;
  g.fillText("%", cx + 14 + g.measureText(`${score}`).width / 2 + 34, cy + 16);
  g.textAlign = "left";

  // The headline.
  g.fillStyle = INK;
  g.font = `italic 400 50px ${SERIF}`;
  g.fillText("Of the code my AI", 76, 236);
  g.fillText("wrote today, I truly", 76, 300);
  g.fillText("understood", 76, 364);
  g.fillStyle = AMBER;
  g.fillText(`${score}%.`, 76 + g.measureText("understood ").width, 364);

  // Stats.
  const stats: [string, string][] = [
    [String(t.reviewed), t.reviewed === 1 ? "change reviewed" : "changes reviewed"],
    [String(t.flagged), t.flagged === 1 ? "issue flagged" : "issues flagged"],
    [String(t.streak), t.streak === 1 ? "day streak" : "day streak"],
  ];
  let x = 76;
  g.textBaseline = "alphabetic";
  for (const [n, label] of stats) {
    g.fillStyle = AMBER;
    g.font = `600 40px ${SERIF}`;
    g.fillText(n, x, 482);
    const nw = g.measureText(n).width;
    g.fillStyle = MUTED;
    g.font = `400 22px ${SERIF}`;
    g.fillText(label, x, 516);
    x += Math.max(nw, g.measureText(label).width) + 56;
  }

  // Footer.
  g.fillStyle = "rgba(239,230,214,0.45)";
  g.font = `italic 400 20px ${SERIF}`;
  g.textAlign = "right";
  g.fillText("Kenning · understand the code your AI writes", W - 76, 552);

  return canvas.toDataURL("image/png");
}
