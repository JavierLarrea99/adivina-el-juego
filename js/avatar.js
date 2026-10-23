"use strict";
/* =========================================================
   Avatares: monstruitos de píxel generados a partir de un número (semilla).
   Cada jugador tiene {seed, color}; con eso cualquiera dibuja el mismo monstruo.
   ========================================================= */
const AVATAR_COLORS = ["#ff6b4a", "#ffd23f", "#4fd08a", "#5cc8ff", "#c38bff", "#ff8fc7",
  "#9be15d", "#ffa94d", "#7ae7e0", "#e6e1ff", "#ff5c7a", "#b6a6ff"];

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAvatar() {
  return { seed: Math.floor(Math.random() * 2147483647), color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] };
}

// Lo que llega de otro jugador no es de fiar: solo números y colores de la paleta
function validAvatar(a) {
  const seed = Number(a && a.seed);
  const color = a && AVATAR_COLORS.includes(a.color) ? a.color : AVATAR_COLORS[0];
  return { seed: Number.isFinite(seed) ? Math.abs(Math.floor(seed)) % 2147483647 : 1, color };
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
function tint(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Cuadrícula de 8x8 simétrica: 0 vacío, 1 cuerpo, 2 ojo, 3 boca, 4 mancha
const spriteCache = new Map();
function sprite(seed) {
  if (spriteCache.has(seed)) return spriteCache.get(seed);
  const r = rng(seed);
  const rowP = [0.28, 0.5, 0.78, 0.82, 0.8, 0.72, 0.55, 0.42];
  const half = [];
  for (let y = 0; y < 8; y++) {
    half.push([]);
    for (let x = 0; x < 4; x++) {
      const colP = [-0.25, -0.05, 0.08, 0.2][x];
      half[y].push(r() < rowP[y] + colP ? 1 : 0);
    }
  }
  for (let y = 2; y <= 5; y++) { half[y][2] = 1; half[y][3] = 1; } // tronco
  const ey = 2 + Math.floor(r() * 2);
  const ex = 1 + Math.floor(r() * 2);
  half[ey][ex] = 2;
  for (const [dy, dx] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const yy = ey + dy, xx = ex + dx;
    if (yy >= 0 && yy < 8 && xx >= 0 && xx < 4 && half[yy][xx] === 0) half[yy][xx] = 1;
  }
  if (r() < 0.6 && ey + 2 < 8) half[ey + 2][3] = 3;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) if (half[y][x] === 1 && r() < 0.12) half[y][x] = 4;
  const pupil = [[0.5, 0.5], [0, 0.5], [0.25, 0.5], [0.5, 0.25]][Math.floor(r() * 4)];
  const grid = half.map((row) => row.concat(row.slice().reverse()));
  const out = { grid, pupil };
  spriteCache.set(seed, out);
  return out;
}

function avatarSVG(av, px) {
  const a = validAvatar(av);
  const { grid, pupil } = sprite(a.seed);
  const dark = shade(a.color, 0.62);
  let rects = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = grid[y][x];
      if (!v) continue;
      const fill = v === 2 ? "#fff" : v === 3 ? "#1b1730" : v === 4 ? dark : a.color;
      rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
      if (v === 2) {
        // las dos pupilas miran al mismo lado
        rects += `<rect x="${x + pupil[0]}" y="${y + pupil[1]}" width=".5" height=".5" fill="#1b1730"/>`;
      }
    }
  }
  return `<svg viewBox="-1 -1 10 10" width="${px}" height="${px}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

// Devuelve un <span class="ava"> listo para insertar (HTML seguro: solo números y colores validados)
function avatarHTML(av, px, extra = "") {
  const a = validAvatar(av);
  return `<span class="ava ${extra}" style="width:${px}px;height:${px}px;background:${tint(a.color, 0.16)}">${avatarSVG(a, Math.round(px * 0.86))}</span>`;
}
