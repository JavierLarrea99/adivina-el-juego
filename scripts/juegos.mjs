// Genera data/games.json: juegos de Steam + juegos de consola y clásicos de RAWG, con sus capturas.
// Se ejecuta en GitHub Actions (ver .github/workflows/juegos.yml). Node 20+.
//
//   node scripts/juegos.mjs candidates        -> candidates.json (lista ordenada de candidatos)
//   node scripts/juegos.mjs shard <i> <n>      -> part-<i>.json (detalles + filtro OCR de su trozo)
//   node scripts/juegos.mjs merge <dir>        -> data/games.json
//
// Variables de entorno: RAWG_KEY (opcional; sin ella solo se usan juegos de Steam).
// El filtro OCR necesita el programa `tesseract` instalado (si falta, no se filtra).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const STEAM_CANDIDATES = 2600; // se piden más de los que se quedan, porque algunos se descartan
const MAX_GAMES = 3200;
const SHOTS_PER_GAME = 6;
const DELAY_MS = 1600; // Steam permite ~200 peticiones cada 5 minutos por IP
const OCR_PARALLEL = 4;

// Programas que Steam marca como "juego" pero no lo son
const NOT_GAMES = /wallpaper engine|soundpad|rpg maker|gamemaker studio|vtube studio|lossless scaling|steamvr|source sdk|dedicated server|playtest|benchmark|\bdemo\b|soundtrack|blender|aseprite|krita|clip studio/i;

// Plataformas de RAWG: [slugs posibles, nombre que se enseña, cuántos juegos coger, filtro extra]
const RAWG_PLATFORMS = [
  [["nintendo-switch"], "Switch", 150],
  [["wii-u"], "Wii U", 40],
  [["wii"], "Wii", 70],
  [["gamecube"], "GameCube", 60],
  [["nintendo-64"], "Nintendo 64", 60],
  [["snes"], "Super Nintendo", 70],
  [["nes"], "NES", 70],
  [["game-boy"], "Game Boy", 35],
  [["game-boy-color"], "Game Boy Color", 25],
  [["game-boy-advance"], "Game Boy Advance", 60],
  [["nintendo-ds"], "Nintendo DS", 70],
  [["nintendo-3ds"], "Nintendo 3DS", 60],
  [["playstation1", "playstation"], "PlayStation", 80],
  [["playstation2"], "PlayStation 2", 100],
  [["playstation3"], "PlayStation 3", 80],
  [["playstation4"], "PlayStation 4", 100],
  [["playstation5"], "PlayStation 5", 60],
  [["psp"], "PSP", 50],
  [["ps-vita"], "PS Vita", 20],
  [["xbox-old", "xbox"], "Xbox", 40],
  [["xbox360"], "Xbox 360", 70],
  [["xbox-one"], "Xbox One", 50],
  [["xbox-series-x"], "Xbox Series", 30],
  [["genesis", "sega-genesis"], "Mega Drive", 60],
  [["sega-master-system"], "Master System", 20],
  [["sega-saturn"], "Saturn", 20],
  [["dreamcast"], "Dreamcast", 35],
  [["game-gear"], "Game Gear", 15],
  [["neogeo"], "Neo Geo", 20],
  [["atari-2600"], "Atari 2600", 25],
  [["commodore-amiga"], "Amiga", 25],
  [["pc"], "PC", 150, "&dates=1980-01-01,2006-12-31"], // clásicos de PC
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { tries = 6 } = {}) {
  const shown = url.replace(/key=[^&]+/, "key=***");
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "adivina-el-juego/1.0" } });
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        const wait = 30000 * (i + 1);
        console.log(`  ${res.status} en ${shown}, espero ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.log(`  error ${e.message} en ${shown}`);
      await sleep(5000 * (i + 1));
    }
  }
  return null;
}

// ---------- nombres (igual que en la web) ----------
const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const EDITION = /\b(legacy|enhanced edition|enhanced|remastered|remaster|special edition|definitive edition|game of the year edition|goty edition|goty|complete edition|anniversary edition|directors cut|intergrade|deluxe)\b/g;
function norm(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim()
    .split(" ").filter(Boolean).map((w) => ROMAN[w] || w).join(" ");
}
function baseName(name) {
  const n = norm(name);
  return n.replace(EDITION, " ").replace(/\s+/g, " ").trim() || n;
}
function cleanName(n) {
  return n.replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
}

// ---------- filtro OCR ----------
// Palabras demasiado comunes para delatar un juego (pueden salir en cualquier menú o marcador)
const STOP = new Set(("the and edition game games remastered remake simulator world online deluxe collection " +
  "super legend legends battle wars war adventure adventures dark night last ultimate origins party saga story " +
  "hero heroes star stars city tales quest final total time space dead land lands life black blood king kings " +
  "new from with into your return rise fall part chapter episode season vol volume special plus pro edition " +
  "classic classics racing sports soccer football league world tour").split(" "));
let hasTesseract = null;
async function tesseractReady() {
  if (hasTesseract === null) {
    hasTesseract = await new Promise((r) => execFile("tesseract", ["--version"], (e) => r(!e)));
    if (!hasTesseract) console.log("tesseract no está instalado: no se filtran capturas");
  }
  return hasTesseract;
}
function smallUrl(u) {
  if (u.includes("steamstatic.com")) return u.replace(/\.1920x1080\.jpg$/, ".600x338.jpg");
  if (u.includes("media.rawg.io/media/") && !u.includes("/resize/")) return u.replace("/media/", "/media/resize/640/-/");
  return u;
}
async function ocr(url) {
  try {
    const res = await fetch(smallUrl(url));
    if (!res.ok) return null;
    const f = path.join(os.tmpdir(), `shot-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    const text = await new Promise((r) =>
      execFile("tesseract", [f, "stdout", "--psm", "11", "-l", "eng"], { timeout: 30000 }, (e, out) => r(e ? "" : out))
    );
    fs.rmSync(f, { force: true });
    return text;
  } catch {
    return null;
  }
}
// Devuelve solo las capturas en las que NO se lee el nombre del juego
async function filterShots(name, shots) {
  if (!(await tesseractReady())) return shots;
  const n = norm(name);
  const words = [...new Set(n.split(" ").filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))];
  const compact = n.replace(/ /g, "");
  const keep = [];
  for (let i = 0; i < shots.length; i += OCR_PARALLEL) {
    const batch = shots.slice(i, i + OCR_PARALLEL);
    const texts = await Promise.all(batch.map(ocr));
    batch.forEach((u, k) => {
      const t = texts[k];
      if (t == null) { keep.push(u); return; } // si no se puede leer, se queda
      const tn = norm(t);
      const toks = new Set(tn.split(" "));
      const leaks = (compact.length >= 5 && tn.replace(/ /g, "").includes(compact)) || words.some((w) => toks.has(w));
      if (leaks) console.log(`  descarto captura de "${name}" (se lee el nombre)`);
      else keep.push(u);
    });
  }
  return keep;
}

// ---------- candidatos ----------
async function steamCandidates() {
  const all = {};
  for (let page = 0; page < 4; page++) {
    const data = await getJson(`https://steamspy.com/api.php?request=all&page=${page}`);
    if (data) Object.assign(all, data);
    console.log(`SteamSpy página ${page}: ${data ? Object.keys(data).length : 0} juegos`);
    if (page < 3) await sleep(61000); // SteamSpy: 1 petición "all" por minuto
  }
  const list = Object.values(all)
    .map((g) => ({ id: Number(g.appid), reviews: (g.positive || 0) + (g.negative || 0) }))
    .filter((g) => g.id && g.reviews > 0)
    .sort((a, b) => b.reviews - a.reviews)
    .slice(0, STEAM_CANDIDATES);
  if (list.length < 500) throw new Error(`Solo ${list.length} candidatos de Steam, algo ha fallado`);
  return list.map((g, i) => ({ src: "steam", id: g.id, pct: i / list.length }));
}

async function rawgCandidates(key) {
  const slugToId = {};
  let url = `https://api.rawg.io/api/platforms?key=${key}&page_size=50`;
  while (url) {
    const d = await getJson(url);
    if (!d) break;
    for (const p of d.results || []) slugToId[p.slug] = p.id;
    url = d.next;
  }
  const out = [];
  const seen = new Set();
  for (const [slugs, label, quota, extra = ""] of RAWG_PLATFORMS) {
    const slug = slugs.find((s) => slugToId[s]);
    if (!slug) { console.log(`RAWG: no encuentro la plataforma ${label}`); continue; }
    let pos = 0;
    let added = 0;
    for (let page = 1; pos < quota && page <= Math.ceil(quota / 40) + 1; page++) {
      const d = await getJson(`https://api.rawg.io/api/games?key=${key}&platforms=${slugToId[slug]}&ordering=-added&page_size=40&page=${page}${extra}`);
      if (!d?.results) break;
      for (const g of d.results) {
        if (pos >= quota) break;
        const pct = pos++ / quota;
        if (seen.has(g.id)) continue;
        if (g.esrb_rating?.slug === "adults-only") continue;
        if ((g.tags || []).some((t) => /nsfw|sexual|hentai|nudity/.test(t.slug))) continue;
        const shots = (g.short_screenshots || []).filter((s) => s.id !== -1 && s.image).map((s) => s.image);
        if (shots.length < 2) continue;
        seen.add(g.id);
        added++;
        out.push({
          src: "rawg",
          id: 10_000_000 + g.id,
          name: cleanName(g.name),
          year: g.released ? Number(g.released.slice(0, 4)) : null,
          plat: label,
          shots: shots.slice(0, SHOTS_PER_GAME),
          pct,
        });
      }
      if (!d.next) break;
      await sleep(300);
    }
    console.log(`RAWG ${label}: ${added} juegos nuevos`);
  }
  return out;
}

async function candidates() {
  const steam = await steamCandidates();
  const key = process.env.RAWG_KEY;
  const rawg = key ? await rawgCandidates(key) : [];
  if (!key) console.log("Sin RAWG_KEY: solo juegos de Steam");
  // Mezcla por popularidad relativa dentro de cada lista, para que los más famosos de cada consola
  // estén también entre los "muy famosos"
  const list = [...steam, ...rawg].sort((a, b) => a.pct - b.pct).map((c, rank) => ({ ...c, rank }));
  fs.writeFileSync("candidates.json", JSON.stringify(list));
  console.log(`${list.length} candidatos (${steam.length} Steam, ${rawg.length} RAWG)`);
}

// ---------- detalles de cada trozo ----------
async function steamGame(c) {
  const t0 = Date.now();
  const data = await getJson(`https://store.steampowered.com/api/appdetails?appids=${c.id}&l=english&cc=us`);
  const d = data?.[c.id];
  let game = null;
  if (d?.success) {
    const g = d.data;
    const adult = (g.content_descriptors?.ids || []).some((x) => x === 3 || x === 4);
    if (g.type === "game" && !adult && !NOT_GAMES.test(g.name)) {
      let shots = (g.screenshots || []).map((s) => s.path_full).filter(Boolean).map((u) => u.split("?")[0]);
      if (shots.length > 4) shots = shots.slice(1); // la primera suele ser arte con el logo
      shots = shots.slice(0, SHOTS_PER_GAME);
      if (shots.length >= 3) {
        const year = (g.release_date?.date || "").match(/\d{4}/)?.[0];
        const name = cleanName(g.name);
        shots = await filterShots(name, shots);
        if (shots.length >= 2) game = { id: c.id, rank: c.rank, name, year: year ? Number(year) : null, plat: "PC", ss: shots };
      }
    }
  }
  const wait = DELAY_MS - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  return game;
}

async function rawgGame(c) {
  const shots = await filterShots(c.name, c.shots);
  if (shots.length < 2) return null;
  return { id: c.id, rank: c.rank, name: c.name, year: c.year, plat: c.plat, ss: shots };
}

async function shard(i, n) {
  const list = JSON.parse(fs.readFileSync("candidates.json", "utf8"));
  const mine = list.filter((_, k) => k % n === i);
  const out = [];
  let done = 0;
  for (const c of mine) {
    const g = c.src === "steam" ? await steamGame(c) : await rawgGame(c);
    if (g) out.push(g);
    if (++done % 25 === 0) console.log(`trozo ${i}: ${done}/${mine.length} revisados, ${out.length} juegos`);
  }
  fs.writeFileSync(`part-${i}.json`, JSON.stringify(out));
  console.log(`trozo ${i}: ${out.length} juegos guardados de ${mine.length}`);
}

// ---------- unir ----------
function compactShot(id, u) {
  let m = u.match(/^https:\/\/([a-z.]+)\/(?:store_item_assets\/)?steam\/apps\/(\d+)\/(.+)$/);
  if (m && Number(m[2]) === id) {
    const host = m[1] === "shared.akamai.steamstatic.com" ? "a" : m[1] === "shared.fastly.steamstatic.com" ? "f" : m[1];
    return `${host}|${u.includes("/store_item_assets/") ? 1 : 0}|${m[3]}`;
  }
  m = u.match(/^https:\/\/media\.rawg\.io\/media\/(.+)$/);
  if (m) return `r|0|${m[1]}`;
  return u;
}

function merge(dir) {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/^part-\d+\.json$/.test(f)) files.push(p);
    }
  })(dir);
  let games = files.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  games = games.filter((g) => !NOT_GAMES.test(g.name));
  games.sort((a, b) => a.rank - b.rank);
  // el mismo juego en varias tiendas o ediciones: se queda el más popular
  const seen = new Set();
  games = games.filter((g) => {
    const k = baseName(g.name);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  games = games.slice(0, MAX_GAMES);
  if (games.length < 300) throw new Error(`Solo ${games.length} juegos, no sobrescribo los datos`);

  const compact = games.map((g) => [g.id, g.name, g.year, g.ss.map((u) => compactShot(g.id, u)), g.plat || "PC"]);
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/games.json", JSON.stringify({ updated: new Date().toISOString().slice(0, 10), games: compact }));
  const consoles = games.filter((g) => g.plat && g.plat !== "PC").length;
  console.log(`data/games.json: ${compact.length} juegos (${consoles} de consola)`);
}

const [, , cmd, a, b] = process.argv;
if (cmd === "candidates") await candidates();
else if (cmd === "shard") await shard(Number(a), Number(b));
else if (cmd === "merge") merge(a || ".");
else if (cmd === "test-ocr") console.log(await filterShots(a, b.split(",")));
else {
  console.log("uso: candidates | shard <i> <n> | merge <dir>");
  process.exit(1);
}
