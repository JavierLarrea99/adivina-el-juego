"use strict";
/* =========================================================
   Cliente: conexión, pantallas, chat, sonidos y todo lo que ve cada jugador
   ========================================================= */
const $ = (id) => document.getElementById(id);
const PREFIX = "adivina-juego-v1-";
const MODE_NAMES = { normal: "Normal", pixel: "Pixelada", zoom: "Zoom", mix: "Sorpresa" };
const MODE_HELP = {
  normal: "La captura se ve entera desde el principio.",
  pixel: "La captura empieza muy pixelada y se va aclarando. Acertar pronto vale más.",
  zoom: "Empieza con mucho zoom en un trozo y se va alejando.",
  mix: "Cada ronda toca un modo al azar: normal, pixelada o zoom.",
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
function token() {
  let t = store.get("adivina-token");
  if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("adivina-token", t); }
  return t;
}
function makeCode() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sin I ni O para no confundir
  let c = ""; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
  return c;
}
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function setNet(t, warn) { $("netStatus").textContent = t; $("netStatus").classList.toggle("warn", !!warn); }

/* ---------- pantallas ---------- */
const VIEWS = ["vHome", "vLobby", "vGame", "vFinal", "vError"];
let currentView = "vHome";
function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
  currentView = view;
  // el chat se mueve al hueco de la pantalla actual, sin perder lo escrito
  const slot = document.querySelector(`#${view} .chat-slot`);
  const chat = $("chat");
  if (slot && myId) { if (chat.parentElement !== slot) slot.appendChild(chat); chat.hidden = false; scrollFeed(true); }
  else chat.hidden = true;
}

/* ---------- mi avatar ---------- */
let myAvatar = (() => {
  try { const a = JSON.parse(store.get("adivina-avatar")); if (a) return validAvatar(a); } catch {}
  const a = randomAvatar(); store.set("adivina-avatar", JSON.stringify(a)); return a;
})();
function setMyAvatar(a) {
  myAvatar = validAvatar(a);
  store.set("adivina-avatar", JSON.stringify(myAvatar));
  renderAvatarPicker();
  if (myId) sendToHost({ t: "avatar", avatar: myAvatar });
}
function renderAvatarPicker() {
  $("avaPreview").innerHTML = avatarHTML(myAvatar, 84, "big");
  $("swatches").innerHTML = AVATAR_COLORS.map((c) => `<button type="button" style="background:${c}" data-c="${c}" aria-label="Color ${c}" aria-pressed="${c === myAvatar.color}"></button>`).join("");
}

/* =========================================================
   Red: el anfitrión hace de servidor desde su pestaña
   ========================================================= */
let peer = null;
let hostConn = null;   // cliente -> anfitrión
let isHost = false;
let myId = null;       // id de jugador
let myName = "";
let code = null;
let S = null;          // último estado recibido
let manualLeave = false;
let reconnecting = false;
let reconnectTries = 0;

function sendToHost(msg) {
  if (isHost) Host.handle(myId, msg);
  else if (hostConn && hostConn.open) hostConn.send(msg);
}

const BLOCKED_TIPS = "Suele ser un bloqueador de anuncios, el escudo del navegador (Brave, Opera), una extensión que bloquea WebRTC o el antivirus. Desactívalo para esta página, o prueba con otro navegador o con otra red (WiFi o datos).";

// Comprueba que el navegador deja hacer conexiones entre jugadores
function netReady() {
  if (typeof Peer === "undefined") {
    fail("No se ha podido cargar la conexión", "Algo ha bloqueado una parte de la página. " + BLOCKED_TIPS);
    return false;
  }
  if (typeof RTCPeerConnection === "undefined") {
    fail("Tu navegador bloquea las partidas", "Este navegador tiene desactivadas las conexiones entre jugadores (WebRTC). " + BLOCKED_TIPS);
    return false;
  }
  return true;
}
function makePeer(id) {
  try { return id ? new Peer(id) : new Peer(); }
  catch (e) { fail("No se ha podido conectar", "Error al iniciar la conexión. " + BLOCKED_TIPS); return null; }
}

function startAsHost(name, attempt = 0) {
  if (!netReady()) return;
  isHost = true;
  myName = name;
  code = makeCode();
  setNet("Creando sala…");
  peer = makePeer(PREFIX + code.toLowerCase());
  if (!peer) return;
  const openTimer = setTimeout(() => fail("No se ha podido crear la sala", "No llegamos al servidor que une a los jugadores. " + BLOCKED_TIPS), 15000);
  peer.on("open", () => {
    clearTimeout(openTimer);
    setNet("");
    Host.init(code);
    myId = Host.addLocal(name, token(), myAvatar);
    history.replaceState(null, "", "?sala=" + code);
    FEED = [];
    Host.addFeed({ k: "sys", tone: "info", text: `Sala ${code} creada. Pasa el enlace a tus amigos.` });
    Host.broadcast();
    keepAwake(true);
  });
  peer.on("connection", (conn) => Host.accept(conn));
  peer.on("error", (err) => {
    clearTimeout(openTimer);
    if (err.type === "unavailable-id" && attempt < 5) { peer.destroy(); startAsHost(name, attempt + 1); return; }
    if (err.type === "peer-unavailable") return; // un jugador que se fue
    if (S) { setNet("Problema de conexión con el servidor, reintentando…", true); return; }
    fail("No se ha podido crear la sala", netErrorText(err));
  });
  peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
}

function joinAsClient(name, roomCode) {
  if (!netReady()) return;
  isHost = false;
  myName = name;
  code = roomCode;
  setNet("Conectando…");
  if (peer) { try { peer.destroy(); } catch {} }
  peer = makePeer();
  if (!peer) return;
  const openTimer = setTimeout(() => fail("No se ha podido conectar", "No llegamos al servidor que une a los jugadores. " + BLOCKED_TIPS), 15000);
  peer.on("open", () => { clearTimeout(openTimer); setNet("Conectando con el anfitrión…"); connectToHost(); });
  peer.on("error", (err) => {
    clearTimeout(openTimer);
    if (S) { lostConnection(); return; }
    if (err.type === "peer-unavailable") fail("No se encuentra la sala", `No hay ninguna partida abierta con el código ${code}. Comprueba el código o pide un enlace nuevo.`);
    else fail("Problema de conexión", netErrorText(err));
  });
  peer.on("disconnected", () => { if (!peer.destroyed) { try { peer.reconnect(); } catch {} } });
}

function connectToHost() {
  const conn = peer.connect(PREFIX + code.toLowerCase(), { reliable: true });
  hostConn = conn;
  const firstTimer = S ? null : setTimeout(() => {
    if (!S && conn === hostConn) fail("No se puede conectar con el anfitrión", `La sala ${code} existe, pero tu navegador no consigue conectar con el del anfitrión. ` + BLOCKED_TIPS + " Si nada funciona, que cree la partida otra persona.");
  }, 15000);
  conn.on("open", () => { if (conn === hostConn) conn.send({ t: "hello", name: myName, token: token(), avatar: myAvatar }); });
  conn.on("data", (msg) => {
    if (conn !== hostConn) return;
    clearTimeout(firstTimer);
    if (!reconnecting && $("netStatus").textContent) setNet("");
    if (reconnecting) { reconnecting = false; reconnectTries = 0; setNet(""); toast("Reconectado"); }
    onMessage(msg);
  });
  conn.on("close", () => { if (conn === hostConn && !manualLeave) lostConnection(); });
  conn.on("error", () => {});
}

// Si se corta (pantalla bloqueada, cambio de red...), se intenta volver a entrar solo
function lostConnection() {
  if (manualLeave) return;
  if (!S) { fail("Se ha perdido la conexión", "El anfitrión ha cerrado la partida o se ha caído la conexión."); return; }
  if (reconnectTries >= 6) {
    reconnecting = false;
    fail("Se ha perdido la conexión", "No hemos podido volver a conectar con el anfitrión. Puede que haya cerrado la partida.");
    return;
  }
  if (reconnecting && hostConn && !hostConn.open && reconnectTries > 0 && Date.now() - (lostConnection.last || 0) < 2000) return;
  lostConnection.last = Date.now();
  reconnecting = true;
  reconnectTries++;
  setNet(`Reconectando… (${reconnectTries}/6)`, true);
  setTimeout(() => {
    if (manualLeave || !reconnecting) return;
    if (peer && !peer.destroyed && peer.open) connectToHost();
    else {
      try { peer && peer.destroy(); } catch {}
      peer = makePeer();
      if (!peer) return;
      peer.on("open", connectToHost);
      peer.on("error", () => { if (reconnecting) lostConnection(); });
    }
    setTimeout(() => { if (reconnecting && !(hostConn && hostConn.open)) lostConnection(); }, 9000);
  }, 1200 + reconnectTries * 600);
}

function netErrorText(err) {
  if (err.type === "network" || err.type === "server-error" || err.type === "socket-error")
    return "No se puede conectar con el servidor que une a los jugadores. Revisa tu conexión a internet y vuelve a intentarlo.";
  if (err.type === "browser-incompatible") return "Este navegador no permite conexiones entre jugadores. Prueba con Chrome, Firefox o Safari actualizados.";
  return "Error: " + (err.type || err.message || err);
}

function fail(title, text) {
  if (manualLeave) return;
  $("errTitle").textContent = title;
  $("errText").textContent = text;
  setNet("");
  show("vError");
  stopTick();
}

/* ---------- pantalla siempre encendida durante la partida ---------- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (myId) keepAwake(true);
  if (!isHost && S && !reconnecting && !(hostConn && hostConn.open)) lostConnection();
});

/* =========================================================
   Mensajes que llegan del anfitrión
   ========================================================= */
let myTries = TRIES;
let myDone = false;
let lastRound = -1;
let localEnd = 0;
let roundStartLocal = 0;
let prevPhase = null;
const preloaded = new Set();

function onMessage(msg) {
  switch (msg.t) {
    case "welcome":
      myId = msg.you;
      FEED = Array.isArray(msg.feed) ? msg.feed.slice(-80) : [];
      renderFeedAll();
      keepAwake(true);
      return;
    case "full": return fail("La sala está llena", `Esta partida ya tiene el máximo de ${MAX_PLAYERS} jugadores.`);
    case "state": return render(msg.s);
    case "feed": return addFeedItem(msg.item);
    case "react": return showReaction(msg.from, msg.e);
    case "feedback": return feedback(msg);
  }
}

function feedback(msg) {
  if (msg.ok) {
    myDone = true;
    Sound.play("correct");
    flashScreen("good");
    renderTries(`<span class="feedback ok">¡Correcto! +${msg.pts} puntos${msg.first ? " · ¡el primero!" : ""}</span>`);
    lockGuess(true);
  } else {
    myTries = msg.tries;
    Sound.play("wrong");
    flashScreen("badflash");
    const inp = $("guessInput");
    inp.classList.remove("shake"); void inp.offsetWidth; inp.classList.add("shake");
    if (myTries <= 0) { myDone = true; lockGuess(true); renderTries(`<span class="feedback bad">No es ${esc(msg.name)}. Sin intentos.</span>`); }
    else renderTries(`<span class="feedback bad">No es ${esc(msg.name)}</span>`);
    inp.value = "";
    if (myTries > 0) inp.focus();
  }
}
function flashScreen(cls) {
  const sc = $("screen");
  sc.classList.add(cls);
  setTimeout(() => sc.classList.remove(cls), 900);
}

/* ---------- jugadores ---------- */
function renderPlayers(el, s, opts = {}) {
  const list = [...s.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  el.innerHTML = "";
  for (const p of list) {
    const li = document.createElement("li");
    if (!p.online) li.classList.add("off");
    if (opts.round && p.done) li.classList.add("done");
    const me = p.id === myId;
    const tags = (me ? " <small>(tú)</small>" : "") + (p.id === s.host ? " <small>anfitrión</small>" : "");
    const streak = !opts.lobby && p.streak >= 2 ? `<span class="streak" title="Aciertos seguidos">🔥${p.streak}</span>` : "";
    const gain = opts.round && p.gain ? `<span class="gain">+${p.gain}</span>` : "";
    const right = opts.lobby
      ? (me ? `<button class="reroll" data-reroll title="Cambiar de monstruo">🎲 Cambiar</button>` : "")
      : `${gain}${p.score}`;
    li.innerHTML = `${avatarHTML(p.avatar, opts.lobby ? 36 : 32)}<span class="pname">${esc(p.name)}${tags}${streak}</span><span class="pscore">${right}</span>` +
      (opts.lobby ? "" : `<span class="meter"><i style="width:${Math.min(100, (p.score / s.settings.target) * 100)}%;background:${validAvatar(p.avatar).color}"></i></span>`);
    el.appendChild(li);
  }
}

function preload(url) {
  if (!url || preloaded.has(url)) return;
  preloaded.add(url);
  const i = new Image(); i.referrerPolicy = "no-referrer"; i.src = url;
}

function playerById(id) { return S && S.players.find((p) => p.id === id); }

/* ---------- pintar el estado ---------- */
function render(s) {
  const phaseChanged = s.phase !== prevPhase;
  S = s;
  $("topCode").hidden = false;
  $("topCode").textContent = s.code;
  preload(s.preload);
  localEnd = performance.now() + s.remaining;

  if (s.phase === "lobby") {
    show("vLobby");
    const link = location.origin + location.pathname + "?sala=" + s.code;
    $("bigCode").textContent = s.code;
    $("inviteLink").textContent = link;
    $("waBtn").href = "https://wa.me/?text=" + encodeURIComponent(`¿Echamos una de Adivina el Juego? Entra aquí: ${link}`);
    for (const seg of document.querySelectorAll(".seg")) {
      const key = seg.dataset.key;
      for (const b of seg.querySelectorAll("button")) {
        b.setAttribute("aria-pressed", String(b.dataset.v === String(s.settings[key])));
        b.disabled = !isHost;
      }
    }
    $("modeHelp").textContent = MODE_HELP[s.settings.mode] || "";
    $("startBtn").hidden = !isHost;
    $("waitHost").hidden = isHost;
    $("pCount").textContent = `(${s.players.length})`;
    renderPlayers($("lobbyPlayers"), s, { lobby: true });
  } else if (s.phase === "final") {
    show("vFinal");
    stopTick();
    renderFinal(s, phaseChanged);
  } else {
    show("vGame");
    $("targetLbl").textContent = s.settings.target;
    renderPlayers($("gamePlayers"), s, { round: s.phase === "round" || s.phase === "reveal" });
    renderStage(s, phaseChanged);
    startTick();
  }
  if (phaseChanged && s.phase === "countdown") Sound.play("start");
  prevPhase = s.phase;
}

/* ---------- la captura: modos normal, pixelada y zoom ---------- */
const pix = { small: document.createElement("canvas"), lastW: 0, active: false };

function setupImage(s) {
  const shot = $("shot"), cv = $("shotCanvas");
  pix.active = s.mode === "pixel";
  pix.lastW = 0;
  cv.hidden = !pix.active;
  shot.style.visibility = pix.active ? "hidden" : "visible";
  shot.style.transition = "none";
  if (s.mode === "zoom" && s.focus) {
    shot.style.transformOrigin = `${s.focus.x * 100}% ${s.focus.y * 100}%`;
    shot.style.transform = "scale(3.4)";
  } else {
    shot.style.transformOrigin = "50% 50%";
    shot.style.transform = "scale(1)";
  }
  if (pix.active) { const c = cv.getContext("2d"); c.clearRect(0, 0, cv.width, cv.height); }
  const startAnim = () => {
    void shot.offsetWidth;
    const left = Math.max(1000, localEnd - performance.now());
    if (s.mode === "zoom") {
      shot.style.transition = `transform ${Math.round(left * 0.85)}ms cubic-bezier(.35,0,.45,1)`;
      shot.style.transform = "scale(1)";
    } else if (s.mode === "normal") {
      shot.style.transition = "transform 8s ease-out";
      shot.style.transform = "scale(1.04)";
    }
  };
  shot.onload = startAnim;
  shot.onerror = () => {
    const ov = $("overlay");
    ov.hidden = false;
    ov.innerHTML = `<div class="muted">Esta captura no carga. Pulsa “Saltar”.</div>`;
  };
  shot.src = s.img;
  if (shot.complete && shot.naturalWidth) startAnim();
}

function drawPixel(progress) {
  const img = $("shot"), cv = $("shotCanvas");
  if (!pix.active || !img.complete || !img.naturalWidth) return;
  const rect = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(2, Math.round(rect.width * dpr)), H = Math.max(2, Math.round(rect.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; pix.lastW = 0; }
  const p = Math.min(1, Math.max(0, progress / 0.8));
  const w = Math.min(W, Math.max(8, Math.round(10 * Math.pow(W / 10, p))));
  if (w === pix.lastW) return;
  pix.lastW = w;
  const h = Math.max(1, Math.round((w * H) / W));
  const sm = pix.small; sm.width = w; sm.height = h;
  const sctx = sm.getContext("2d");
  // recorte tipo "cover", como la imagen normal
  const iw = img.naturalWidth, ih = img.naturalHeight, ir = iw / ih, cr = W / H;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (ir > cr) { sw = ih * cr; sx = (iw - sw) / 2; } else { sh = iw / cr; sy = (ih - sh) / 2; }
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  const c = cv.getContext("2d");
  c.imageSmoothingEnabled = false;
  c.drawImage(sm, 0, 0, w, h, 0, 0, W, H);
}

function renderStage(s, phaseChanged) {
  const ov = $("overlay");
  const shot = $("shot");
  const modeTxt = s.phase === "round" && s.mode !== "normal" ? `<small>${MODE_NAMES[s.mode]}</small>` : "";
  $("roundLabel").innerHTML = s.phase === "countdown" ? "Preparados" : `Ronda ${s.round}${modeTxt}`;
  if (s.phase === "countdown") {
    shot.removeAttribute("src");
    $("shotCanvas").hidden = true;
    pix.active = false;
    lastRound = 0;
    ov.hidden = false;
    ov.innerHTML = `<div><div class="countnum" id="countNum">3</div><div class="count-mode">Modo: ${MODE_NAMES[s.settings.mode]}. ${esc(MODE_HELP[s.settings.mode])}</div></div>`;
    lockGuess(true);
    renderTries("");
  } else if (s.phase === "round") {
    if (s.round !== lastRound) {
      lastRound = s.round;
      roundStartLocal = performance.now() - (s.settings.time * 1000 - s.remaining);
      myTries = TRIES; myDone = false;
      $("guessInput").value = "";
      closeSuggest();
      setupImage(s);
      lockGuess(false);
      renderTries("");
      Sound.play("go");
      if (matchMedia("(hover: hover)").matches) $("guessInput").focus();
    }
    ov.hidden = true;
    $("skipBtn").disabled = false;
    $("skipInfo").textContent = s.skips ? `${s.skips} ${s.skips === 1 ? "quiere" : "quieren"} saltar esta captura` : "¿La captura es un menú o no se ve nada?";
  } else if (s.phase === "reveal") {
    const r = s.reveal;
    pix.active = false;
    $("shotCanvas").hidden = true;
    shot.style.visibility = "visible";
    shot.style.transition = "transform .6s ease";
    shot.style.transform = "scale(1)";
    if (shot.getAttribute("src") !== r.img) shot.src = r.img;
    ov.hidden = false;
    const who = r.winners.map((w) => {
      const p = playerById(w.id);
      return p ? `<span>${avatarHTML(p.avatar, 22)}${esc(p.name)} <b>+${w.pts}</b></span>` : "";
    }).join("");
    ov.innerHTML = `<div class="reveal-card"><div class="eyebrow">${r.skipped ? "Saltada · era" : "Era"}</div><h2>${esc(r.name)}</h2>${meta(r) ? `<div class="year">${meta(r)}</div>` : ""}<div class="who">${who || `<span class="none">Nadie lo ha adivinado</span>`}</div></div>`;
    lockGuess(true);
    closeSuggest();
    $("skipBtn").disabled = true;
    if (phaseChanged) Sound.play(r.winners.length ? "reveal" : "timeup");
  }
}

function renderTries(extra) {
  let dots = "";
  if (S && S.phase === "round" && !myDone) for (let i = 0; i < TRIES; i++) dots += `<i class="${i < myTries ? "" : "used"}"></i>`;
  $("tries").innerHTML = (dots ? dots + `<span>${myTries} ${myTries === 1 ? "intento" : "intentos"}</span>` : "") + (extra ? " " + extra : "");
}
function lockGuess(locked) {
  $("guessInput").disabled = locked;
  $("guessBtn").disabled = locked;
  if (locked) closeSuggest();
}

/* ---------- reloj ---------- */
let raf = null;
let lastCount = null, lastTick = null;
function startTick() { if (!raf) raf = requestAnimationFrame(tick); }
function stopTick() { if (raf) cancelAnimationFrame(raf); raf = null; }
function tick() {
  raf = requestAnimationFrame(tick);
  if (!S) return;
  const left = Math.max(0, localEnd - performance.now());
  if (S.phase === "round") {
    const total = S.settings.time * 1000;
    const secs = Math.ceil(left / 1000);
    $("clock").textContent = secs;
    $("clock").classList.toggle("hurry", secs <= 5);
    $("timebar").style.transform = `scaleX(${left / total})`;
    if (secs <= 5 && secs > 0 && secs !== lastTick && !myDone) Sound.play("tick", secs);
    lastTick = secs;
    if (pix.active) drawPixel(1 - left / total);
  } else if (S.phase === "countdown") {
    const n = Math.max(1, Math.ceil(left / 1000));
    const el = $("countNum"); if (el) el.textContent = n;
    if (n !== lastCount) Sound.play("count");
    lastCount = n;
    $("clock").textContent = S.settings.time;
    $("clock").classList.remove("hurry");
    $("timebar").style.transform = "scaleX(1)";
  } else if (S.phase === "reveal") {
    lastCount = null;
    $("clock").textContent = "—";
    $("clock").classList.remove("hurry");
    $("timebar").style.transform = "scaleX(0)";
  }
}

/* ---------- final: podio, estadísticas y confeti ---------- */
function renderFinal(s, phaseChanged) {
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const w = playerById(s.winner);
  const iWon = w && w.id === myId;
  $("winnerLbl").innerHTML = w ? `${iWon ? "¡Has ganado!" : "Gana"} <span>${esc(w.name)}</span>` : "Fin";
  $("finalEyebrow").textContent = `Fin de la partida · ${s.stats ? s.stats.rounds : s.round} rondas`;
  const sizes = [92, 70, 60];
  $("podium").innerHTML = ranked.slice(0, 3).map((p, i) =>
    `<div class="pl p${i + 1}">${avatarHTML(p.avatar, sizes[i], "big")}<div class="nm">${esc(p.name)}</div><div class="sc">${p.score} pts</div><div class="step">${i + 1}</div></div>`).join("");
  const st = s.stats || {};
  const card = (title, id, val) => {
    const p = playerById(id);
    return p ? `<div class="panel stat"><div class="eyebrow">${title}</div><div class="who">${avatarHTML(p.avatar, 28)}<span>${esc(p.name)}</span></div><div class="val">${val}</div></div>` : "";
  };
  $("stats").innerHTML =
    (st.fastest ? card("Respuesta más rápida", st.fastest.id, `${(st.fastest.ms / 1000).toFixed(1).replace(".", ",")} s <small>· ${esc(st.fastest.game)}</small>`) : "") +
    (st.streak ? card("Mejor racha", st.streak.id, `${st.streak.n} seguidas`) : "") +
    (st.most ? card("Más aciertos", st.most.id, `${st.most.n} <small>de ${st.rounds} rondas</small>`) : "");
  renderPlayers($("finalPlayers"), s);
  $("againBtn").hidden = !isHost;
  $("againWait").hidden = isHost;
  if (phaseChanged) { Sound.play(iWon ? "win" : "lose"); confetti(); }
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("confetti");
  cv.hidden = false;
  const c = cv.getContext("2d");
  const W = (cv.width = innerWidth), H = (cv.height = innerHeight);
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
    s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    col: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
  }));
  const t0 = performance.now();
  (function frame(now) {
    c.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.r += p.vr;
      c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.col; c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); c.restore();
    }
    if (now - t0 < 4500) requestAnimationFrame(frame);
    else { c.clearRect(0, 0, W, H); cv.hidden = true; }
  })(t0);
}

/* =========================================================
   Chat y reacciones
   ========================================================= */
let FEED = [];
function feedNode(it) {
  const div = document.createElement("div");
  const av = it.avatar ? avatarHTML(it.avatar, it.k === "msg" ? 24 : 18) : "";
  const name = it.name ? `<b>${esc(it.name)}</b> ` : "";
  if (it.k === "msg") {
    div.className = "fi msg" + (it.from === myId ? " me" : "");
    div.innerHTML = `${av}<span class="fi-body"><b style="color:${validAvatar(it.avatar).color}">${esc(it.name || "?")}</b><span class="fi-text"></span></span>`;
    div.querySelector(".fi-text").textContent = it.text;
  } else {
    div.className = "fi sys " + (it.tone || "");
    div.innerHTML = `${av}<span class="fi-body">${name}<span class="fi-text"></span></span>`;
    div.querySelector(".fi-text").textContent = it.text;
  }
  return div;
}
function scrollFeed(force) {
  const f = $("feed");
  if (force || f.scrollHeight - f.scrollTop - f.clientHeight < 80) f.scrollTop = f.scrollHeight;
}
function renderFeedAll() {
  const f = $("feed");
  f.innerHTML = "";
  for (const it of FEED) f.appendChild(feedNode(it));
  scrollFeed(true);
}
function addFeedItem(it) {
  if (!it || typeof it !== "object") return;
  FEED.push(it);
  if (FEED.length > 120) FEED.shift();
  const f = $("feed");
  f.appendChild(feedNode(it));
  while (f.children.length > 120) f.firstChild.remove();
  scrollFeed(it.from === myId);
  const mine = it.from === myId;
  if (it.k === "msg" && !mine) Sound.play("chat");
  else if (it.tone === "ok" && !mine && S && S.phase === "round") Sound.play("other");
  else if (it.tone === "join" && !mine) Sound.play("join");
  else if (it.tone === "leave" && !mine) Sound.play("leave");
  else if (it.tone === "censor") Sound.play("censor");
}
function showReaction(from, e) {
  const emoji = REACTIONS[Number(e)];
  if (!emoji) return;
  const p = playerById(from);
  const el = document.createElement("div");
  el.className = "rx";
  el.style.left = Math.round(Math.random() * 70) + "px";
  el.innerHTML = (p ? avatarHTML(p.avatar, 26) : "") + `<span>${emoji}</span>`;
  $("reactLayer").appendChild(el);
  setTimeout(() => el.remove(), 2500);
  Sound.play("react");
}
$("reacts").innerHTML = REACTIONS.map((r, i) => `<button type="button" data-e="${i}" aria-label="Reaccionar ${r}">${r}</button>`).join("");
$("reacts").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-e]");
  if (b) sendToHost({ t: "react", e: Number(b.dataset.e) });
});
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("chatInput").value.trim();
  if (!v) return;
  sendToHost({ t: "chat", text: v });
  $("chatInput").value = "";
});

/* =========================================================
   Autocompletado
   ========================================================= */
let sugg = [];
let sel = 0;
function openSuggest(list) {
  sugg = list; sel = 0;
  const ul = $("suggest");
  if (!list.length) { closeSuggest(); return; }
  ul.innerHTML = list.map((g, i) => `<li role="option" id="opt${i}" data-i="${i}" aria-selected="${i === sel}"><span>${esc(g.name)}</span><small>${meta(g)}</small></li>`).join("");
  ul.hidden = false;
  $("guessInput").setAttribute("aria-expanded", "true");
  $("guessInput").setAttribute("aria-activedescendant", "opt0");
}
function closeSuggest() {
  $("suggest").hidden = true; sugg = [];
  $("guessInput").setAttribute("aria-expanded", "false");
  $("guessInput").removeAttribute("aria-activedescendant");
}
function moveSel(d) {
  if (!sugg.length) return;
  sel = (sel + d + sugg.length) % sugg.length;
  for (const li of $("suggest").children) li.setAttribute("aria-selected", String(Number(li.dataset.i) === sel));
  $("guessInput").setAttribute("aria-activedescendant", "opt" + sel);
  $("opt" + sel)?.scrollIntoView({ block: "nearest" });
}
function submitGuess(g) {
  if (!g || myDone || !S || S.phase !== "round") return;
  closeSuggest();
  $("guessInput").value = g.name;
  sendToHost({ t: "guess", gameId: g.id });
}
$("guessInput").addEventListener("input", (e) => openSuggest(search(e.target.value)));
$("guessInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
  else if (e.key === "Enter") { e.preventDefault(); submitGuess(sugg[sel] || search(e.target.value, 1)[0]); }
  else if (e.key === "Escape") closeSuggest();
});
$("suggest").addEventListener("pointerdown", (e) => {
  const li = e.target.closest("li"); if (!li) return;
  e.preventDefault();
  submitGuess(sugg[Number(li.dataset.i)]);
});
$("guessBtn").addEventListener("click", () => {
  const v = $("guessInput").value;
  const g = sugg[sel] || search(v, 1)[0];
  if (!g) { renderTries(`<span class="feedback bad">Elige un juego de la lista</span>`); return; }
  submitGuess(g);
});
document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#guessBox")) closeSuggest(); });

/* =========================================================
   Sonido: panel y botones
   ========================================================= */
function renderSoundPanel() {
  const p = Sound.prefs;
  $("sfxOn").checked = p.sfx; $("musicOn").checked = p.music;
  $("sfxVol").value = p.sfxVol; $("musicVol").value = p.musicVol;
  $("sfxVol").disabled = !p.sfx; $("musicVol").disabled = !p.music;
  $("soundBtn").setAttribute("aria-pressed", String(p.sfx || p.music));
  $("waves").style.display = p.sfx || p.music ? "" : "none";
}
$("soundBtn").addEventListener("click", () => {
  const open = $("soundPanel").hidden;
  $("soundPanel").hidden = !open;
  $("soundBtn").setAttribute("aria-expanded", String(open));
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".sound-ctl")) { $("soundPanel").hidden = true; $("soundBtn").setAttribute("aria-expanded", "false"); }
});
$("sfxOn").addEventListener("change", (e) => { Sound.set("sfx", e.target.checked); renderSoundPanel(); Sound.play("click"); });
$("musicOn").addEventListener("change", (e) => { Sound.set("music", e.target.checked); renderSoundPanel(); });
$("sfxVol").addEventListener("input", (e) => Sound.set("sfxVol", Number(e.target.value)));
$("sfxVol").addEventListener("change", () => Sound.play("click"));
$("musicVol").addEventListener("input", (e) => Sound.set("musicVol", Number(e.target.value)));
// el navegador solo deja sonar audio después de que el jugador toque algo
const unlockOnce = () => Sound.unlock();
document.addEventListener("pointerdown", unlockOnce);
document.addEventListener("keydown", unlockOnce);
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".btn, .seg button, .reroll, .swatches button, .ava-btn")) Sound.play("click");
});

/* =========================================================
   Botones
   ========================================================= */
function getName() {
  const n = $("nameInput").value.trim();
  if (!n) { $("homeErr").textContent = "Pon un apodo para que tus amigos sepan quién eres."; $("nameInput").focus(); return null; }
  store.set("adivina-name", n);
  return n;
}
$("createBtn").addEventListener("click", () => {
  const n = getName(); if (!n) return;
  $("homeErr").textContent = "";
  startAsHost(n);
});
function join() {
  const n = getName(); if (!n) return;
  const c = $("codeInput").value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(c)) { $("homeErr").textContent = "El código tiene 4 letras."; $("codeInput").focus(); return; }
  $("homeErr").textContent = "";
  history.replaceState(null, "", "?sala=" + c);
  joinAsClient(n, c);
}
$("joinBtn").addEventListener("click", join);
$("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") ($("codeInput").value ? join() : $("createBtn").click()); });
$("avaPreview").addEventListener("click", () => setMyAvatar({ seed: randomAvatar().seed, color: myAvatar.color }));
$("swatches").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-c]");
  if (b) setMyAvatar({ seed: myAvatar.seed, color: b.dataset.c });
});
$("lobbyPlayers").addEventListener("click", (e) => {
  if (e.target.closest("[data-reroll]")) {
    const a = randomAvatar();
    setMyAvatar({ seed: a.seed, color: Math.random() < 0.5 ? a.color : myAvatar.color });
  }
});

for (const seg of document.querySelectorAll(".seg")) {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !isHost) return;
    const key = seg.dataset.key;
    const v = key === "mode" ? b.dataset.v : Number(b.dataset.v);
    sendToHost({ t: "settings", settings: { [key]: v } });
  });
}
$("startBtn").addEventListener("click", () => sendToHost({ t: "start" }));
$("againBtn").addEventListener("click", () => sendToHost({ t: "lobby" }));
$("skipBtn").addEventListener("click", () => { sendToHost({ t: "skip" }); $("skipBtn").disabled = true; Sound.play("skip"); });
$("copyBtn").addEventListener("click", async () => {
  const link = $("inviteLink").textContent;
  try { await navigator.clipboard.writeText(link); toast("Enlace copiado"); }
  catch { const r = document.createRange(); r.selectNodeContents($("inviteLink")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selecciona y copia el enlace"); }
});
$("retryBtn").addEventListener("click", () => {
  const c = code || new URLSearchParams(location.search).get("sala");
  const n = store.get("adivina-name") || "Jugador";
  S = null; lastRound = -1; reconnecting = false; reconnectTries = 0;
  if (isHost || !c) { location.href = location.pathname; return; }
  joinAsClient(n, c);
});
window.addEventListener("beforeunload", (e) => {
  if (isHost && S && S.phase !== "lobby" && S.phase !== "final") { e.preventDefault(); e.returnValue = ""; }
});

/* =========================================================
   Arranque
   ========================================================= */
(async function boot() {
  $("nameInput").value = store.get("adivina-name") || "";
  renderAvatarPicker();
  renderSoundPanel();
  $("parade").innerHTML = Array.from({ length: 7 }, () => avatarHTML(randomAvatar(), 44)).join("");
  const sala = (new URLSearchParams(location.search).get("sala") || "").toUpperCase();
  if (/^[A-Z]{4}$/.test(sala)) $("codeInput").value = sala;
  if (typeof Peer === "undefined") $("homeErr").textContent = "No se ha podido cargar la librería de conexión. Recarga la página.";
  const updated = await loadGames();
  $("dbDate").textContent = updated || "—";
  $("dbInfo").textContent = GAMES.length
    ? `${GAMES.length.toLocaleString("es-ES")} juegos de PC y consolas, desde la NES hasta hoy.`
    : "La lista de juegos todavía se está generando. Vuelve a cargar la página en unos minutos.";
  $("createBtn").disabled = !GAMES.length;
  $("joinBtn").disabled = !GAMES.length;
  const allBtn = document.querySelector('.seg[data-key="pool"] button[data-v="0"]');
  if (allBtn && GAMES.length) allBtn.textContent = `Todos (${GAMES.length.toLocaleString("es-ES")})`;
  if (sala && $("nameInput").value) $("joinBtn").focus();
  else if (sala) $("nameInput").focus();
})();
