// Writes media/activity.svg from the Cinzel Bold "K" outline:
//   node scripts/activity-icon.cjs <path/to/opentype.js> <path/to/Cinzel-Bold.ttf> > media/activity.svg
const opentype = require(process.argv[2]);
const font = opentype.loadSync(process.argv[3]);
const g = font.charToGlyph("K");
const p0 = g.getPath(0, 0, 1000), b = p0.getBoundingBox();
// fit the ink into the 24px box with 2px padding
const s = 20 / Math.max(b.x2 - b.x1, b.y2 - b.y1);
const p = g.getPath(12 - ((b.x1 + b.x2) / 2) * s, 12 - ((b.y1 + b.y2) / 2) * s, 1000 * s);
console.log(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="${p.toPathData(2)}"/></svg>`);
