"use strict";
/* =========================================================
   Sonido: efectos sintetizados y música chill generada en el navegador.
   No se descarga ningún archivo de audio: todo sale de osciladores y ruido (Web Audio).
   Cada jugador controla su volumen; se guarda en su navegador.
   ========================================================= */
const Sound = (() => {
  const KEY = "adivina-sonido";
  const prefs = { sfx: true, music: true, sfxVol: 0.8, musicVol: 0.45 };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}

  let ctx = null, master = null, sfxBus = null, musicBus = null, noiseBuf = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 18; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    master = ctx.createGain(); master.gain.value = 0.9;
    sfxBus = ctx.createGain();
    musicBus = ctx.createGain(); musicBus.gain.value = 0;
    sfxBus.connect(master); musicBus.connect(master); master.connect(comp); comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    applyVolumes(true);
    return ctx;
  }
  const ready = () => ctx && ctx.state === "running";

  function applyVolumes(instant) {
    if (!ctx) return;
    const t = ctx.currentTime;
    sfxBus.gain.setTargetAtTime(prefs.sfx ? prefs.sfxVol * 0.9 : 0, t, instant ? 0.001 : 0.05);
    if (Music.playing()) musicBus.gain.setTargetAtTime(prefs.music ? prefs.musicVol * 0.55 : 0, t, instant ? 0.001 : 0.3);
  }

  function save() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} }

  // ---------- piezas básicas ----------
  function tone(f, o = {}) {
    if (!ready()) return;
    const { t = 0, dur = 0.15, type = "sine", vol = 0.2, attack = 0.005, slideTo = null, filter = null, bus = sfxBus, detune = 0 } = o;
    const now = ctx.currentTime + t;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, now);
    if (detune) osc.detune.value = detune;
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    let node = osc;
    if (filter) {
      const fl = ctx.createBiquadFilter();
      fl.type = filter.type || "lowpass"; fl.frequency.value = filter.freq; fl.Q.value = filter.q || 0.7;
      osc.connect(fl); node = fl;
    }
    node.connect(g); g.connect(bus);
    osc.start(now); osc.stop(now + dur + 0.05);
  }
  function noise(o = {}) {
    if (!ready()) return;
    const { t = 0, dur = 0.1, vol = 0.1, type = "highpass", freq = 4000, q = 0.7, bus = sfxBus } = o;
    const now = ctx.currentTime + t;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = freq; fl.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(fl); fl.connect(g); g.connect(bus);
    src.start(now, Math.random() * 0.5); src.stop(now + dur + 0.02);
  }
  function bell(f, o = {}) {
    const { t = 0, vol = 0.08, dur = 0.9 } = o;
    tone(f, { t, dur, vol, attack: 0.003 });
    tone(f * 2.756, { t, dur: dur * 0.45, vol: vol * 0.35, attack: 0.002 });
  }
  function sparkle(t0) {
    for (let i = 0; i < 5; i++) tone(2200 + Math.random() * 2400, { t: t0 + i * 0.045, dur: 0.09, vol: 0.035 });
  }

  // ---------- efectos ----------
  const SFX = {
    click() { tone(760, { dur: 0.045, type: "triangle", vol: 0.07 }); },
    start() {
      tone(330, { dur: 0.32, type: "square", vol: 0.05, slideTo: 990, filter: { freq: 2400 } });
      noise({ dur: 0.3, vol: 0.04, type: "bandpass", freq: 2500, q: 0.6 });
    },
    join() {
      tone(523.25, { dur: 0.1, type: "square", vol: 0.045, filter: { freq: 2200 } });
      tone(783.99, { t: 0.09, dur: 0.16, type: "square", vol: 0.045, filter: { freq: 2200 } });
    },
    leave() {
      tone(659.25, { dur: 0.1, type: "square", vol: 0.04, filter: { freq: 1800 } });
      tone(440, { t: 0.09, dur: 0.18, type: "square", vol: 0.04, filter: { freq: 1500 } });
    },
    count() { tone(523.25, { dur: 0.13, type: "square", vol: 0.06, filter: { freq: 2000 } }); },
    go() {
      for (const f of [1046.5, 1318.5, 1568]) tone(f, { dur: 0.38, type: "square", vol: 0.035, filter: { freq: 3000 } });
      noise({ dur: 0.22, vol: 0.05, type: "highpass", freq: 5000 });
    },
    tick(left) {
      tone(950 + (5 - left) * 110, { dur: 0.05, type: "sine", vol: 0.11 });
      noise({ dur: 0.02, vol: 0.035, type: "bandpass", freq: 3200, q: 2 });
    },
    correct() {
      [784, 987.8, 1174.7, 1568].forEach((f, i) => tone(f, { t: i * 0.07, dur: 0.24, type: "triangle", vol: 0.12 }));
      sparkle(0.3);
    },
    other() { bell(1318.5, { vol: 0.07, dur: 0.7 }); },
    wrong() {
      tone(196, { dur: 0.24, type: "sawtooth", vol: 0.08, slideTo: 128, filter: { freq: 900 } });
      tone(98, { dur: 0.24, type: "square", vol: 0.045, filter: { freq: 500 } });
    },
    timeup() { [523.25, 415.3, 329.63].forEach((f, i) => tone(f, { t: i * 0.13, dur: 0.2, type: "triangle", vol: 0.1 })); },
    reveal() { [783.99, 987.77, 1174.66].forEach((f, i) => bell(f, { t: i * 0.06, vol: 0.06, dur: 1.2 })); },
    chat() { tone(880, { dur: 0.07, type: "sine", vol: 0.075, slideTo: 1320 }); },
    react() {
      tone(1200, { dur: 0.06, type: "sine", vol: 0.06, slideTo: 1800 });
      tone(1500, { t: 0.05, dur: 0.07, type: "sine", vol: 0.045, slideTo: 2200 });
    },
    skip() {
      tone(620, { dur: 0.06, type: "square", vol: 0.035, filter: { freq: 1500 } });
      tone(460, { t: 0.065, dur: 0.09, type: "square", vol: 0.035, filter: { freq: 1500 } });
    },
    censor() { tone(1000, { dur: 0.32, type: "sine", vol: 0.06 }); },
    win() {
      [392, 523.25, 659.25, 783.99].forEach((f, i) => tone(f, { t: i * 0.11, dur: 0.14, type: "square", vol: 0.05, filter: { freq: 2600 } }));
      for (const f of [523.25, 659.25, 783.99, 1046.5]) {
        tone(f, { t: 0.5, dur: 1.3, type: "triangle", vol: 0.06, attack: 0.02 });
        tone(f * 1.003, { t: 0.5, dur: 1.1, type: "square", vol: 0.018, attack: 0.02, filter: { freq: 2400 } });
      }
      noise({ t: 0.5, dur: 0.5, vol: 0.06, type: "highpass", freq: 6000 });
      sparkle(0.6); sparkle(0.95);
    },
    lose() {
      tone(392, { dur: 0.32, type: "triangle", vol: 0.09, slideTo: 370 });
      tone(370, { t: 0.34, dur: 0.32, type: "triangle", vol: 0.09, slideTo: 349 });
      tone(349, { t: 0.68, dur: 0.75, type: "triangle", vol: 0.09, slideTo: 300 });
    },
  };

  // ---------- música chill (lo-fi generado) ----------
  const Music = (() => {
    let on = false, timer = null, nextTime = 0, step = 0, bar = 0, prog = 0;
    let bus = null, drums = null, keys = null, vinyl = null, lfo = null;
    const BPM = 74;
    const STEP = 60 / BPM / 4; // semicorchea
    const Q = {
      maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
      dom9: [0, 4, 7, 10, 14], six9: [0, 4, 7, 9, 14],
    };
    // cuatro progresiones tranquilas, un acorde por compás
    const PROGS = [
      [[5, "maj7"], [4, "m7"], [2, "m9"], [0, "maj9"]],
      [[10, "m9"], [3, "dom9"], [8, "maj7"], [5, "m9"]],
      [[9, "m9"], [2, "m9"], [7, "dom9"], [0, "maj7"]],
      [[0, "m9"], [5, "m9"], [10, "six9"], [3, "maj7"]],
    ];
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const chance = (p) => Math.random() < p;

    function voicing(root, q) {
      const ns = Q[q].map((i) => { let n = 48 + root + i; while (n < 53) n += 12; while (n > 74) n -= 12; return n; });
      return [...new Set(ns)].sort((a, b) => a - b);
    }

    function build() {
      bus = ctx.createBiquadFilter(); bus.type = "lowpass"; bus.frequency.value = 3400; bus.Q.value = 0.4;
      bus.connect(musicBus);
      drums = ctx.createGain(); drums.gain.value = 0.75; drums.connect(bus);
      keys = ctx.createGain(); keys.gain.value = 1; keys.connect(bus);
      lfo = ctx.createOscillator(); lfo.frequency.value = 4.2;
      const depth = ctx.createGain(); depth.gain.value = 0.16;
      lfo.connect(depth); depth.connect(keys.gain); lfo.start();
      // vinilo: siseo muy bajo con chasquidos de vez en cuando
      const len = ctx.sampleRate * 3;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * 0.06;
        if (Math.random() < 0.00018) { const amp = 0.4 + Math.random() * 0.6; for (let k = 0; k < 40 && i + k < len; k++) d[i + k] += amp * Math.exp(-k / 6) * (Math.random() * 2 - 1); }
      }
      vinyl = ctx.createBufferSource(); vinyl.buffer = buf; vinyl.loop = true;
      const vf = ctx.createBiquadFilter(); vf.type = "bandpass"; vf.frequency.value = 2400; vf.Q.value = 0.5;
      const vg = ctx.createGain(); vg.gain.value = 0.22;
      vinyl.connect(vf); vf.connect(vg); vg.connect(bus);
      vinyl.start();
    }

    function ep(m, t, dur, v) {
      const f = mtof(m) * Math.pow(2, ((Math.random() - 0.5) * 8) / 1200); // un pelín desafinado
      const o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 2.001;
      const g1 = ctx.createGain(), g2 = ctx.createGain();
      g1.gain.setValueAtTime(0.0001, t);
      g1.gain.exponentialRampToValueAtTime(0.11 * v, t + 0.012);
      g1.gain.exponentialRampToValueAtTime(0.045 * v, t + 1.1);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(0.03 * v, t + 0.006);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o1.connect(g1); o2.connect(g2); g1.connect(keys); g2.connect(keys);
      o1.start(t); o2.start(t); o1.stop(t + dur + 0.6); o2.stop(t + 0.6);
    }
    function bass(m, t, dur, v) {
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = mtof(m);
      const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = 420;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.34 * v, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.16 * v, t + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(fl); fl.connect(g); g.connect(bus);
      o.start(t); o.stop(t + dur + 0.05);
    }
    function pluck(m, t, v) {
      const f = mtof(m);
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 3.01;
      const g = ctx.createGain(), g2 = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06 * v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      g2.gain.setValueAtTime(0.0001, t); g2.gain.exponentialRampToValueAtTime(0.012 * v, t + 0.003); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g); o2.connect(g2); g.connect(bus); g2.connect(bus);
      o.start(t); o2.start(t); o.stop(t + 1.15); o2.stop(t + 0.2);
    }
    function kick(t, v) {
      const o = ctx.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7 * v, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g); g.connect(drums); o.start(t); o.stop(t + 0.42);
    }
    function hit(t, o) {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf;
      const fl = ctx.createBiquadFilter(); fl.type = o.type; fl.frequency.value = o.freq; fl.Q.value = o.q || 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(o.vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      src.connect(fl); fl.connect(g); g.connect(drums);
      src.start(t, Math.random() * 0.5); src.stop(t + o.dur + 0.02);
    }
    function snare(t, v) {
      hit(t, { type: "bandpass", freq: 1700, q: 0.9, vol: 0.32 * v, dur: 0.17 });
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = 185;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.16 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g); g.connect(drums); o.start(t); o.stop(t + 0.1);
    }
    const hat = (t, v) => hit(t, { type: "highpass", freq: 7600, vol: 0.09 * v, dur: 0.035 });

    function playStep(s, t) {
      const [root, q] = PROGS[prog][bar % 4];
      const chord = voicing(root, q);
      let b = 36 + root; if (b > 44) b -= 12;
      // batería con swing
      if (s === 0 || s === 10 || (s === 7 && chance(0.35)) || (s === 14 && bar % 4 === 3 && chance(0.4))) kick(t, s === 0 ? 1 : 0.8);
      if (s === 4 || s === 12) snare(t, 1);
      if (s === 15 && chance(0.15)) snare(t, 0.3);
      if (s % 2 === 0) hat(t, s % 4 === 0 ? 0.9 : 0.55);
      else if (chance(0.12)) hat(t, 0.35);
      // piano eléctrico: acorde arpegiado al empezar el compás y a veces otro golpe suave
      if (s === 0) chord.forEach((n, i) => ep(n, t + i * 0.014, STEP * 15, 0.9));
      if (s === 10 && chance(0.4)) chord.slice(1).forEach((n, i) => ep(n, t + i * 0.01, STEP * 6, 0.5));
      // bajo
      if (s === 0) bass(b, t, STEP * 6, 1);
      if (s === 7 && chance(0.5)) bass(b + 12, t, STEP * 2, 0.6);
      if (s === 10) bass(b + (chance(0.3) ? 7 : 0), t, STEP * 5, 0.85);
      // kalimba: pocas notas, de las del acorde, una octava arriba
      if (s % 2 === 0 && chance(bar % 2 ? 0.2 : 0.11)) {
        const n = chord[Math.floor(Math.random() * chord.length)] + 12;
        pluck(n, t, 0.6 + Math.random() * 0.4);
      }
    }

    function schedule() {
      if (!on || !ctx) return;
      const horizon = document.hidden ? 1.6 : 0.3;
      if (nextTime < ctx.currentTime - 0.05) nextTime = ctx.currentTime + 0.05; // la pestaña estuvo dormida
      while (nextTime < ctx.currentTime + horizon) {
        const swing = step % 4 === 2 ? STEP * 0.28 : 0;
        playStep(step, nextTime + swing);
        nextTime += STEP;
        step = (step + 1) % 16;
        if (step === 0) {
          bar++;
          if (bar % 8 === 0) prog = (prog + 1 + Math.floor(Math.random() * (PROGS.length - 1))) % PROGS.length;
        }
      }
    }

    function start() {
      if (on || !ensure() || ctx.state !== "running") return;
      if (!bus) build();
      on = true;
      step = 0; bar = 0; prog = Math.floor(Math.random() * PROGS.length);
      nextTime = ctx.currentTime + 0.12;
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.setValueAtTime(0.0001, ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(prefs.musicVol * 0.55, ctx.currentTime + 2.5);
      timer = setInterval(schedule, 50);
      schedule();
    }
    function stop() {
      if (!on) return;
      on = false;
      clearInterval(timer); timer = null;
      if (ctx) musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    }
    return { start, stop, playing: () => on };
  })();

  function unlock() {
    if (!ensure()) return;
    const go = () => { if (prefs.music && !Music.playing()) Music.start(); };
    if (ctx.state === "suspended") ctx.resume().then(go, () => {});
    else go();
  }

  function set(key, value) {
    prefs[key] = value;
    save();
    if (key === "music") { if (value) { unlock(); Music.start(); } else Music.stop(); }
    applyVolumes(false);
  }

  function play(name, arg) {
    if (!prefs.sfx || !ready() || !SFX[name]) return;
    try { SFX[name](arg); } catch {}
  }

  return { unlock, play, set, prefs, music: Music };
})();
