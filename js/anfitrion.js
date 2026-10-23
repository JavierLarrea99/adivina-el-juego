"use strict";
/* =========================================================
   Lógica del anfitrión: su pestaña hace de servidor de la partida.
   Recibe los mensajes de los jugadores, decide y manda el estado a todos.
   ========================================================= */
const TRIES = 3;
const REVEAL_MS = 5500;
const COUNTDOWN_MS = 3000;
const MAX_PLAYERS = 24;
const REACTIONS = ["😂", "😮", "🔥", "👏", "😭", "🤔", "💀", "🫡"];
const IMAGE_MODES = ["normal", "pixel", "zoom"];
const SETTINGS_ALLOWED = { target: [50, 100, 150], time: [10, 20, 30], pool: [250, 700, 0], mode: ["normal", "pixel", "zoom", "mix"] };

// Capturas que se saltaron por votación en este dispositivo: no vuelven a salir aquí
const BadShots = {
  key: "adivina-malas",
  load() { try { return new Set(JSON.parse(localStorage.getItem(this.key) || "[]")); } catch { return new Set(); } },
  add(url) {
    const s = this.load(); s.add(url);
    try { localStorage.setItem(this.key, JSON.stringify([...s].slice(-500))); } catch {}
  },
};

const Host = {
  players: new Map(), // id -> jugador
  settings: { target: 100, time: 20, pool: 250, mode: "normal" },
  phase: "lobby",
  round: 0,
  current: null,  // {gameId, img, mode, focus}
  next: null,
  used: new Set(),
  startedAt: 0,
  timer: null,
  correct: 0,
  skips: new Set(),
  reveal: null,
  winner: null,
  stats: null,
  phaseEndsAt: 0,
  feed: [],
  feedSeq: 0,
  seq: 0,
  code: null,

  init(c) { this.code = c; },

  addLocal(name, tok, avatar) {
    const p = this.newPlayer(name, tok, avatar);
    p.local = true;
    return p.id;
  },

  newPlayer(name, tok, avatar) {
    const id = "p" + (++this.seq);
    const p = {
      id, name: this.uniqueName(name, null), token: tok, avatar: validAvatar(avatar), score: 0, online: true, conn: null,
      tries: TRIES, done: false, gain: 0, correct: 0, streak: 0, bestStreak: 0, fastest: null,
      lastChat: 0, chatTimes: [], lastReact: 0,
    };
    this.players.set(id, p);
    return p;
  },

  uniqueName(name, selfId) {
    const base = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 16) || "Jugador";
    let n = base, k = 2;
    const taken = () => [...this.players.values()].some((p) => p.id !== selfId && p.name.toLowerCase() === n.toLowerCase());
    while (taken()) n = base.slice(0, 13) + " " + k++;
    return n;
  },

  accept(conn) {
    let pid = null;
    conn.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (!pid) {
        if (msg.t !== "hello") return;
        const tok = String(msg.token || "").slice(0, 64);
        let p = [...this.players.values()].find((x) => x.token === tok && !x.local);
        const back = !!p;
        if (p) {
          if (p.conn && p.conn !== conn) { try { p.conn.close(); } catch {} }
          p.online = true; p.conn = conn;
          p.name = this.uniqueName(String(msg.name || p.name), p.id);
          p.avatar = validAvatar(msg.avatar || p.avatar);
        } else {
          if (this.players.size >= MAX_PLAYERS) { conn.send({ t: "full" }); setTimeout(() => conn.close(), 500); return; }
          p = this.newPlayer(String(msg.name || ""), tok, msg.avatar);
          p.conn = conn;
          // quien entra a mitad de ronda espera a la siguiente
          if (this.phase === "round") { p.done = true; p.tries = 0; }
        }
        pid = p.id;
        conn.send({ t: "welcome", you: pid, feed: this.feed });
        this.addFeed({ k: "sys", tone: "join", from: p.id, text: back ? "ha vuelto" : "ha entrado" });
        this.broadcast();
        return;
      }
      this.handle(pid, msg);
    });
    conn.on("close", () => {
      const p = pid && this.players.get(pid);
      if (!p || p.conn !== conn) return; // ya se reconectó con otra conexión
      p.online = false; p.conn = null;
      this.addFeed({ k: "sys", tone: "leave", from: p.id, text: "se ha ido" });
      if (this.phase === "lobby") this.players.delete(pid);
      this.checkRoundDone();
      this.broadcast();
    });
  },

  handle(pid, msg) {
    const p = this.players.get(pid);
    if (!p) return;
    switch (msg.t) {
      case "guess": return this.guess(p, Number(msg.gameId));
      case "skip": return this.skip(p);
      case "chat": return this.chat(p, msg.text);
      case "react": return this.react(p, msg.e);
      case "avatar": p.avatar = validAvatar(msg.avatar); return this.broadcast();
    }
    if (pid !== myId) return; // lo demás solo lo puede hacer el anfitrión
    if (msg.t === "settings") {
      for (const [k, v] of Object.entries(msg.settings || {})) if (SETTINGS_ALLOWED[k] && SETTINGS_ALLOWED[k].includes(v)) this.settings[k] = v;
      this.broadcast();
    } else if (msg.t === "start") this.startGame();
    else if (msg.t === "lobby") { clearTimeout(this.timer); this.phase = "lobby"; this.broadcast(); }
  },

  send(p, msg) {
    if (p.local) queueMicrotask(() => onMessage(msg));
    else if (p.conn && p.conn.open) { try { p.conn.send(msg); } catch {} }
  },
  sendAll(msg) { for (const p of this.players.values()) if (p.online) this.send(p, msg); },

  item(o) {
    const it = { id: ++this.feedSeq, ts: Date.now(), ...o };
    const p = o.from && this.players.get(o.from);
    if (p) { it.name = p.name; it.avatar = p.avatar; } // por si luego se va de la sala
    return it;
  },
  addFeed(o) {
    const it = this.item(o);
    this.feed.push(it);
    if (this.feed.length > 80) this.feed.shift();
    this.sendAll({ t: "feed", item: it });
  },

  chat(p, raw) {
    const text = String(raw || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    p.chatTimes = p.chatTimes.filter((t) => now - t < 5000);
    if (now - p.lastChat < 450 || p.chatTimes.length >= 5) {
      this.send(p, { t: "feed", item: this.item({ k: "sys", tone: "info", text: "Vas muy rápido: espera un momento antes de escribir otra vez." }) });
      return;
    }
    p.lastChat = now; p.chatTimes.push(now);
    if (this.phase === "round" && revealsAnswer(text, BY_ID.get(this.current.gameId))) {
      this.send(p, { t: "feed", item: this.item({ k: "sys", tone: "censor", text: "Tu mensaje decía la respuesta y no se ha enviado 🤐" }) });
      this.addFeed({ k: "sys", tone: "censor", from: p.id, text: "casi dice la respuesta 🤐" });
      return;
    }
    this.addFeed({ k: "msg", from: p.id, text });
  },

  react(p, e) {
    const i = Number(e);
    if (!Number.isInteger(i) || i < 0 || i >= REACTIONS.length) return;
    const now = Date.now();
    if (now - p.lastReact < 350) return;
    p.lastReact = now;
    this.sendAll({ t: "react", from: p.id, e: i });
  },

  pick() {
    const size = this.settings.pool ? Math.min(this.settings.pool, GAMES.length) : GAMES.length;
    const bad = BadShots.load();
    // una sola edición de cada juego, y sin repetir hasta agotar la lista
    const seen = new Set();
    const all = GAMES.slice(0, size).filter((g) => !seen.has(g.base) && seen.add(g.base) && g.ss.some((u) => !bad.has(u)));
    let pool = all.filter((g) => !this.used.has(g.base));
    if (!pool.length) { this.used.clear(); pool = all.length ? all : GAMES.slice(0, size); }
    const g = pool[Math.floor(Math.random() * pool.length)];
    this.used.add(g.base);
    const shots = g.ss.filter((u) => !bad.has(u));
    const list = shots.length ? shots : g.ss;
    const img = list[Math.floor(Math.random() * list.length)];
    const mode = this.settings.mode === "mix" ? IMAGE_MODES[Math.floor(Math.random() * IMAGE_MODES.length)] : this.settings.mode;
    const focus = { x: +(0.3 + Math.random() * 0.4).toFixed(3), y: +(0.3 + Math.random() * 0.4).toFixed(3) };
    return { gameId: g.id, img, mode, focus };
  },

  startGame() {
    if (!GAMES.length) return;
    for (const [id, p] of this.players) if (!p.online) this.players.delete(id);
    for (const p of this.players.values()) Object.assign(p, { score: 0, gain: 0, correct: 0, streak: 0, bestStreak: 0, fastest: null });
    this.round = 0; this.used.clear(); this.winner = null; this.reveal = null; this.stats = null;
    this.next = this.pick();
    this.phase = "countdown";
    this.phaseEndsAt = Date.now() + COUNTDOWN_MS;
    this.addFeed({ k: "sys", tone: "info", text: "¡Empieza la partida!" });
    this.broadcast();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.startRound(), COUNTDOWN_MS);
  },

  startRound() {
    this.current = this.next || this.pick();
    this.next = null;
    this.round++;
    this.correct = 0;
    this.skips.clear();
    for (const p of this.players.values()) { p.tries = TRIES; p.done = !p.online; p.gain = 0; }
    this.phase = "round";
    this.startedAt = Date.now();
    this.phaseEndsAt = this.startedAt + this.settings.time * 1000;
    this.broadcast();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.endRound(false), this.settings.time * 1000 + 150);
  },

  guess(p, gameId) {
    if (this.phase !== "round" || p.done || p.tries <= 0 || !BY_ID.has(gameId)) return;
    const g = BY_ID.get(gameId);
    const answer = BY_ID.get(this.current.gameId);
    if (gameId === answer.id || g.base === answer.base) {
      const total = this.settings.time * 1000;
      const ms = Date.now() - this.startedAt;
      const left = Math.max(0, total - ms);
      const bonus = this.correct === 0 ? 3 : this.correct === 1 ? 1 : 0;
      const pts = 1 + Math.round(9 * left / total) + bonus;
      this.correct++;
      p.score += pts; p.gain = pts; p.done = true;
      p.correct++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak);
      if (!p.fastest || ms < p.fastest.ms) p.fastest = { ms, game: answer.name };
      this.send(p, { t: "feedback", ok: true, pts, first: this.correct === 1 });
      this.addFeed({ k: "sys", tone: "ok", from: p.id, text: `ha acertado (+${pts})${p.streak >= 3 ? ` · racha de ${p.streak} 🔥` : ""}` });
    } else {
      p.tries--;
      if (p.tries <= 0) p.done = true;
      this.send(p, { t: "feedback", ok: false, name: g.name, tries: p.tries });
    }
    this.broadcast();
    this.checkRoundDone();
  },

  skip(p) {
    if (this.phase !== "round" || this.skips.has(p.id)) return;
    this.skips.add(p.id);
    const online = [...this.players.values()].filter((x) => x.online).length;
    if (this.skips.size >= Math.ceil(online / 2)) {
      BadShots.add(this.current.img);
      this.addFeed({ k: "sys", tone: "info", text: "Captura saltada por votación" });
      this.endRound(true);
    } else this.broadcast();
  },

  checkRoundDone() {
    if (this.phase !== "round") return;
    const active = [...this.players.values()].filter((p) => p.online);
    if (active.length && active.every((p) => p.done)) this.endRound(false);
  },

  endRound(skipped) {
    if (this.phase !== "round") return;
    clearTimeout(this.timer);
    const g = BY_ID.get(this.current.gameId);
    for (const p of this.players.values()) if (p.online && !p.gain) p.streak = 0;
    const winners = [...this.players.values()].filter((p) => p.gain > 0).sort((a, b) => b.gain - a.gain).map((p) => ({ id: p.id, pts: p.gain }));
    this.reveal = { gameId: g.id, name: g.name, year: g.year, img: this.current.img, skipped, winners };
    const ranked = [...this.players.values()].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const isOver = top && top.score >= this.settings.target && (!ranked[1] || ranked[1].score < top.score);
    if (!isOver) this.next = this.pick();
    this.phase = "reveal";
    this.phaseEndsAt = Date.now() + REVEAL_MS;
    this.broadcast();
    this.timer = setTimeout(() => {
      if (isOver) {
        this.winner = top.id;
        this.stats = this.computeStats();
        this.phase = "final";
        this.addFeed({ k: "sys", tone: "ok", from: top.id, text: "gana la partida 🏆" });
        this.broadcast();
      } else this.startRound();
    }, REVEAL_MS);
  },

  computeStats() {
    const ps = [...this.players.values()];
    const fast = ps.filter((p) => p.fastest).sort((a, b) => a.fastest.ms - b.fastest.ms)[0];
    const streak = [...ps].sort((a, b) => b.bestStreak - a.bestStreak)[0];
    const most = [...ps].sort((a, b) => b.correct - a.correct)[0];
    return {
      fastest: fast ? { id: fast.id, ms: fast.fastest.ms, game: fast.fastest.game } : null,
      streak: streak && streak.bestStreak >= 2 ? { id: streak.id, n: streak.bestStreak } : null,
      most: most && most.correct > 0 ? { id: most.id, n: most.correct } : null,
      rounds: this.round,
    };
  },

  publicState() {
    const now = Date.now();
    const cur = this.current;
    return {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      round: this.round,
      img: this.phase === "round" ? cur.img : this.phase === "reveal" ? this.reveal.img : null,
      mode: this.phase === "round" ? cur.mode : "normal",
      focus: this.phase === "round" ? cur.focus : null,
      preload: this.next ? this.next.img : null,
      remaining: Math.max(0, this.phaseEndsAt - now),
      skips: this.skips.size,
      reveal: this.phase === "reveal" ? this.reveal : null,
      winner: this.winner,
      stats: this.phase === "final" ? this.stats : null,
      host: myId,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, avatar: p.avatar, score: p.score, online: p.online,
        done: p.done && p.gain > 0, gain: p.gain, correct: p.correct, streak: p.streak,
      })),
    };
  },

  broadcast() {
    const s = this.publicState();
    this.sendAll({ t: "state", s });
  },
};
