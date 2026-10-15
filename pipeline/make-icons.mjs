// One-off: draws the Trendy IPO app icon as PNGs (no image library) and writes icons/logo.svg.
// Artwork: glossy indigo tile, three chunky white bars, a thick gold trend line ending in an arrow, and a lucky sparkle.
// The same artwork is inline SVG in index.html (splash screen); keep them in step.
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const out = path.resolve(import.meta.dirname, "..", "icons");
await fs.mkdir(out, { recursive: true });
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };

// ---- artwork in a 100 x 100 box
const BARS = [[13, 60], [39.5, 44], [66, 28]], BW = 21, BASE = 88, BR = 4.5;      // x, top
const LINE = [[11, 50], [35, 35], [53, 42], [77, 19]], LW = 7;
const ANG = Math.atan2(19 - 42, 77 - 53), TIP = [77 + 12 * Math.cos(ANG), 19 + 12 * Math.sin(ANG)], AL = 17, AH = 9.5;
const STAR = [20, 24, 6];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const segDist = (px, py, [ax, ay], [bx, by]) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
const lineDist = (u, v) => Math.min(...LINE.slice(1).map((p, k) => segDist(u, v, LINE[k], p)));
const inRR = (u, v, x, y, w, h, r) => { if (u < x || u > x + w || v < y || v > y + h) return false; const cx = Math.min(Math.max(u, x + r), x + w - r), cy = Math.min(Math.max(v, y + r), y + h - r); return (u - cx) ** 2 + (v - cy) ** 2 <= r * r; };
const inArrow = (u, v) => { const rx = u - TIP[0], ry = v - TIP[1], c = Math.cos(ANG), s = Math.sin(ANG), lx = rx * c + ry * s, ly = -rx * s + ry * c; return lx <= 0 && lx >= -AL && Math.abs(ly) <= AH * (-lx) / AL + 0.6; };
const inStar = (u, v) => { const dx = Math.abs(u - STAR[0]) / STAR[2], dy = Math.abs(v - STAR[1]) / STAR[2]; return Math.sqrt(dx) + Math.sqrt(dy) <= 1; };
const over = (dst, src) => { const a = src[3] + dst[3] * (1 - src[3]); if (a <= 0) return [0, 0, 0, 0]; return [0, 1, 2].map(i => (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a).concat(a); };

// colour of the artwork at (u, v), straight RGBA with alpha 0..1; `bleed` = full-bleed tile (maskable icon)
function sample(u, v, { bleed = false, tile = true, art = true } = {}) {
  let px = [0, 0, 0, 0];
  const inTile = bleed || inRR(u, v, 0, 0, 100, 100, 24);
  if (tile && inTile) {
    const t = (u + v) / 200;
    px = [...(t < .55 ? mix([59, 130, 246], [79, 70, 229], t / .55) : mix([79, 70, 229], [49, 46, 129], (t - .55) / .45)), 1];
    if (v < 50) px = over(px, [255, 255, 255, .16 * (1 - v / 50)]);                           // gloss
  }
  if (!art) return px;
  for (const [x, top] of BARS) {
    if (inRR(u, v + 2.5, x, top, BW, BASE - top, BR)) px = over(px, [10, 10, 60, .30]);        // soft shadow under each bar
  }
  for (const [x, top] of BARS) if (inRR(u, v, x, top, BW, BASE - top, BR)) px = over(px, [...mix([255, 255, 255], [191, 207, 255], (v - top) / (BASE - top)), 1]);
  if (lineDist(u, v - 3) <= LW / 2 + 1.5) px = over(px, [20, 10, 70, .38]);                  // line shadow
  const gold = v0 => [...mix([253, 230, 138], [245, 158, 11], Math.max(0, Math.min(1, (v0 - 5) / 45))), 1];
  if (lineDist(u, v) <= LW / 2 || inArrow(u, v)) px = over(px, gold(v));
  if (inStar(u, v)) px = over(px, [255, 255, 255, .95]);
  return px;
}

function png(size, { maskable }) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const scale = maskable ? 0.66 : 1, off = (1 - scale) / 2, SS = 3;                         // maskable: art inside the safe zone on a full-bleed tile
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const U = ((x + (sx + .5) / SS) / size - off) / scale * 100, V = ((y + (sy + .5) / SS) / size - off) / scale * 100;
        const X = (x + (sx + .5) / SS) / size * 100, Y = (y + (sy + .5) / SS) / size * 100;
        let p = maskable ? over(sample(X, Y, { bleed: true, art: false }), sample(U, V, { tile: false })) : sample(U, V);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4, n = SS * SS;
      raw.set(a ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n * 255)] : [0, 0, 0, 0], o);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const [name, size, maskable] of [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["maskable-512.png", 512, true], ["apple-touch-icon.png", 180, false]])
  await fs.writeFile(path.join(out, name), png(size, { maskable }));

const f = n => +n.toFixed(2);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>
<linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B82F6"/><stop offset=".55" stop-color="#4F46E5"/><stop offset="1" stop-color="#312E81"/></linearGradient>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#BFCFFF"/></linearGradient>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FDE68A"/><stop offset="1" stop-color="#F59E0B"/></linearGradient>
<linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect width="100" height="100" rx="24" fill="url(#t)"/><path d="M0 24a24 24 0 0 1 24-24h52a24 24 0 0 1 24 24v26H0z" fill="url(#gl)"/>
${BARS.map(([x, t]) => `<rect x="${x}" y="${t + 2.5}" width="${BW}" height="${BASE - t}" rx="${BR}" fill="#0a0a3c" opacity=".3"/>`).join("")}
${BARS.map(([x, t]) => `<rect x="${x}" y="${t}" width="${BW}" height="${BASE - t}" rx="${BR}" fill="url(#b)"/>`).join("")}
<polyline points="${LINE.map(p => p.join(",")).join(" ")}" transform="translate(0 3)" fill="none" stroke="#140A46" stroke-opacity=".38" stroke-width="${LW + 3}" stroke-linecap="round" stroke-linejoin="round"/>
<polyline points="${LINE.map(p => p.join(",")).join(" ")}" fill="none" stroke="url(#g)" stroke-width="${LW}" stroke-linecap="round" stroke-linejoin="round"/>
<path transform="translate(${f(TIP[0])} ${f(TIP[1])}) rotate(${f(ANG * 180 / Math.PI)})" d="M0 0L-${AL} -${AH}L-${AL} ${AH}Z" fill="url(#g)" stroke="#F59E0B" stroke-width=".6" stroke-linejoin="round"/>
<path d="M${STAR[0]} ${STAR[1] - STAR[2]}Q${STAR[0]} ${STAR[1]} ${STAR[0] + STAR[2]} ${STAR[1]}Q${STAR[0]} ${STAR[1]} ${STAR[0]} ${STAR[1] + STAR[2]}Q${STAR[0]} ${STAR[1]} ${STAR[0] - STAR[2]} ${STAR[1]}Q${STAR[0]} ${STAR[1]} ${STAR[0]} ${STAR[1] - STAR[2]}Z" fill="#fff" opacity=".95"/></svg>`;
await fs.writeFile(path.join(out, "logo.svg"), svg);
console.log("icons written to", out);
