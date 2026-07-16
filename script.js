/*
 * script.js — Knotlight game engine
 * Quietloom · 2025
 *
 * Responsibilities:
 *   - Level picker: render cards, mark completed levels, show star rating
 *   - Board: size the canvas, draw the grid, lights, and threads
 *   - Input: handle mouse and touch via a single Pointer Events path
 *   - State: track cell ownership, pair completion, move count
 *   - Win: detect solve (all pairs joined), show the win overlay
 *   - Hint: BFS path from one endpoint of an unsolved pair to the other
 *   - Persistence: read/write settings and progress to localStorage
 *   - Colourblind mode: draw a distinct shape marker on each light
 *   - Audio: synthesise connect/win tones via WebAudio — no audio files
 *
 * All DOM interaction goes through the `el` cache built at startup.
 * The module pattern (IIFE) keeps everything out of global scope;
 * only the LEVELS constant (from levels.js) is consumed as a global.
 */

(function () {
  "use strict";

  // ── Storage keys ──────────────────────────────────────────────
  const SP = "kl_s"; // settings
  const PP = "kl_p"; // progress

  // ── Colourblind shape map ──────────────────────────────────────
  // One distinct shape per palette colour so lights are
  // distinguishable without relying on colour alone.
  const SHAPES = {
    Ruby:    "circle",
    Amber:   "square",
    Gold:    "triangle",
    Leaf:    "diamond",
    Teal:    "star",
    Cobalt:  "hexagon",
    Violet:  "plus",
    Rose:    "pentagon",
    Sky:     "ring",
    Lime:    "triangleDown",
    Rust:    "semicircle",
    Orchid:  "chevron",
  };

  // ── Persistence helpers ────────────────────────────────────────

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SP);
      if (raw) return Object.assign({ snd: true, cb: false }, JSON.parse(raw));
    } catch (e) { /* storage unavailable — use defaults */ }
    return { snd: true, cb: false };
  }
  function saveSettings() {
    try { localStorage.setItem(SP, JSON.stringify(G.s)); } catch (e) {}
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(PP);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
  }
  function saveProgress() {
    try { localStorage.setItem(PP, JSON.stringify(G.p)); } catch (e) {}
  }

  // ── Runtime state ─────────────────────────────────────────────
  // Single mutable object so all functions share the same reference.
  const G = {
    s:       loadSettings(),  // settings: { snd, cb }
    p:       loadProgress(),  // progress: { [levelId]: { completed, best } }
    lv:      null,            // current level object from LEVELS[]
    own:     [],              // [row][col] → pairIndex or null — cell ownership
    paths:   [],              // [pairIndex] → [[col,row], …] or null
    done:    [],              // [pairIndex] → true once the pair is complete
    active:  null,            // pairIndex currently being traced, or null
    last:    null,            // pairIndex last touched (for Clear Thread)
    moves:   0,               // completed pair count for the current attempt
    hp:      null,            // hint path [[col,row], …] or null
    he:      0,               // hint expiry timestamp (ms)
  };

  // ── DOM element cache ──────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const el = {
    pick:     $("sc-pick"),
    game:     $("sc-game"),
    grid:     $("picker-grid"),
    canvas:   $("board-canvas"),
    hmv:      $("hmv"),
    hpar:     $("hpar"),
    s1:       $("s1"), s2: $("s2"), s3: $("s3"),
    ovWin:    $("ov-win"),
    winCard:  $("win-card"),
    wheading: $("wheading"),
    wsub:     $("wsub"),
    wmv:      $("wmv"),
    wpar:     $("wpar"),
    wbest:    $("wbest"),
    bnext:    $("btn-wnext"),
    ovSet:    $("ov-set"),
    swSnd:    $("sw-snd"),
    btnCB:    $("btn-cb-toggle"),
  };
  const ctx = el.canvas.getContext("2d");

  // Remove splash from DOM after its CSS animation finishes
  setTimeout(() => { const s = $("splash"); if (s) s.remove(); }, 3000);

  // ── Audio ──────────────────────────────────────────────────────
  // WebAudio context is created lazily on first user interaction
  // to satisfy autoplay policies in all browsers.
  let audioCtx = null;

  function beep(freq, dur) {
    if (!G.s.snd) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.07, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }

  // Short ascending tone when a pair connects
  const sndConnect = () => beep(540, .12);
  // Three-note ascending flourish on a level solve
  const sndWin = () => {
    beep(660, .14);
    setTimeout(() => beep(830, .17), 110);
    setTimeout(() => beep(1050, .2), 260);
  };

  // ── Star rating ────────────────────────────────────────────────
  // par is the minimum possible moves (one per pair).
  // A small margin above par still earns two stars.
  function getStars(moves, par) {
    if (moves <= par)                        return 3; // perfect solve
    if (moves <= par + Math.ceil(par * .5)) return 2; // efficient
    return 1;                                           // completed
  }

  function showStars(n) {
    [el.s1, el.s2, el.s3].forEach((star, i) => {
      star.className = "star " + (i < n ? "lit" : "dim");
    });
  }

  // ── Level picker ───────────────────────────────────────────────
  // Levels with placeholder: true are hidden until the client
  // delivers the remaining brief pages (levels 16–18).
  function renderPicker() {
    el.grid.innerHTML = "";
    LEVELS.filter(lv => !lv.placeholder).forEach(lv => {
      const sv    = G.p[lv.id];
      const done  = sv && sv.completed;
      const stars = done ? getStars(sv.best, lv.par) : 0;

      const card = document.createElement("div");
      card.className = "lcard" + (done ? " done" : "");
      card.innerHTML =
        "<span class='num'>"  + lv.id  + "</span>" +
        "<span class='meta'>" + lv.grid.w + "×" + lv.grid.h + "</span>" +
        (done
          ? "<span class='stars'>" + "★".repeat(stars) + "☆".repeat(3 - stars) + "</span>"
          : "<span class='meta'>" + lv.pairs.length + " pairs</span>");

      card.addEventListener("click", () => openLevel(lv.id));
      el.grid.appendChild(card);
    });
  }

  function showScreen(name) {
    el.pick.classList.toggle("active", name === "pick");
    el.game.classList.toggle("active", name === "game");
  }

  // ── Level initialisation ───────────────────────────────────────
  function openLevel(id) {
    G.lv = LEVELS.find(l => l.id === id);
    const { w, h } = G.lv.grid;

    // Reset board state
    G.own   = Array.from({ length: h }, () => Array(w).fill(null));
    G.paths = G.lv.pairs.map(() => null);
    G.done  = G.lv.pairs.map(() => false);
    G.active = G.last = null;
    G.moves  = 0;
    G.hp = null; G.he = 0;

    el.hpar.textContent = G.lv.par;
    updateHud();
    showScreen("game");
    sizeCanvas();
    render();
    syncCB();
  }

  function updateHud() {
    el.hmv.textContent = G.moves;
  }

  // ── Canvas sizing ──────────────────────────────────────────────
  // Cell size is recalculated every time the window resizes or a
  // new level opens so the board fills the available space.
  // Clamped to a minimum of 4px to prevent negative arc radii.
  let CS = 0; // cell size in CSS pixels

  function sizeCanvas() {
    const wrap = el.canvas.parentElement;
    const avail = Math.min(wrap.clientWidth, wrap.clientHeight) - 8;
    const { w, h } = G.lv.grid;
    CS = Math.max(4, Math.floor(avail / Math.max(w, h)));

    const dpr = devicePixelRatio || 1;
    el.canvas.style.width  = CS * w + "px";
    el.canvas.style.height = CS * h + "px";
    el.canvas.width  = CS * w * dpr;
    el.canvas.height = CS * h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", () => { if (G.lv) { sizeCanvas(); render(); } });

  // ── Geometry helpers ───────────────────────────────────────────

  // Centre point of a cell in CSS pixels
  const cellCentre = (col, row) => [col * CS + CS / 2, row * CS + CS / 2];

  // Convert a pointer position to [col, row], or null if out of bounds
  function pointerToCell(clientX, clientY) {
    const r   = el.canvas.getBoundingClientRect();
    const col = Math.floor((clientX - r.left) / CS);
    const row = Math.floor((clientY - r.top)  / CS);
    const { w, h } = G.lv.grid;
    return (col < 0 || row < 0 || col >= w || row >= h) ? null : [col, row];
  }

  const sameCell = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  const adjacent = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

  // Return the pair index if [col, row] is a light endpoint, else -1
  function findLight(col, row) {
    for (let i = 0; i < G.lv.pairs.length; i++) {
      const p = G.lv.pairs[i];
      if (sameCell(p.a, [col, row]) || sameCell(p.b, [col, row])) return i;
    }
    return -1;
  }

  // ── Hint from recorded solution ────────────────────────────────
  // Each pair carries a solution path recorded at build time and
  // verified by an exhaustive solver: the paths in a level connect
  // every pair AND cover every cell without crossing. The hint
  // reveals the recorded path for the requested pair — no
  // pathfinding happens at runtime.
  function recordedHint(pairIndex) {
    const path = G.lv.pairs[pairIndex].solution;
    return (path && path.length > 1) ? path : null;
  }

  // ── Drawing helpers ────────────────────────────────────────────

  // Regular polygon for pentagon, hexagon shapes
  function drawPolygon(cx, cy, r, sides, rotation) {
    for (let i = 0; i < sides; i++) {
      const a = rotation + (i * 2 * Math.PI) / sides;
      i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
              : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
  }

  // Five-point star outline
  function drawStar(cx, cy, rOuter, rInner, points) {
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? rOuter : rInner;
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
              : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
  }

  // Render one of the 12 colourblind marker shapes centred on (cx, cy)
  function drawShape(shape, cx, cy, size, fill) {
    if (size <= 0) return;
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle = fill;
    const r = Math.max(1, size / 2);
    ctx.beginPath();
    switch (shape) {
      case "circle":       ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); break;
      case "square":       ctx.rect(cx - r, cy - r, r * 2, r * 2); ctx.fill(); break;
      case "diamond":
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
        ctx.closePath(); ctx.fill(); break;
      case "triangle":
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r * .8);
        ctx.lineTo(cx - r, cy + r * .8); ctx.closePath(); ctx.fill(); break;
      case "triangleDown":
        ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r * .8);
        ctx.lineTo(cx - r, cy - r * .8); ctx.closePath(); ctx.fill(); break;
      case "pentagon":     drawPolygon(cx, cy, r, 5, -Math.PI / 2); ctx.fill(); break;
      case "hexagon":      drawPolygon(cx, cy, r, 6, 0);            ctx.fill(); break;
      case "star":         drawStar(cx, cy, r, r * .42, 5);         ctx.fill(); break;
      case "plus": {
        const t = size * .28;
        ctx.rect(cx - t / 2, cy - r, t, r * 2);
        ctx.rect(cx - r, cy - t / 2, r * 2, t);
        ctx.fill(); break;
      }
      case "ring":
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.lineWidth = size * .26; ctx.stroke(); break;
      case "semicircle":
        ctx.arc(cx, cy, r, 0, Math.PI); ctx.closePath(); ctx.fill(); break;
      case "chevron":
        ctx.moveTo(cx - r, cy - r * .3); ctx.lineTo(cx, cy + r * .5);
        ctx.lineTo(cx + r, cy - r * .3);
        ctx.lineWidth = size * .22; ctx.lineCap = "round";
        ctx.lineJoin = "round"; ctx.stroke(); break;
      default:
        ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Stroke a connected chain of cells as a rounded thread
  function drawThread(path, colour, width) {
    if (!path || path.length < 2) return;
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth   = Math.max(1, width);
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.beginPath();
    path.forEach((cell, i) => {
      const [x, y] = cellCentre(cell[0], cell[1]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // ── Main render ────────────────────────────────────────────────
  function render() {
    if (!G.lv || CS <= 0) return;
    const { w, h } = G.lv.grid;

    // Background
    ctx.fillStyle = "#20242B";
    ctx.fillRect(0, 0, w * CS, h * CS);

    // Subtle cell tint for owned cells — shows coverage progress
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (G.own[r][c] !== null) {
          ctx.fillStyle = "rgba(237,230,218,.04)";
          ctx.fillRect(c * CS, r * CS, CS, CS);
        }
      }
    }

    // Grid lines
    ctx.strokeStyle = "#39404B";
    ctx.lineWidth   = 1;
    for (let c = 0; c <= w; c++) {
      ctx.beginPath(); ctx.moveTo(c * CS, 0);     ctx.lineTo(c * CS, h * CS); ctx.stroke();
    }
    for (let r = 0; r <= h; r++) {
      ctx.beginPath(); ctx.moveTo(0, r * CS);     ctx.lineTo(w * CS, r * CS); ctx.stroke();
    }

    // Hint overlay — dashed path, fades after 3 s
    if (G.hp && G.he > Date.now()) {
      ctx.save();
      ctx.setLineDash([CS * .17, CS * .12]);
      drawThread(G.hp, "rgba(237,230,218,.45)", Math.max(2, CS * .1));
      ctx.restore();
    } else if (G.hp) {
      G.hp = null; // expired
    }

    // Active threads
    G.lv.pairs.forEach((pair, i) => {
      const path = G.paths[i];
      if (path && path.length > 1) drawThread(path, pair.hex, Math.max(2, CS * .32));
    });

    // Light endpoints
    G.lv.pairs.forEach((pair, i) => {
      [pair.a, pair.b].forEach(pos => {
        const [cx, cy] = cellCentre(pos[0], pos[1]);
        const radius   = Math.max(1, CS * .3);

        ctx.save();
        // Glow on the actively traced pair
        if (G.active === i) { ctx.shadowColor = pair.hex; ctx.shadowBlur = CS * .4; }
        ctx.beginPath();
        ctx.fillStyle = pair.hex;
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Colourblind marker drawn over the light
        if (G.s.cb) {
          drawShape(SHAPES[pair.colour] || "circle", cx, cy, Math.max(2, CS * .3), "rgba(8,10,14,.6)");
        }
      });
    });
  }

  // ── Pointer input ──────────────────────────────────────────────

  // Release all cells owned by a thread back to null
  function freePair(pairIndex) {
    const path = G.paths[pairIndex];
    if (!path) return;
    path.forEach(([c, r]) => { G.own[r][c] = null; });
    G.paths[pairIndex] = null;
  }

  el.canvas.addEventListener("pointerdown", e => {
    const cell = pointerToCell(e.clientX, e.clientY);
    if (!cell) return;
    const [col, row] = cell;

    // Resume tracing from the open tip of an in-progress thread
    for (let i = 0; i < G.lv.pairs.length; i++) {
      const path = G.paths[i];
      if (path && !G.done[i] && sameCell(path[path.length - 1], cell)) {
        G.active = i; G.last = i;
        el.canvas.setPointerCapture(e.pointerId);
        render(); return;
      }
    }

    // Start a new trace from a light endpoint
    const pi = findLight(col, row);
    if (pi < 0) return;

    // If re-drawing a completed pair, undo the move credit
    if (G.done[pi]) { freePair(pi); G.done[pi] = false; G.moves = Math.max(0, G.moves - 1); }
    else freePair(pi);

    G.paths[pi]    = [[col, row]];
    G.own[row][col] = pi;
    G.active = pi; G.last = pi;
    el.canvas.setPointerCapture(e.pointerId);
    updateHud(); render();
  });

  el.canvas.addEventListener("pointermove", e => {
    if (G.active === null) return;
    const cell = pointerToCell(e.clientX, e.clientY);
    if (!cell) return;

    const [col, row] = cell;
    const pi   = G.active;
    const path = G.paths[pi];
    const last = path[path.length - 1];
    if (sameCell(last, cell)) return;

    // Backtrack: if the pointer returns to the previous cell, erase the last step
    if (path.length > 1 && sameCell(path[path.length - 2], cell)) {
      const [lc, lr] = last;
      G.own[lr][lc] = null;
      path.pop();
      render(); return;
    }

    if (!adjacent(last, cell)) return; // diagonal or jump — ignore

    // Reaching the matching endpoint completes the pair
    const tpi = findLight(col, row);
    if (tpi >= 0) {
      if (tpi !== pi) return;                    // can't land on another colour's light
      if (G.own[row][col] !== null) return;      // cell already occupied
      path.push(cell); G.own[row][col] = pi;
      G.done[pi] = true; G.active = null; G.moves++;
      sndConnect(); updateHud(); render(); checkWin();
      return;
    }

    if (G.own[row][col] !== null) return; // cell owned by another thread
    path.push(cell); G.own[row][col] = pi;
    render();
  });

  el.canvas.addEventListener("pointerup",     () => { G.active = null; });
  el.canvas.addEventListener("pointercancel", () => { G.active = null; });

  // ── Win detection ──────────────────────────────────────────────
  // A level is solved only when BOTH conditions hold:
  //   1. every pair is connected, and
  //   2. every cell on the grid is covered by a thread.
  // This is the full-coverage rule from the brief — connecting all
  // pairs while leaving empty cells does not complete the level.
  function boardFullyCovered() {
    return G.own.every(row => row.every(cell => cell !== null));
  }

  function checkWin() {
    if (!G.done.every(Boolean)) return;   // condition 1: all pairs joined
    if (!boardFullyCovered()) return;      // condition 2: every cell covered

    const id   = G.lv.id;
    const prev = G.p[id];
    const best = prev && prev.best ? Math.min(prev.best, G.moves) : G.moves;

    G.p[id] = { completed: true, best };
    saveProgress();

    const stars = getStars(G.moves, G.lv.par);
    const perf  = stars === 3;
    sndWin();

    const next = LEVELS.find(l => l.id === id + 1 && !l.placeholder);

    // Populate win card before revealing overlay
    showStars(stars);
    el.wheading.textContent = perf ? "Perfect!" : "Level " + id + " Complete";
    el.wsub.textContent     = perf ? "Solved in the fewest possible moves" : "All lights connected";
    el.wmv.textContent      = G.moves;
    el.wpar.textContent     = G.lv.par;
    el.wbest.textContent    = best;
    el.bnext.style.display  = next ? "flex" : "none";

    // Re-trigger the slide-up animation by forcing a reflow
    el.winCard.style.animation = "none";
    void el.winCard.offsetHeight;
    el.winCard.style.animation = "";

    el.ovWin.classList.add("on");
  }

  // ── Footer controls ────────────────────────────────────────────

  $("btn-back").addEventListener("click", () => { showScreen("pick"); renderPicker(); });

  $("btn-clear").addEventListener("click", () => {
    const target = G.active !== null ? G.active : G.last;
    if (target === null) return;
    if (G.done[target]) { G.done[target] = false; G.moves = Math.max(0, G.moves - 1); }
    freePair(target);
    G.active = null;
    updateHud(); render();
  });

  $("btn-reset").addEventListener("click", () => {
    G.lv.pairs.forEach((_, i) => freePair(i));
    G.done.fill(false);
    G.active = G.last = null;
    G.moves  = 0;
    G.own.forEach(row => row.fill(null));
    G.hp = null;
    updateHud(); render();
  });

  $("btn-hint").addEventListener("click", () => {
    // Reveal the recorded solution path for the first unsolved pair
    const idx = G.done.findIndex(d => !d);
    if (idx === -1) return;
    const path = recordedHint(idx);
    if (!path) return; // level has no recorded solution yet
    G.hp = path;
    G.he = Date.now() + 3000; // hint visible for 3 seconds
    render();
    setTimeout(render, 3100);
  });

  // ── Win overlay buttons ────────────────────────────────────────

  el.bnext.addEventListener("click", () => {
    el.ovWin.classList.remove("on");
    const next = LEVELS.find(l => l.id === G.lv.id + 1 && !l.placeholder);
    if (next) openLevel(next.id);
    else { showScreen("pick"); renderPicker(); }
  });

  $("btn-wreplay").addEventListener("click", () => {
    el.ovWin.classList.remove("on");
    openLevel(G.lv.id);
  });

  // ── Colourblind toggle ─────────────────────────────────────────

  function syncCB() {
    el.btnCB.classList.toggle("active", G.s.cb);
  }

  el.btnCB.addEventListener("click", () => {
    G.s.cb = !G.s.cb;
    saveSettings(); syncCB();
    if (G.lv) render();
  });

  // ── Settings panel ─────────────────────────────────────────────

  function syncSwitches() {
    el.swSnd.classList.toggle("on", G.s.snd);
  }

  $("btn-set").addEventListener("click",    () => { syncSwitches(); el.ovSet.classList.add("on"); });
  $("btn-sclose").addEventListener("click", () => el.ovSet.classList.remove("on"));

  el.swSnd.addEventListener("click", () => {
    G.s.snd = !G.s.snd;
    saveSettings(); syncSwitches();
  });

  $("btn-rp").addEventListener("click", () => {
    if (!confirm("Reset all saved progress? This cannot be undone.")) return;
    G.p = {};
    saveProgress();
    renderPicker();
  });

  // ── Initialise ────────────────────────────────────────────────
  renderPicker();

})();
