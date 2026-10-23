"use strict";
/* =========================================================
   Lista de juegos, búsqueda del autocompletado y detector de respuestas en el chat
   ========================================================= */
let GAMES = [];       // [{id, name, year, ss:[url], n, base, tok, compact, keys}]
let BY_ID = new Map();
const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const TO_ROMAN = Object.fromEntries(Object.entries(ROMAN).map(([r, d]) => [d, r]));
const SAGAS = [
  ["rainbow six siege", "r6"], ["rainbow six", "r6"], ["counter strike", "cs"], ["grand theft auto", "gta"],
  ["call of duty", "cod"], ["the elder scrolls", "tes"], ["team fortress", "tf"], ["left 4 dead", "l4d"],
  ["dead by daylight", "dbd"], ["euro truck simulator", "ets"], ["american truck simulator", "ats"],
  ["sid meiers civilization", "civ"], ["civilization", "civ"], ["red dead redemption", "rdr"],
  ["playerunknowns battlegrounds", "pubg"], ["metal gear solid", "mgs"], ["final fantasy", "ff"],
  ["fifa", "fifa"], ["ea sports fc", "fc"], ["assassins creed", "ac"], ["battlefield", "bf"],
  ["need for speed", "nfs"], ["resident evil", "re"], ["monster hunter", "mh"], ["devil may cry", "dmc"],
  ["kingdom come deliverance", "kcd"], ["baldurs gate", "bg"], ["fallout new vegas", "fnv"],
];
// Ediciones del mismo juego cuentan como el mismo: "GTA V Legacy" = "GTA V Enhanced"
const EDITION = /\b(legacy|enhanced edition|enhanced|remastered|remaster|special edition|definitive edition|game of the year edition|goty edition|goty|complete edition|anniversary edition|directors cut|intergrade|deluxe)\b/g;
const EXTRA = { "counter strike 2": ["csgo", "cs go", "counter strike global offensive"] };
// Para escribir en español: "pokemon rojo" encuentra "Pokémon Red"
const ES = { rojo: "red", azul: "blue", amarillo: "yellow", oro: "gold", plata: "silver", cristal: "crystal",
  rubi: "ruby", zafiro: "sapphire", esmeralda: "emerald", diamante: "diamond", perla: "pearl", platino: "platinum",
  negro: "black", blanco: "white", espada: "sword", escudo: "shield", escarlata: "scarlet", purpura: "violet",
  sol: "sun", luna: "moon", verde: "green", hoja: "leaf", fuego: "fire" };
// Palabras demasiado comunes para delatar un juego en el chat
const COMMON = new Set(("the and edition game games remastered remake simulator world online deluxe collection " +
  "super legend legends battle wars war adventure adventures dark night last ultimate origins party saga story " +
  "hero heroes star stars city tales quest final total time space dead land lands life black blood king kings " +
  "new from with into your return rise fall part chapter episode season vol volume special plus pro " +
  "classic classics racing sports soccer football league tour this that what like good nice").split(" "));

function norm(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim()
    .split(" ").filter(Boolean).map((w) => ROMAN[w] || w).join(" ");
}
function shotUrl(id, s) {
  if (!s.includes("|")) return s;
  const [h, st, file] = s.split("|");
  if (h === "r") return `https://media.rawg.io/media/resize/1280/-/${file}`;
  const host = h === "a" ? "shared.akamai.steamstatic.com" : h === "f" ? "shared.fastly.steamstatic.com" : h;
  return `https://${host}/${st === "1" ? "store_item_assets/" : ""}steam/apps/${id}/${file}`;
}
function meta(g) {
  // Solo el año: la consola que da RAWG no siempre es la original
  return g && g.year ? String(g.year) : "";
}
function prepareGames(raw) {
  GAMES = raw.map(([id, name, year, ss, plat], rank) => {
    const n = norm(name);
    const tok = n.split(" ");
    const compact = tok.join("");
    const base = n.replace(EDITION, " ").replace(/\s+/g, " ").trim() || n;
    const keys = new Set([compact, base.replace(/ /g, "")]);
    for (const t of new Set([n, base])) {
      const tk = t.split(" ");
      // siglas: "grand theft auto 5" -> gta5 y gta; "counter strike 2" -> cs2
      const initials = tk.map((w) => (/^\d+$/.test(w) ? w : w[0])).join("");
      if (initials.length >= 2) keys.add(initials);
      const letters = tk.filter((w) => !/^\d+$/.test(w)).map((w) => w[0]).join("");
      if (letters.length >= 2) keys.add(letters);
    }
    // nombre sin subtítulo: "the witcher 3 wild hunt" -> también "the witcher 3"
    const parts = name.split(/[:–—]| - /);
    const main = norm(parts[0]);
    // siglas del subtítulo: "Zelda: Breath of the Wild" -> botw, "Ocarina of Time" -> oot
    if (parts.length > 1) {
      const sub = norm(parts.slice(1).join(" ")).split(" ").filter(Boolean);
      if (sub.length >= 2) keys.add(sub.map((w) => (/^\d+$/.test(w) ? w : w[0])).join(""));
    }
    if (main && main !== n) keys.add(main.replace(/ /g, ""));
    // apodos de sagas que la gente usa
    for (const [phrase, abbr] of SAGAS) {
      if (!base.includes(phrase)) continue;
      const rest = base.replace(phrase, "").trim();
      const num = (rest.match(/^\d+/) || [""])[0];
      keys.add(abbr + num);
      keys.add((abbr + rest).replace(/ /g, ""));
    }
    for (const a of EXTRA[base] || []) keys.add(a.replace(/ /g, ""));
    // "gtav", "rdrii": el número también como romano
    for (const k of [...keys]) { const m = k.match(/^(.*?)(\d+)$/); if (m && TO_ROMAN[m[2]]) keys.add(m[1] + TO_ROMAN[m[2]]); }
    return { id, name, year, plat: plat || "PC", rank, ss: ss.map((s) => shotUrl(id, s)), n, base, tok, compact, keys: [...keys] };
  });
  BY_ID = new Map(GAMES.map((g) => [g.id, g]));
}

function search(q, limit = 8) {
  const nq = norm(q).split(" ").map((w) => ES[w] || w).join(" ");
  if (nq.length < 2 && !/^\d$/.test(nq)) return [];
  const qt = nq.split(" ");
  const qc = qt.join("");
  const res = [];
  for (const g of GAMES) {
    let s = -1;
    if (g.n === nq || g.compact === qc) s = 0;
    else if (g.keys.includes(qc)) s = 1;
    else if (g.n.startsWith(nq)) s = 2;
    else if (qt.every((t) => g.tok.some((w) => w.startsWith(t)))) s = 3;
    else if (qc.length >= 3 && g.compact.includes(qc)) s = 4;
    if (s >= 0) res.push([s, g.rank, g]);
  }
  res.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return res.slice(0, limit).map((r) => r[2]);
}

// ¿Este mensaje de chat dice la respuesta? (para taparlo durante la ronda)
function revealsAnswer(text, g) {
  if (!g) return false;
  const t = norm(text).split(" ").map((w) => ES[w] || w).join(" ");
  if (!t) return false;
  const arr = t.split(" ");
  const toks = new Set(arr);
  for (let i = 0; i + 1 < arr.length; i++) toks.add(arr[i] + arr[i + 1]); // "gta 5" -> "gta5"
  const compact = t.replace(/ /g, "");
  const words = g.tok.filter((w) => w.length >= 4 && !COMMON.has(w) && !/^\d+$/.test(w));
  if (words.some((w) => toks.has(w))) return true;
  if (g.compact.length >= 4 && compact.includes(g.compact)) return true;
  for (const k of g.keys) {
    if (/^\d+$/.test(k) || k.length < 3) continue;
    if (k.length >= 5 ? compact.includes(k) : toks.has(k)) return true;
  }
  return false;
}

async function loadGames() {
  try {
    const res = await fetch("data/games.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    prepareGames(data.games || []);
    return data.updated || "";
  } catch (e) {
    GAMES = [];
    return "";
  }
}
