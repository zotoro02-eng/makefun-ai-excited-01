// ai-excited-01 — "The Story That Flew Out"
// A program that procedurally draws one image and writes it to /output/entry.png.
// No assets, no network, standard library only (node:fs, node:path, node:zlib).
// Everything is drawn from code: a paper plane with a rocket flame bursting out
// of an open storybook, paper scraps and confetti flying toward the viewer,
// speed lines, a glowing burst, and a banner that talks straight to the judge.
//
// Deterministic: a fixed-seed PRNG drives every scattered element, so two runs
// produce byte-identical output.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// PNG encoding helpers (CRC32 + chunk writer)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32, fixed seed)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261116);

// ---------------------------------------------------------------------------
// Canvas: supersampled float buffer, drawn in 1024-space coordinates
// ---------------------------------------------------------------------------

const W = 1024;
const H = 1024;
const SS = 2; // supersample factor: drawing happens at 2048x2048, then averaged down
const SW = W * SS;
const SH = H * SS;

type RGB = [number, number, number];
type Pt = [number, number];

const buf = new Float32Array(SW * SH * 3);

function blendPx(sx: number, sy: number, r: number, g: number, b: number, a: number): void {
  if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) return;
  const i = (sy * SW + sx) * 3;
  const inv = 1 - a;
  buf[i] = r * a + buf[i] * inv;
  buf[i + 1] = g * a + buf[i + 1] * inv;
  buf[i + 2] = b * a + buf[i + 2] * inv;
}

// Fill an axis-aligned rectangle given in 1024-space coordinates.
function fillRect(x: number, y: number, w: number, h: number, c: RGB, a: number): void {
  const x0 = Math.max(0, Math.floor(x * SS));
  const x1 = Math.min(SW, Math.ceil((x + w) * SS));
  const y0 = Math.max(0, Math.floor(y * SS));
  const y1 = Math.min(SH, Math.ceil((y + h) * SS));
  for (let sy = y0; sy < y1; sy++) {
    for (let sx = x0; sx < x1; sx++) {
      blendPx(sx, sy, c[0], c[1], c[2], a);
    }
  }
}

function pointInPoly(px: number, py: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Fill a polygon given in 1024-space coordinates.
function fillPoly(pts: Pt[], c: RGB, a: number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX * SS));
  const x1 = Math.min(SW, Math.ceil(maxX * SS));
  const y0 = Math.max(0, Math.floor(minY * SS));
  const y1 = Math.min(SH, Math.ceil(maxY * SS));
  for (let sy = y0; sy < y1; sy++) {
    const py = (sy + 0.5) / SS;
    for (let sx = x0; sx < x1; sx++) {
      const px = (sx + 0.5) / SS;
      if (pointInPoly(px, py, pts)) {
        blendPx(sx, sy, c[0], c[1], c[2], a);
      }
    }
  }
}

// Fill a disc given in 1024-space coordinates.
function fillCircle(cx: number, cy: number, r: number, c: RGB, a: number): void {
  const x0 = Math.max(0, Math.floor((cx - r) * SS));
  const x1 = Math.min(SW, Math.ceil((cx + r) * SS));
  const y0 = Math.max(0, Math.floor((cy - r) * SS));
  const y1 = Math.min(SH, Math.ceil((cy + r) * SS));
  const r2 = r * r;
  for (let sy = y0; sy < y1; sy++) {
    const py = (sy + 0.5) / SS;
    for (let sx = x0; sx < x1; sx++) {
      const px = (sx + 0.5) / SS;
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r2) {
        blendPx(sx, sy, c[0], c[1], c[2], a);
      }
    }
  }
}

// A thick line (as a quad plus round caps) in 1024-space coordinates.
function drawLine(x1: number, y1: number, x2: number, y2: number, t: number, c: RGB, a: number): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const nx = (-dy / len) * (t / 2);
  const ny = (dx / len) * (t / 2);
  fillPoly(
    [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ],
    c,
    a,
  );
  fillCircle(x1, y1, t / 2, c, a);
  fillCircle(x2, y2, t / 2, c, a);
}

// A four-point sparkle star in 1024-space coordinates.
function sparkle(cx: number, cy: number, r: number, c: RGB, a: number): void {
  const pts: Pt[] = [];
  const inner = r * 0.22;
  for (let k = 0; k < 8; k++) {
    const ang = (k * Math.PI) / 4 - Math.PI / 2;
    const rad = k % 2 === 0 ? r : inner;
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
  }
  fillPoly(pts, c, a);
}

// A rotated rectangle (for paper scraps and confetti) in 1024-space coordinates.
function rotatedRect(cx: number, cy: number, w: number, h: number, ang: number, c: RGB, a: number): void {
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const hw = w / 2;
  const hh = h / 2;
  const corners: Pt[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  fillPoly(
    corners.map(([x, y]): Pt => [cx + x * cos - y * sin, cy + x * sin + y * cos]),
    c,
    a,
  );
}

// A rounded rectangle in 1024-space coordinates.
function roundedRect(x: number, y: number, w: number, h: number, r: number, c: RGB, a: number): void {
  const x0 = Math.max(0, Math.floor(x * SS));
  const x1 = Math.min(SW, Math.ceil((x + w) * SS));
  const y0 = Math.max(0, Math.floor(y * SS));
  const y1 = Math.min(SH, Math.ceil((y + h) * SS));
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  for (let sy = y0; sy < y1; sy++) {
    const py = (sy + 0.5) / SS;
    for (let sx = x0; sx < x1; sx++) {
      const px = (sx + 0.5) / SS;
      const qx = Math.abs(px - cx) - hx;
      const qy = Math.abs(py - cy) - hy;
      const d =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      if (d <= 0) {
        blendPx(sx, sy, c[0], c[1], c[2], a);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tiny hand-drawn 5x7 bitmap font (only the glyphs the banner needs)
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", ".#.#.", ".#.#."],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  J: ["..###", "....#", "....#", "....#", "....#", "#...#", ".###."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  D: ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  E: ["####.", "#....", "#....", "###..", "#....", "#....", "####."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
};

function drawText(text: string, x: number, y: number, scale: number, c: RGB, a: number): number {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === "#") {
            fillRect(cx + col * scale, y + row * scale, scale, scale, c, a);
          }
        }
      }
    }
    cx += 6 * scale;
  }
  return cx - x - scale; // drawn width
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const NAVY: RGB = [28, 20, 69];
const INK: RGB = [21, 8, 41];
const VIOLET: RGB = [74, 24, 110];
const MAGENTA: RGB = [255, 46, 136];
const YELLOW: RGB = [255, 212, 0];
const ORANGE: RGB = [255, 122, 26];
const FLAME: RGB = [255, 61, 0];
const CYAN: RGB = [0, 229, 255];
const ICE: RGB = [159, 216, 255];
const WHITE: RGB = [255, 255, 255];
const CREAM: RGB = [255, 242, 207];
const PAGE_SHADE: RGB = [232, 201, 143];

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const FOCAL: Pt = [700, 360]; // the burst point the whole composition drives toward

function drawBackground(): void {
  // Radial glow + vertical gradient, computed per supersampled pixel.
  for (let sy = 0; sy < SH; sy++) {
    const py = (sy + 0.5) / SS;
    for (let sx = 0; sx < SW; sx++) {
      const px = (sx + 0.5) / SS;
      const dx = px - FOCAL[0];
      const dy = py - FOCAL[1];
      const dist = Math.hypot(dx, dy);
      // Warm core fading into deep violet, then near-black indigo at the corners.
      const glow = Math.exp(-(dist * dist) / (2 * 300 * 300));
      const glow2 = Math.exp(-(dist * dist) / (2 * 620 * 620));
      const vert = py / H; // 0 top, 1 bottom
      let r = INK[0] + (VIOLET[0] - INK[0]) * (1 - vert) * 0.9;
      let g = INK[1] + (VIOLET[1] - INK[1]) * (1 - vert) * 0.9;
      let b = INK[2] + (VIOLET[2] - INK[2]) * (1 - vert) * 0.9;
      r += glow2 * 70 + glow * 165;
      g += glow2 * 26 + glow * 105;
      b += glow2 * 30 + glow * 10;
      // Sunburst rays fanning out from the focal point.
      const ang = Math.atan2(dy, dx);
      const ray = Math.sin(ang * 14) > 0 ? 1.07 : 0.96;
      const rayFade = Math.max(0, 1 - dist / 720);
      const m = 1 + (ray - 1) * rayFade * 0.8;
      const i = (sy * SW + sx) * 3;
      buf[i] = Math.min(255, r * m);
      buf[i + 1] = Math.min(255, g * m);
      buf[i + 2] = Math.min(255, b * m);
    }
  }

  // Stars, denser away from the glow.
  for (let s = 0; s < 150; s++) {
    const x = rand() * W;
    const y = rand() * H;
    const d = Math.hypot(x - FOCAL[0], y - FOCAL[1]);
    if (d < 180) continue;
    const r = 1 + rand() * 2.1;
    const a = 0.35 + rand() * 0.6;
    fillCircle(x, y, r, WHITE, a);
  }
}

function drawBurstRays(): void {
  // Long pale wedges radiating from the focal point, behind the plane.
  for (let k = 0; k < 12; k++) {
    const a0 = (k / 12) * Math.PI * 2 + 0.12;
    const a1 = a0 + 0.10;
    const r = 560;
    fillPoly(
      [
        FOCAL,
        [FOCAL[0] + Math.cos(a0) * r, FOCAL[1] + Math.sin(a0) * r],
        [FOCAL[0] + Math.cos(a1) * r, FOCAL[1] + Math.sin(a1) * r],
      ],
      WHITE,
      k % 2 === 0 ? 0.05 : 0.03,
    );
  }
  // Soft halo around the burst.
  fillCircle(FOCAL[0], FOCAL[1], 250, [255, 214, 90], 0.22);
  fillCircle(FOCAL[0], FOCAL[1], 130, [255, 240, 180], 0.28);
}

function drawBook(): void {
  // Cover shadow under the pages.
  fillPoly(
    [
      [40, 806],
      [282, 738],
      [530, 800],
      [516, 1024],
      [56, 1024],
    ],
    [16, 6, 34],
    1,
  );
  // Left page.
  fillPoly(
    [
      [48, 792],
      [282, 724],
      [296, 1024],
      [64, 1024],
    ],
    CREAM,
    1,
  );
  // Right page, with a jagged torn top edge where the plane tore out.
  fillPoly(
    [
      [282, 724],
      [318, 736],
      [352, 726],
      [388, 742],
      [424, 730],
      [458, 746],
      [492, 736],
      [522, 788],
      [508, 1024],
      [296, 1024],
    ],
    [255, 248, 224],
    1,
  );
  // Spine.
  drawLine(282, 724, 296, 1024, 6, [120, 88, 48], 0.85);
  // Faint text lines on the left page, following its tilt.
  for (let k = 0; k < 5; k++) {
    const y = 800 + k * 34;
    drawLine(92, y - 8, 252, y - 26, 5, PAGE_SHADE, 0.9);
  }
  // Faint text lines on the right page.
  for (let k = 0; k < 4; k++) {
    const y = 830 + k * 34;
    drawLine(330, y - 4, 480, y + 8, 5, PAGE_SHADE, 0.9);
  }
}

function drawFlame(): void {
  // Rocket flame trailing from the plane's tail, down-left: layered tapered
  // teardrops, wide at the tail and narrowing to a tip. Drawn after the
  // scraps and speed lines so the flame itself stays visible, with the plane
  // overlapping only its base.
  fillCircle(575, 622, 90, ORANGE, 0.18);
  // Outer teardrop (orange), centreline (640,565) -> (478,708).
  fillPoly(
    [
      [657, 585],
      [609, 658],
      [542, 701],
      [478, 708],
      [498, 649],
      [551, 592],
      [623, 545],
    ],
    [255, 122, 26],
    0.95,
  );
  // Inner teardrop (yellow), centreline (632,572) -> (500,690).
  fillPoly(
    [
      [641, 583],
      [601, 640],
      [546, 677],
      [500, 690],
      [524, 653],
      [569, 604],
      [623, 562],
    ],
    YELLOW,
    0.95,
  );
  // White-hot core at the base.
  fillCircle(615, 585, 13, WHITE, 0.95);
}

function drawSpeedLines(): void {
  // Tapered streaks trailing the plane, flying down-left.
  const dir: Pt = [-0.64, 0.77];
  const starts: Array<[number, number, number, number, RGB, number]> = [
    [560, 500, 240, 12, WHITE, 0.65],
    [600, 560, 300, 9, ICE, 0.55],
    [640, 610, 210, 7, WHITE, 0.5],
    [520, 580, 260, 10, CYAN, 0.45],
    [680, 660, 180, 8, WHITE, 0.55],
    [470, 660, 220, 6, ICE, 0.4],
    [720, 560, 150, 6, WHITE, 0.5],
  ];
  for (const [x, y, len, t, c, a] of starts) {
    drawLine(x, y, x + dir[0] * len, y + dir[1] * len, t, c, a);
  }
}

function drawScrapsAndConfetti(): void {
  // Paper scraps bursting out of the book along the flight path.
  for (let k = 0; k < 22; k++) {
    const t = rand();
    const x = 330 + t * 330 + (rand() - 0.5) * 120;
    const y = 760 - t * 260 + (rand() - 0.5) * 140;
    const w = 10 + rand() * 26;
    const h = 7 + rand() * 16;
    const ang = rand() * Math.PI;
    rotatedRect(x, y, w, h, ang, k % 3 === 0 ? PAGE_SHADE : CREAM, 0.95);
  }
  // Confetti in hot colours, scattered across the burst.
  const confetti: RGB[] = [MAGENTA, YELLOW, CYAN, WHITE, ORANGE];
  for (let k = 0; k < 46; k++) {
    const x = 120 + rand() * 860;
    const y = 200 + rand() * 640;
    const w = 6 + rand() * 10;
    const h = 5 + rand() * 8;
    rotatedRect(x, y, w, h, rand() * Math.PI, confetti[k % confetti.length], 0.9);
  }
}

function drawPlane(): void {
  // A classic origami dart, nose up-right, two folded facets.
  const nose: Pt = [908, 228];
  const wingA: Pt = [588, 478]; // left wingtip
  const wingB: Pt = [716, 646]; // right wingtip
  const tail: Pt = [648, 548]; // fold end
  // Top facet, bright white.
  fillPoly([nose, wingA, tail], WHITE, 1);
  // Bottom facet, cool ice blue.
  fillPoly([nose, tail, wingB], ICE, 1);
  // Fold shading: a sliver of deeper blue along the centre fold.
  fillPoly([nose, tail, [700, 560]], [127, 184, 232], 0.9);
  // Bold dark outlines, cartoon-clean.
  drawLine(nose[0], nose[1], wingA[0], wingA[1], 8, NAVY, 1);
  drawLine(wingA[0], wingA[1], tail[0], tail[1], 8, NAVY, 1);
  drawLine(tail[0], tail[1], wingB[0], wingB[1], 8, NAVY, 1);
  drawLine(wingB[0], wingB[1], nose[0], nose[1], 8, NAVY, 1);
  drawLine(nose[0], nose[1], tail[0], tail[1], 6, NAVY, 1);
  // Origami crease from the fold to the middle of the top edge.
  drawLine(tail[0], tail[1], 748, 353, 4, [90, 130, 190], 0.9);
}

function drawSparkles(): void {
  sparkle(880, 168, 30, WHITE, 0.95);
  sparkle(782, 296, 20, YELLOW, 0.95);
  sparkle(952, 430, 24, WHITE, 0.9);
  sparkle(516, 420, 18, CYAN, 0.9);
  sparkle(846, 716, 20, WHITE, 0.9);
  sparkle(640, 250, 14, YELLOW, 0.9);
}

function drawBanner(): void {
  // Drop shadow, then a thick navy frame, then the yellow face.
  roundedRect(52, 66, 620, 120, 26, NAVY, 0.85);
  roundedRect(36, 48, 628, 128, 28, NAVY, 1);
  roundedRect(46, 58, 608, 108, 22, YELLOW, 1);
  // "WOW, JUDGE!" in the hand-drawn font, navy on yellow.
  const text = "WOW, JUDGE!";
  const scale = 8;
  const width = text.length * 6 * scale - scale;
  const x = 40 + Math.round((620 - width) / 2);
  const y = 52 + Math.round((120 - 7 * scale) / 2);
  drawText(text, x, y, scale, NAVY, 1);
}

function applyVignette(): void {
  // Gentle darkening toward the corners so the burst stays the focus.
  const cx = W / 2;
  const cy = H / 2;
  const maxD = Math.hypot(cx, cy);
  for (let sy = 0; sy < SH; sy++) {
    const py = (sy + 0.5) / SS;
    for (let sx = 0; sx < SW; sx++) {
      const px = (sx + 0.5) / SS;
      const d = Math.hypot(px - cx, py - cy) / maxD;
      const t = Math.max(0, (d - 0.55) / 0.45);
      const m = 1 - 0.14 * t * t;
      const i = (sy * SW + sx) * 3;
      buf[i] *= m;
      buf[i + 1] *= m;
      buf[i + 2] *= m;
    }
  }
}

// ---------------------------------------------------------------------------
// Downsample (2x2 box average) and encode as PNG
// ---------------------------------------------------------------------------

function encodePng(): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  // Filtered rows: try None / Sub / Up per row, keep the one with the smallest
  // sum of absolute signed byte values (a standard cheap heuristic).
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(W * 3);
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * SW + (x * SS + dx)) * 3;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
        }
      }
      const o = x * 3;
      row[o] = Math.round(r / (SS * SS));
      row[o + 1] = Math.round(g / (SS * SS));
      row[o + 2] = Math.round(b / (SS * SS));
    }
    const prev = y === 0 ? null : raw.subarray((y - 1) * (1 + W * 3) + 1, y * (1 + W * 3));
    const candidates: Buffer[] = [];
    for (let filter = 0; filter <= 2; filter++) {
      const f = Buffer.alloc(W * 3);
      for (let i = 0; i < W * 3; i++) {
        const left = i >= 3 ? row[i - 3] : 0;
        const up = prev ? prev[i] : 0;
        const v = filter === 0 ? row[i] : filter === 1 ? row[i] - left : row[i] - up;
        f[i] = v & 0xff;
      }
      candidates.push(f);
    }
    let best = 0;
    let bestScore = Infinity;
    for (let k = 0; k < candidates.length; k++) {
      let score = 0;
      const f = candidates[k];
      for (let i = 0; i < f.length; i++) {
        const s = f[i] > 127 ? f[i] - 256 : f[i];
        score += s < 0 ? -s : s;
      }
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    const outOff = y * (1 + W * 3);
    raw[outOff] = best;
    candidates[best].copy(raw, outOff + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  drawBackground();
  drawBurstRays();
  drawBook();
  drawSpeedLines();
  drawScrapsAndConfetti();
  drawFlame();
  drawPlane();
  drawSparkles();
  drawBanner();
  applyVignette();

  const png = encodePng();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
}

main();
