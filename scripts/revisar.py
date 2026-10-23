#!/usr/bin/env python3
"""Revisa las capturas de cada juego y quita las que no sirven para adivinar.

Se descartan:
  - menús, pantallas de título, logos, pantallas de carga, arte promocional, portadas y créditos
    (las detecta un modelo de visión, CLIP, comparando la imagen con descripciones de texto)
  - capturas donde se lee el nombre del juego (lector de texto, tesseract)
  - capturas con palabras típicas de menú ("new game", "press start", "loading"...)
  - capturas con mucho texto
  - pantallas casi negras o de un solo color
  - imágenes que no se pueden descargar

Uso:
  python scripts/revisar.py filtrar part-3.json
      Filtra en el sitio las capturas de un trozo generado por juegos.mjs.
  python scripts/revisar.py muestra data/games.json --n 250 --salida revision
      Prueba con juegos al azar y genera hojas de contacto para revisar a ojo.

Necesita: tesseract instalado, y los paquetes de scripts/requirements.txt (más torch).
"""

import argparse
import io
import json
import os
import random
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps

os.environ["OMP_THREAD_LIMIT"] = "1"  # cada tesseract usa un solo núcleo; se lanzan varios a la vez

MAX_SHOTS = 6          # capturas que se guardan por juego
OCR_WIDTH = 1280       # ancho al que se reduce la imagen para leer texto
WORKERS = 6            # descargas + lector de texto en paralelo

# ---------------- umbrales (calibrados mirando hojas de contacto) ----------------
CLIP_REJECT = 0.50     # probabilidad sumada de las clases "no es una captura de juego"
CLIP_STRONG = 0.30     # probabilidad de una sola clase muy clara (logo, menú, título...)
TEXT_COVERAGE = 0.055  # fracción de la imagen ocupada por palabras leídas con seguridad
TEXT_WORDS = 45        # o muchas palabras
WEAK_MENU_HITS = 3     # palabras sueltas de menú necesarias para considerarlo menú
DARK_MEAN = 16         # brillo medio por debajo del cual es "pantalla negra"
FLAT_STD = 10          # contraste por debajo del cual es "pantalla lisa"

# ---------------- descripciones para CLIP ----------------
# (texto, True si es una captura buena)
PROMPTS = [
    ("a screenshot of gameplay from a video game", True),
    ("an in-game screenshot of a 3D video game", True),
    ("a screenshot of a 2D side-scrolling video game", True),
    ("a pixel art video game screenshot", True),
    ("a screenshot of a first-person shooter game", True),
    ("a screenshot of a third-person action game", True),
    ("a screenshot of a top-down strategy game", True),
    ("a screenshot of a racing video game", True),
    ("a screenshot of a sports video game", True),
    ("a screenshot of a fighting game with health bars", True),
    ("a screenshot of a puzzle video game", True),
    ("a screenshot of a role-playing game with a character exploring", True),
    ("a video game screenshot of a landscape", True),
    ("a video game screenshot with a heads-up display", True),
    ("a cutscene from a video game", True),
    ("a screenshot of a simulation or management game with a user interface", True),
    ("a screenshot of a card game", True),
    ("a screenshot of a retro 8-bit or 16-bit game", True),
    ("a video game main menu", False),
    ("a video game title screen with the game's logo", False),
    ("a video game logo", False),
    ("a video game logo in the corner of a screenshot", False),
    ("a video game loading screen", False),
    ("a video game options menu with settings", False),
    ("a pause menu in a video game", False),
    ("a save file selection screen", False),
    ("a video game credits screen", False),
    ("a black screen", False),
    ("promotional key art for a video game", False),
    ("video game box art", False),
    ("a poster with the title of a video game", False),
    ("a collage of video game screenshots with text", False),
    ("a screen full of text", False),
    ("an image with a large title", False),
    ("a company logo", False),
    ("concept art painting", False),
]
GOOD = np.array([g for _, g in PROMPTS])

# ---------------- texto ----------------
ROMAN = {"ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}
STOP = set((
    "the and edition game games remastered remake simulator world online deluxe collection "
    "super legend legends battle wars war adventure adventures dark night last ultimate origins party saga story "
    "hero heroes star stars city tales quest final total time space dead land lands life black blood king kings "
    "new from with into your return rise fall part chapter episode season vol volume special plus pro edition "
    "classic classics racing sports soccer football league world tour"
).split())
STRONG_MENU = [re.compile(p) for p in (
    r"\bpress (start|any|enter|space|the|a button|button)\b", r"\bpush (start|button)\b",
    r"\b(main|pause|title) menu\b", r"\bnew game\b", r"\bload game\b", r"\bstart game\b", r"\bcontinue game\b",
    r"\bnow loading\b", r"\bloading\b", r"\ball rights reserved\b", r"\bcopyright\b",
    r"\blicensed (by|to|from)\b", r"\bpresents\b", r"\bnueva partida\b", r"\bcargar partida\b", r"\bcargando\b",
)]
WEAK_MENU = set((
    "continue options settings quit exit credits extras multiplayer singleplayer campaign graphics audio "
    "controls language difficulty resolution brightness subtitles save load resume achievements leaderboards "
    "store tutorial profile apply confirm cancel versus opciones salir continuar ajustes jugar"
).split())
WEAK_MENU_PHRASES = ["single player", "story mode", "co op", "how to play", "play game"]


def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("&", " and ")
    s = re.sub(r"['’`]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return " ".join(ROMAN.get(w, w) for w in s.split() if w)


def name_words(name):
    n = norm(name)
    words = sorted({w for w in n.split() if len(w) >= 4 and w not in STOP and not w.isdigit()})
    return words, n.replace(" ", "")


# ---------------- URLs (igual que la web) ----------------
def shot_url(game_id, s):
    if "|" not in s:
        return s
    h, st, f = s.split("|", 2)
    if h == "r":
        return f"https://media.rawg.io/media/resize/1280/-/{f}"
    host = {"a": "shared.akamai.steamstatic.com", "f": "shared.fastly.steamstatic.com"}.get(h, h)
    return f"https://{host}/{'store_item_assets/' if st == '1' else ''}steam/apps/{game_id}/{f}"


def fetch_url(u):
    """URL que se descarga para revisar (las de RAWG, ya reducidas a 1280)."""
    m = re.match(r"^https://media\.rawg\.io/media/(?!resize/)(.+)$", u)
    return f"https://media.rawg.io/media/resize/1280/-/{m.group(1)}" if m else u


_session = requests.Session()
_session.headers["User-Agent"] = "adivina-el-juego/1.0"


def download(u):
    for i in range(3):
        try:
            r = _session.get(fetch_url(u), timeout=25)
            if r.status_code == 200 and r.content:
                img = Image.open(io.BytesIO(r.content))
                img.load()
                return img.convert("RGB")
            if r.status_code in (403, 404, 410):
                return None
        except Exception:
            pass
        time.sleep(2 * (i + 1))
    return None


# ---------------- análisis de una captura ----------------
def ocr(img):
    import pytesseract
    w, h = img.size
    try:
        d = pytesseract.image_to_data(img, config="--psm 11", output_type=pytesseract.Output.DICT, timeout=40)
    except Exception:
        return [], 0.0
    words, area = [], 0
    for txt, conf, bw, bh in zip(d["text"], d["conf"], d["width"], d["height"]):
        try:
            conf = float(conf)
        except ValueError:
            continue
        t = (txt or "").strip()
        if conf < 60 or sum(c.isalpha() for c in t) < 2:
            continue
        words.append(t)
        if len(t) >= 3:
            area += bw * bh
    return words, area / float(w * h)


def analyze(item):
    """Descarga y revisa lo que no necesita el modelo de visión."""
    img = download(item["url"])
    if img is None:
        item["reasons"] = ["no se descarga"]
        return item
    if img.width > OCR_WIDTH:
        img = img.resize((OCR_WIDTH, round(img.height * OCR_WIDTH / img.width)), Image.BILINEAR)
    gray = np.asarray(img.convert("L"), dtype=np.float32)
    item["mean"], item["std"] = float(gray.mean()), float(gray.std())
    words, coverage = ocr(img)
    text = norm(" ".join(words))
    toks = set(text.split())
    nwords, compact = item["name_words"]
    reasons = []
    if item["mean"] < DARK_MEAN or item["std"] < FLAT_STD:
        reasons.append("pantalla negra/lisa")
    leaked = [w for w in nwords if w in toks]
    if (len(compact) >= 5 and compact in text.replace(" ", "")) or leaked:
        reasons.append("se lee el nombre" + (f" ({leaked[0]})" if leaked else ""))
    strong = next((p.pattern for p in STRONG_MENU if p.search(text)), None)
    weak = {w for w in toks if w in WEAK_MENU} | {p for p in WEAK_MENU_PHRASES if p in text}
    if strong or len(weak) >= WEAK_MENU_HITS:
        reasons.append("texto de menú")
    if coverage > TEXT_COVERAGE or len(words) > TEXT_WORDS:
        reasons.append(f"mucho texto ({len(words)} palabras)")
    item.update(reasons=reasons, words=len(words), coverage=round(coverage, 4), text=text[:120])
    item["img"] = img
    return item


class Clip:
    def __init__(self):
        import torch
        import open_clip
        self.torch = torch
        torch.set_num_threads(os.cpu_count() or 4)
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k")
        self.model.eval()
        tok = open_clip.get_tokenizer("ViT-B-32")
        with torch.no_grad():
            t = self.model.encode_text(tok([p for p, _ in PROMPTS]))
            self.text = t / t.norm(dim=-1, keepdim=True)
            self.scale = float(self.model.logit_scale.exp())

    def views(self, img):
        # imagen entera (con bandas negras para hacerla cuadrada) + recorte central
        side = max(img.size)
        padded = Image.new("RGB", (side, side))
        padded.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        return [self.preprocess(padded), self.preprocess(img)]

    def score(self, imgs):
        torch = self.torch
        batch = torch.stack([v for im in imgs for v in self.views(im)])
        with torch.no_grad():
            f = self.model.encode_image(batch)
            f = f / f.norm(dim=-1, keepdim=True)
            p = (self.scale * f @ self.text.T).softmax(dim=-1).numpy()
        p = p.reshape(len(imgs), 2, -1).mean(axis=1)
        return p


def judge(items, clip):
    """Añade la puntuación de CLIP y la decisión final a cada captura."""
    ok = [it for it in items if "img" in it]
    if not ok:
        return items
    for i in range(0, len(ok), 32):
        chunk = ok[i:i + 32]
        probs = clip.score([it["img"] for it in chunk])
        for it, p in zip(chunk, probs):
            bad = float(p[~GOOD].sum())
            top_bad = int(np.argmax(np.where(GOOD, -1, p)))
            it["clip_bad"] = round(bad, 3)
            it["clip_top"] = PROMPTS[int(np.argmax(p))][0]
            it["clip_bad_top"] = PROMPTS[top_bad][0]
            it["clip_bad_top_p"] = round(float(p[top_bad]), 3)
            if bad > CLIP_REJECT or float(p[top_bad]) > CLIP_STRONG:
                it["reasons"].append(f"visión: {PROMPTS[top_bad][0]}")
    return items


def run(items, clip, thumbs=False):
    with ThreadPoolExecutor(WORKERS) as ex:
        done = []
        for i in range(0, len(items), 96):
            chunk = list(ex.map(analyze, items[i:i + 96]))
            judge(chunk, clip)
            for it in chunk:  # no guardar las imágenes grandes en memoria
                img = it.pop("img", None)
                if thumbs and img is not None:
                    it["thumb"] = ImageOps.pad(img, (316, 176), color=(0, 0, 0))
            done.extend(chunk)
            print(f"  revisadas {len(done)}/{len(items)}", flush=True)
    return done


# ---------------- modo filtrar (lo usa la acción semanal) ----------------
def filtrar(path):
    games = json.load(open(path))
    items = []
    for g in games:
        nw = name_words(g["name"])
        for u in g["ss"]:
            items.append({"gid": g["id"], "name": g["name"], "url": u, "name_words": nw})
    print(f"{path}: {len(games)} juegos, {len(items)} capturas", flush=True)
    clip = Clip()
    t0 = time.time()
    run(items, clip)
    by_game = {}
    for it in items:
        by_game.setdefault(it["gid"], []).append(it)
    out, removed, reasons = [], 0, {}
    for g in games:
        good = [it for it in by_game.get(g["id"], []) if not it["reasons"]]
        for it in by_game.get(g["id"], []):
            for r in it["reasons"]:
                key = r.split(" (")[0].split(":")[0]
                reasons[key] = reasons.get(key, 0) + 1
        removed += len(g["ss"]) - len(good)
        good.sort(key=lambda it: it.get("clip_bad", 1))  # las más "de juego" primero
        if good:
            out.append({**g, "ss": [it["url"] for it in good[:MAX_SHOTS]]})
    json.dump(out, open(path, "w"))
    print(f"{path}: quedan {len(out)} juegos; {removed} capturas descartadas en {time.time() - t0:.0f}s: {reasons}")


# ---------------- modo muestra (para calibrar a ojo) ----------------
def load_font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def sheet(items, path, title, cols=5):
    tw, th, lh = 320, 180, 54
    rows = max(1, -(-len(items) // cols))
    W, H = cols * tw, 40 + rows * (th + lh)
    out = Image.new("RGB", (W, H), (24, 22, 40))
    d = ImageDraw.Draw(out)
    f_title, f = load_font(22), load_font(13)
    d.text((10, 8), title, fill=(255, 210, 63), font=f_title)
    for i, it in enumerate(items):
        x, y = (i % cols) * tw, 40 + (i // cols) * (th + lh)
        if "thumb" in it:
            out.paste(it["thumb"], (x + 2, y + 2))
        lines = [
            f"{it['name'][:38]}",
            ", ".join(it["reasons"])[:46] or f"ok · clip {it.get('clip_bad', '?')}",
            f"clip {it.get('clip_bad', '?')} · {it.get('clip_bad_top', '')[:28]} {it.get('clip_bad_top_p', '')}",
        ]
        for k, line in enumerate(lines):
            d.text((x + 4, y + th + 2 + k * 16), line, fill=(240, 238, 250) if k != 1 else (255, 140, 120), font=f)
    out.save(path, quality=82)


def muestra(path, n, salida, seed):
    data = json.load(open(path))["games"]
    random.seed(seed)
    pick = random.sample(data, min(n, len(data)))
    items = []
    for gid, name, year, ss, *rest in pick:
        nw = name_words(name)
        for s in ss:
            items.append({"gid": gid, "name": name, "url": shot_url(gid, s), "name_words": nw})
    print(f"muestra: {len(pick)} juegos, {len(items)} capturas", flush=True)
    clip = Clip()
    t0 = time.time()
    run(items, clip, thumbs=True)
    secs = time.time() - t0
    os.makedirs(salida, exist_ok=True)
    rejected = [it for it in items if it["reasons"]]
    accepted = [it for it in items if not it["reasons"]]
    counts = {}
    for it in rejected:
        for r in it["reasons"]:
            key = r.split(" (")[0].split(":")[0]
            counts[key] = counts.get(key, 0) + 1
    per = 40
    for k in range(0, len(rejected), per):
        sheet(rejected[k:k + per], f"{salida}/rechazadas-{k // per + 1:02d}.jpg",
              f"Rechazadas {k + 1}-{min(k + per, len(rejected))} de {len(rejected)}")
    border = sorted(accepted, key=lambda it: -it.get("clip_bad", 0))[:per]
    sheet(border, f"{salida}/aceptadas-dudosas.jpg", "Aceptadas con más puntuación de 'no es juego'")
    sheet(random.sample(accepted, min(per, len(accepted))), f"{salida}/aceptadas-azar.jpg", "Aceptadas al azar")
    per_game = {}
    for it in items:
        per_game.setdefault(it["gid"], [0, 0])
        per_game[it["gid"]][0 if it["reasons"] else 1] += 1
    summary = {
        "juegos": len(pick), "capturas": len(items), "rechazadas": len(rejected), "motivos": counts,
        "juegos_sin_capturas": sum(1 for v in per_game.values() if v[1] == 0),
        "segundos": round(secs), "umbrales": {"CLIP_REJECT": CLIP_REJECT, "CLIP_STRONG": CLIP_STRONG,
                                               "TEXT_COVERAGE": TEXT_COVERAGE, "TEXT_WORDS": TEXT_WORDS},
        "detalle": [{k: v for k, v in it.items() if k not in ("thumb", "name_words")} for it in items],
    }
    json.dump(summary, open(f"{salida}/resumen.json", "w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in summary.items() if k != "detalle"}, ensure_ascii=False))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("modo", choices=["filtrar", "muestra"])
    ap.add_argument("ruta")
    ap.add_argument("--n", type=int, default=250)
    ap.add_argument("--salida", default="revision")
    ap.add_argument("--semilla", type=int, default=7)
    a = ap.parse_args()
    if a.modo == "filtrar":
        filtrar(a.ruta)
    else:
        muestra(a.ruta, a.n, a.salida, a.semilla)
