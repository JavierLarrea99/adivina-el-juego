// Genera data/games.json con los juegos más populares de Steam y sus capturas.
// Se ejecuta en GitHub Actions (ver .github/workflows/juegos.yml). Node 20+.
//
//   node scripts/juegos.mjs candidates            -> candidates.json (lista ordenada de appids)
//   node scripts/juegos.mjs shard <i> <n>          -> part-<i>.json (detalles de su trozo)
//   node scripts/juegos.mjs merge <dir>            -> data/games.json

import fs from "node:fs";
import path from "node:path";

const MAX_CANDIDATES = 2600; // se piden más de los que se quedan, porque algunos se descartan
const MAX_GAMES = 1600;
const MIN_SHOTS = 4;
const SHOTS_PER_GAME = 10;
const DELAY_MS = 1600; // Steam permite ~200 peticiones cada 5 minutos por IP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { tries = 6 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "adivina-el-juego/1.0" } });
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        const wait = 30000 * (i + 1);
        console.log(`  ${res.status} en ${url}, espero ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.log(`  error ${e.message} en ${url}`);
      await sleep(5000 * (i + 1));
    }
  }
  return null;
}

async function candidates() {
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
    .slice(0, MAX_CANDIDATES)
    .map((g) => g.id);
  if (list.length < 500) throw new Error(`Solo ${list.length} candidatos, algo ha fallado`);
  fs.writeFileSync("candidates.json", JSON.stringify(list));
  console.log(`${list.length} candidatos guardados`);
}

function cleanName(n) {
  return n.replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
}

async function shard(i, n) {
  const list = JSON.parse(fs.readFileSync("candidates.json", "utf8"));
  const mine = list.map((id, rank) => ({ id, rank })).filter((_, k) => k % n === i);
  const out = [];
  for (const { id, rank } of mine) {
    const data = await getJson(`https://store.steampowered.com/api/appdetails?appids=${id}&l=english&cc=us`);
    await sleep(DELAY_MS);
    const d = data?.[id];
    if (!d?.success) continue;
    const g = d.data;
    if (g.type !== "game") continue;
    const adult = (g.content_descriptors?.ids || []).some((x) => x === 3 || x === 4);
    if (adult) continue;
    const shots = (g.screenshots || []).map((s) => s.path_full).filter(Boolean);
    if (shots.length < MIN_SHOTS) continue;
    const year = (g.release_date?.date || "").match(/\d{4}/)?.[0];
    out.push({
      id,
      rank,
      name: cleanName(g.name),
      year: year ? Number(year) : null,
      ss: shots.slice(0, SHOTS_PER_GAME).map((u) => u.split("?")[0]),
    });
    if (out.length % 25 === 0) console.log(`trozo ${i}: ${out.length} juegos`);
  }
  fs.writeFileSync(`part-${i}.json`, JSON.stringify(out));
  console.log(`trozo ${i}: ${out.length} juegos guardados de ${mine.length}`);
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
  games.sort((a, b) => a.rank - b.rank);
  // nombres repetidos (relanzamientos): se queda el más popular
  const seen = new Set();
  games = games.filter((g) => {
    const k = g.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  games = games.slice(0, MAX_GAMES);
  if (games.length < 300) throw new Error(`Solo ${games.length} juegos, no sobrescribo los datos`);

  // Comprime las URLs: casi todas comparten el mismo principio
  const compact = games.map((g) => {
    const shots = g.ss.map((u) => {
      const m = u.match(/^https:\/\/([a-z.]+)\/(?:store_item_assets\/)?steam\/apps\/(\d+)\/(.+)$/);
      if (m && Number(m[2]) === g.id) {
        const host = m[1] === "shared.akamai.steamstatic.com" ? "a" : m[1] === "shared.fastly.steamstatic.com" ? "f" : m[1];
        const store = u.includes("/store_item_assets/") ? 1 : 0;
        return `${host}|${store}|${m[3]}`;
      }
      return u;
    });
    return [g.id, g.name, g.year, shots];
  });
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(
    "data/games.json",
    JSON.stringify({ updated: new Date().toISOString().slice(0, 10), games: compact })
  );
  console.log(`data/games.json: ${compact.length} juegos`);
}

const [, , cmd, a, b] = process.argv;
if (cmd === "candidates") await candidates();
else if (cmd === "shard") await shard(Number(a), Number(b));
else if (cmd === "merge") merge(a || ".");
else {
  console.log("uso: candidates | shard <i> <n> | merge <dir>");
  process.exit(1);
}
