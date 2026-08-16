/* ================================================================
 *  ZYROX MESSIAH v5 â€” BEYOND MESSIAH (Fixed)
 *  ----------------------------------------------------------------
 *  Fully automatic. Zero toggles. Every tick optimized.
 *  Hooks verified against decompiled script.js (31957 lines).
 *
 *  REAL API (from script.js):
 *    gameManager.OwnPlayerId   â€” your player ID
 *    gameManager.kD            â€” total map land count (NOT gS!)
 *    gameManager.arraySize     â€” 512 (max players)
 *    gameManager.yB            â€” bot/neutral offset
 *    gameManager.gS            â€” 2 (conquest cost per tile)
 *    gameManager.isGameStarted() â€” a17===1 && !isSpawnPhase
 *    playerData.playerTroops[i]  â€” Uint32Array
 *    playerData.landOwned[i]    â€” Uint32Array
 *    playerData.gp[i]           â€” border tile arrays
 *    playerData.ga[i]           â€” special border tiles
 *    mapData.neighborOffsets    â€” Int32Array(4) in tile-data units
 *    protocolHandler.gameCommandSender.attackTargetHandler(ratio, target)
 *    protocolHandler.gameCommandSender.cancelAttackHandler(target)
 *    protocolHandler.gameCommandSender.sendBoatHandler(ratio, target)
 *    gameLoop.getTick()          â€” current tick
 *    gameLoop.targetFrameTime    â€” 56ms
 *    incomeManager.getPlayerIncomeRate(player) â€” 0-700
 *    incomeManager.getRedInterestCap(player)    â€” min(100*land, 1B)
 *
 *  NOTE: All game vars are top-level `var` â†’ accessible via window.
 *  Game error handler (line 97) catches ALL errors and shows popup
 *  when startupState===1. Every call must be wrapped in try/catch.
 * ================================================================ */

(function () {
  'use strict';

  /* ---- constants ---- */
  var TICK_MS = 56;
  var INCOME_EVERY = 10;          // tick%10===9
  var AUG_END = 1920;             // augmentation ends
  var MAX_RATE = 700;
  var SOFT_CAP = 100;             // troops/land soft cap
  var HARD_CAP = 150;
  var ATTACK_TAX = 12 / 1024;
  var MIN_RATIO = 0;              // unitRatio 0-1023
  var MAX_RATIO = 1023;

  /* ---- safe refs (populated once game starts) ---- */
  var gm, pd, md, ph, gl, im;
  var ready = false;
  var ownId = -1;

  function hook() {
    try {
      gm = window.gameManager;
      pd = window.playerData;
      md = window.mapData;
      ph = window.protocolHandler;
      gl = window.gameLoop;
      im = window.incomeManager;
      if (gm && pd && ph && gl && md) {
        ownId = gm.OwnPlayerId;
        ready = true;
      }
    } catch (e) { /* not ready yet */ }
    return ready;
  }

  function gameOn() {
    try { return gm && gm.isGameStarted && gm.isGameStarted(); } catch (e) { return false; }
  }

  function tick() {
    try { return gl.getTick(); } catch (e) { return -1; }
  }

  function troops(id) {
    try { return pd.playerTroops[id] || 0; } catch (e) { return 0; }
  }
  function land(id) {
    try { return pd.landOwned[id] || 0; } catch (e) { return 0; }
  }
  function density(id) {
    var l = land(id);
    return l > 0 ? troops(id) / l : 0;
  }
  function totalMapLand() {
    try { return gm.kD || 262144; } catch (e) { return 262144; }
  }
  function neutralId() {
    try { return gm.yB; } catch (e) { return 0; }
  }
  function myIncomeRate() {
    try { return im.getPlayerIncomeRate(ownId); } catch (e) { return 0; }
  }

  /* ---- attack helpers ---- */
  function pctToRatio(pct) {
    // pct: 0-100 â†’ ratio: 0-1023
    return Math.max(MIN_RATIO, Math.min(MAX_RATIO, Math.round(1023 * pct / 100)));
  }

  function sendAtk(pct, targetId) {
    try {
      var ratio = pctToRatio(pct);
      ph.gameCommandSender.attackTargetHandler(ratio, targetId);
      return true;
    } catch (e) { return false; }
  }

  function sendBoat(pct, targetId) {
    try {
      var ratio = pctToRatio(pct);
      ph.gameCommandSender.sendBoatHandler(ratio, targetId);
      return true;
    } catch (e) { return false; }
  }

  function cancelAtk(targetId) {
    try { ph.gameCommandSender.cancelAttackHandler(targetId); } catch (e) { /* */ }
  }

  /* ================================================================
   *  CONQUEST PHASE (time-based)
   *  divisor = u0 * mult, where u0 = 1 + floor(mapSize/300)
   * ================================================================ */
  var phaseName = 'IDLE';
  var phaseDivisor = 1;
  var phaseIsDef = false;

  var PHASES = [
    { end: 357,   mult: 1,   name: 'BLITZ' },
    { end: 714,   mult: 4,   name: 'FAST' },
    { end: 1071,  mult: 10,  name: 'MEDIUM' },
    { end: 2142,  mult: 30,  name: 'SLOW' },
    { end: 3213,  mult: 100, name: 'V.SLOW' },
    { end: 1e9,   mult: -1,  name: 'DEFENSE' }
  ];

  function updatePhase(t) {
    if (t < 0) { phaseName = 'IDLE'; return; }
    var u0 = 1 + Math.floor(totalMapLand() / 300);
    for (var i = 0; i < PHASES.length; i++) {
      if (t < PHASES[i].end) {
        if (PHASES[i].mult === -1) {
          phaseName = 'DEFENSE';
          phaseIsDef = true;
        } else {
          phaseName = PHASES[i].name;
          phaseDivisor = PHASES[i].mult * u0;
          phaseIsDef = false;
        }
        return;
      }
    }
  }

  /* ================================================================
   *  INCOME HELPERS
   * ================================================================ */
  function isIncomeTick(t) { return t % INCOME_EVERY === INCOME_EVERY - 1; }
  function isPreIncomeTick(t) { return t % INCOME_EVERY === INCOME_EVERY - 2; }
  function inAugmentation(t) { return t < AUG_END; }

  /* ================================================================
   *  CYCLE TRACKER
   * ================================================================ */
  var curTick = -1;
  var tickChanged = false;

  function updateCycle() {
    var t = tick();
    if (t <= curTick) { tickChanged = false; return; }
    curTick = t;
    tickChanged = true;
  }

  /* ================================================================
   *  ENEMY INTELLIGENCE
   * ================================================================ */
  var enemyCache = null;
  var cacheTick = -1;

  function getEnemies() {
    if (cacheTick === curTick && enemyCache) return enemyCache;
    cacheTick = curTick;
    enemyCache = [];
    try {
      var as = gm.arraySize;
      var nid = neutralId();
      var myB = pd.gp ? pd.gp[ownId] : null;
      if (!myB) return enemyCache;

      // Build set of my border tile indices
      var mySet = new Set(myB);

      for (var pid = 0; pid < as; pid++) {
        if (pid === ownId) continue;
        if (!land(pid)) continue;
        var tiles = pd.gp ? pd.gp[pid] : null;
        if (!tiles || !tiles.length) continue;
        var shared = 0;
        for (var i = 0; i < tiles.length; i++) {
          // Check 4-neighbors
          var c = tiles[i];
          if (mySet.has(c - 1) || mySet.has(c + 1) || mySet.has(c - as) || mySet.has(c + as)) {
            shared++;
          }
        }
        if (shared > 0) {
          enemyCache.push({
            id: pid,
            shared: shared,
            troops: troops(pid),
            land: land(pid),
            density: density(pid),
            isNeutral: (pid === nid || pid === 0)
          });
        }
      }
    } catch (e) { /* */ }
    return enemyCache;
  }

  function getThreats() {
    var enemies = getEnemies();
    var myT = troops(ownId);
    var myD = density(ownId);
    var myL = land(ownId);
    var threats = [];
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.isNeutral) continue;
      var score = 0;
      score += (e.troops / Math.max(1, myT)) * 30;
      score += (e.density / Math.max(1, myD)) * 25;
      score += (e.land / Math.max(1, myL)) * 15;
      threats.push({
        id: e.id, troops: e.troops, land: e.land,
        density: e.density, threat: score,
        isEasy: e.density < myD * 0.6
      });
    }
    threats.sort(function (a, b) { return b.threat - a.threat; });
    return threats;
  }

  /* ================================================================
   *  BOT STATE
   * ================================================================ */
  var stats = { attacks: 0, expansions: 0, retreats: 0, boats: 0, kills: 0 };
  var lastAtkTick = {};
  var activeTargets = {};
  var underAttack = false;
  var balanceHistory = [];
  var openingDone = false;
  var openingMoves = null;
  var openingExecuted = {};

  function canAfford(pct) {
    var t = troops(ownId);
    var l = land(ownId);
    var remain = t * (1 - pct / 100);
    return l > 0 ? (remain / l) >= 40 : remain > 500;
  }

  function maxSafePct() {
    var t = troops(ownId);
    var l = land(ownId);
    if (l <= 0 || t <= 0) return 0;
    var minT = l * 40;
    var maxSend = t - minT;
    return maxSend > 0 ? Math.min(99, (maxSend / t) * 100) : 0;
  }

  function perfectPct() {
    var t = troops(ownId);
    var l = land(ownId);
    if (t <= 0 || l <= 0) return 0;
    var ideal = l * SOFT_CAP;
    var excess = t - ideal;
    if (excess <= 0) return 0.1;
    var pct = (excess / t) * 100;
    if (pct >= 50) {
      var tax = Math.floor(ATTACK_TAX * t);
      pct = Math.min(99, ((excess + tax) / t) * 100);
    }
    return Math.max(0.1, Math.min(99, pct));
  }

  function execute(pct, targetId) {
    if (pct <= 0) return false;
    if (!canAfford(pct)) return false;
    var last = lastAtkTick[targetId] || -100;
    if (curTick - last < 1) return false;
    if (sendAtk(pct, targetId)) {
      lastAtkTick[targetId] = curTick;
      activeTargets[targetId] = true;
      stats.attacks++;
      return true;
    }
    return false;
  }

  function detectIncoming() {
    var t = troops(ownId);
    balanceHistory.push({ tick: curTick, troops: t });
    if (balanceHistory.length > 5) balanceHistory.shift();
    if (balanceHistory.length >= 2) {
      var prev = balanceHistory[balanceHistory.length - 2];
      var curr = balanceHistory[balanceHistory.length - 1];
      var drop = prev.troops - curr.troops;
      var activeCount = Object.keys(activeTargets).length;
      var expectedTax = activeCount * (t * ATTACK_TAX);
      underAttack = drop > expectedTax + t * 0.03;
    }
  }

  function retreat() {
    if (!underAttack) return;
    if (density(ownId) >= SOFT_CAP) return;
    var threats = getThreats();
    var ids = Object.keys(activeTargets);
    for (var i = 0; i < ids.length; i++) {
      var tid = parseInt(ids[i]);
      for (var j = 0; j < threats.length; j++) {
        if (threats[j].id === tid && threats[j].threat > 30) {
          cancelAtk(tid);
          delete activeTargets[tid];
          stats.retreats++;
          break;
        }
      }
    }
  }

  /* ================================================================
   *  OPENING ENGINE â€” built when game starts (neutral ID known)
   * ================================================================ */
  function buildOpening() {
    var nid = neutralId();
    openingMoves = [
      // BLITZ: send full during cheapest conquest
      { t: 10,  p: 99,  tgt: nid },
      { t: 30,  p: 0.1, tgt: nid },
      { t: 60,  p: 85,  tgt: nid },
      { t: 81,  p: 0.1, tgt: nid },
      // FAST: multiple waves
      { t: 150, p: 60, tgt: nid },
      { t: 165, p: 0.1, tgt: nid },
      { t: 172, p: 80, tgt: nid },
      { t: 186, p: 0.1, tgt: nid },
      // MEDIUM: start interest farming
      { t: 256, p: 0.1, tgt: nid },
      { t: 263, p: 45, tgt: nid },
      { t: 270, p: 0.1, tgt: nid },
      { t: 284, p: 35, tgt: nid },
      // SLOW: minimal attacks, maximize interest
      { t: 354, p: 0.1, tgt: nid },
      { t: 361, p: 25, tgt: nid },
      { t: 375, p: 0.1, tgt: nid },
      { t: 382, p: 20, tgt: nid }
    ];
    openingDone = false;
    openingExecuted = {};
  }

  function processOpening() {
    if (openingDone || !openingMoves) return;
    for (var i = 0; i < openingMoves.length; i++) {
      var m = openingMoves[i];
      if (m.t === curTick && !openingExecuted[m.t]) {
        openingExecuted[m.t] = true;
        sendAtk(m.p, m.tgt);
        stats.expansions++;
      }
    }
    if (curTick > 500) openingDone = true;
  }

  /* ================================================================
   *  EXPANSION ENGINE â€” density-perfect
   * ================================================================ */
  function processExpansion() {
    if (!openingDone) return;
    if (underAttack && density(ownId) < 80) return;

    var myD = density(ownId);
    var myT = troops(ownId);
    var myL = land(ownId);
    if (myT <= 0 || myL <= 0) return;
    if (myD >= HARD_CAP) return;

    var nid = neutralId();

    // DEFENSE PHASE: slow reinforcement
    if (phaseIsDef) {
      if (curTick % 2 === 0) {
        if (myD > SOFT_CAP) {
          var p = perfectPct();
          if (p > 0.1) execute(p, nid);
        } else {
          execute(0.1, nid);
        }
      }
      return;
    }

    // PRE-INCOME: attack 1 tick before interest so new land earns next tick
    if (isPreIncomeTick(curTick)) {
      var p = perfectPct();
      if (p >= 0.1) { execute(p, nid); stats.expansions++; }
      return;
    }

    // On income tick: DO NOT attack, let interest compound
    if (isIncomeTick(curTick)) return;

    // RED ZONE: above soft cap, dump excess
    if (myD > SOFT_CAP) {
      var p = perfectPct();
      if (p >= 1) { execute(p, nid); stats.expansions++; }
      return;
    }

    // Periodic expansion every 3 ticks when density is good
    if (curTick % 3 === 0 && myD > 90) {
      var p = perfectPct();
      if (p >= 0.5) { execute(p, nid); stats.expansions++; }
    }
  }

  /* ================================================================
   *  COMBAT ENGINE â€” auto-attack enemies
   * ================================================================ */
  function processCombat() {
    if (!openingDone) return;
    if (underAttack && density(ownId) < 60) return;

    var enemies = getEnemies();
    var targets = [];
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.isNeutral) continue;
      if (e.land <= 0 || e.troops <= 0) continue;
      targets.push(e);
    }
    if (!targets.length) return;

    // Clean dead targets
    var ids = Object.keys(activeTargets);
    for (var i = 0; i < ids.length; i++) {
      var tid = parseInt(ids[i]);
      if (!land(tid)) {
        delete activeTargets[tid];
        stats.kills++;
      }
    }

    var myD = density(ownId);
    if (myD < 50) return;

    // Sort: easiest first
    targets.sort(function (a, b) { return a.density - b.density; });

    // Attack on ticks 5,6 of each 10-tick cycle (don't conflict with expansion at tick 8)
    var tic = curTick % INCOME_EVERY;
    if (tic !== 5 && tic !== 6) return;

    var budget = maxSafePct();
    var maxTargets = Math.min(targets.length, 3);
    var used = 0;

    for (var i = 0; i < maxTargets; i++) {
      var e = targets[i];
      if (used + 5 > budget) break;
      var pct;
      if (e.density < myD * 0.5) {
        pct = Math.min(30, budget - used);
      } else if (e.density < myD * 0.8) {
        var ratio = myD / Math.max(1, e.density);
        pct = Math.max(3, Math.min(25, 15 / ratio));
      } else {
        pct = 3;
      }
      pct = Math.min(pct, budget - used);
      if (pct >= 1 && execute(pct, e.id)) used += pct;
    }
  }

  /* ================================================================
   *  BOAT ENGINE
   * ================================================================ */
  var lastBoatTick = -100;

  function processBoats() {
    if (!openingDone) return;
    if (curTick - lastBoatTick < 30) return;
    if (density(ownId) < 80) return;

    var enemies = getEnemies();
    var myD = density(ownId);
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.isNeutral) continue;
      if (e.density >= myD * 0.7) continue;
      var pct = Math.max(3, Math.min(8, Math.round(
        (1 - e.density / Math.max(1, myD)) * 10
      )));
      if (canAfford(pct) && troops(ownId) * pct / 100 >= 60) {
        if (sendBoat(pct, e.id)) {
          lastBoatTick = curTick;
          stats.boats++;
          return;
        }
      }
    }
  }

  /* ================================================================
   *  GUI â€” minimal status overlay, no toggles
   * ================================================================ */
  var guiEl = null;
  var guiCounter = 0;

  function createGUI() {
    if (document.getElementById('m5-gui')) return;
    try {
      var s = document.createElement('style');
      s.id = 'm5-style';
      s.textContent =
        '#m5-gui{position:fixed;top:8px;left:8px;background:rgba(10,8,18,.92);border:1px solid #2a1f4a;border-radius:8px;padding:8px 12px;color:#fde68a;font:11px/1.5 Rajdhani,sans-serif;z-index:999999;user-select:none;-webkit-user-select:none;pointer-events:none;min-width:160px}' +
        '#m5-gui b{color:#fbbf24;font-size:12px;letter-spacing:1px}' +
        '.m5r{display:flex;justify-content:space-between;gap:12px}' +
        '.m5v{color:#fbbf24;font-weight:600;text-align:right}' +
        '.m5p{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:1px;margin-left:4px}' +
        '.m5p.BLITZ{background:#ef444444;color:#ef4444}' +
        '.m5p.FAST{background:#f9731644;color:#f97316}' +
        '.m5p.MEDIUM{background:#eab30844;color:#eab308}' +
        '.m5p.SLOW{background:#22c55e44;color:#22c55e}' +
        '.m5p.V.SLOW{background:#3b82f644;color:#3b82f6}' +
        '.m5p.DEFENSE{background:#a855f744;color:#a855f7}' +
        '.m5p.IDLE{color:#6b7280}';
      document.head.appendChild(s);

      var g = document.createElement('div');
      g.id = 'm5-gui';
      g.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
        '<b>MESSIAH v5</b><span class="m5p IDLE" id="m5-ph">IDLE</span></div>' +
        '<div class="m5r"><span>Tick</span><span class="m5v" id="m5-tk">-</span></div>' +
        '<div class="m5r"><span>Troops</span><span class="m5v" id="m5-tr">-</span></div>' +
        '<div class="m5r"><span>Land</span><span class="m5v" id="m5-ln">-</span></div>' +
        '<div class="m5r"><span>Density</span><span class="m5v" id="m5-dn">-</span></div>' +
        '<div class="m5r"><span>Income</span><span class="m5v" id="m5-ic">-</span></div>' +
        '<div class="m5r"><span>Enemies</span><span class="m5v" id="m5-en">-</span></div>' +
        '<div class="m5r"><span>Atk/Kill</span><span class="m5v" id="m5-st">0/0</span></div>';
      document.body.appendChild(g);
      guiEl = g;
    } catch (e) { /* GUI creation failed, bot still works */ }
  }

  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n) + '';
  }

  function updateGUI() {
    if (!guiEl) return;
    try {
      var ph2 = guiEl.querySelector('#m5-ph');
      if (ph2) { ph2.textContent = phaseName; ph2.className = 'm5p ' + phaseName; }
      var s = function (id, v) { var e = guiEl.querySelector('#' + id); if (e) e.textContent = v; };
      s('m5-tk', curTick);
      s('m5-tr', fmt(troops(ownId)));
      s('m5-ln', fmt(land(ownId)));
      s('m5-dn', density(ownId).toFixed(1));
      s('m5-ic', myIncomeRate());
      s('m5-en', getEnemies().length);
      s('m5-st', stats.attacks + '/' + stats.kills);
    } catch (e) { /* */ }
  }

  /* ================================================================
   *  MAIN LOOP
   * ================================================================ */
  var wasInGame = false;

  function resetState() {
    curTick = -1;
    tickChanged = false;
    openingDone = false;
    openingMoves = null;
    openingExecuted = {};
    lastAtkTick = {};
    activeTargets = {};
    underAttack = false;
    balanceHistory = [];
    lastBoatTick = -100;
    cacheTick = -1;
    enemyCache = null;
    stats = { attacks: 0, expansions: 0, retreats: 0, boats: 0, kills: 0 };
    wasInGame = false;
  }

  function mainLoop() {
    try {
      // Wait for game objects to exist
      if (!hook()) {
        requestAnimationFrame(mainLoop);
        return;
      }

      // Update ownId each frame (changes when you join a new game)
      ownId = gm.OwnPlayerId;

      var on = gameOn();

      if (!on) {
        // Game not running â€” reset if we were in a game
        if (wasInGame) resetState();
        wasInGame = false;
        requestAnimationFrame(mainLoop);
        return;
      }

      // Game just started â€” build opening
      if (!wasInGame) {
        wasInGame = true;
        buildOpening();
      }

      updateCycle();
      if (!tickChanged) { requestAnimationFrame(mainLoop); return; }

      updatePhase(curTick);
      detectIncoming();
      if (underAttack) retreat();

      processOpening();
      processExpansion();
      processCombat();
      processBoats();

      // GUI update every 5 ticks
      guiCounter++;
      if (guiCounter >= 5) {
        guiCounter = 0;
        updateGUI();
      }
    } catch (e) {
      // SILENT â€” game error handler would show popup otherwise
    }

    requestAnimationFrame(mainLoop);
  }

  /* ================================================================
   *  INIT
   * ================================================================ */
  try {
    createGUI();
    requestAnimationFrame(mainLoop);
    console.log('%c[MESSIAH v5] Fully automatic â€” zero toggles', 'color:#f59e0b;font-weight:bold;font-size:14px');
  } catch (e) {
    // Absolute last resort fallback â€” retry in 1 second
    setTimeout(function () {
      try { createGUI(); requestAnimationFrame(mainLoop); } catch (e2) { /* */ }
    }, 1000);
  }

  // Debug helper
  window.EchoAPI = {
    ready: function () { return ready; },
    debug: function () {
      console.log('%c[MESSIAH v5]', 'color:#f59e0b;font-weight:bold;font-size:14px');
      console.log('  ownId:', ownId, 'tick:', curTick, 'mapLand:', totalMapLand());
      console.log('  troops:', troops(ownId), 'land:', land(ownId), 'density:', density(ownId).toFixed(1));
      console.log('  phase:', phaseName, 'divisor:', phaseDivisor);
      console.log('  income:', myIncomeRate(), 'enemies:', getEnemies().length);
      console.log('  neutralId:', neutralId(), 'arraySize:', gm ? gm.arraySize : '?');
    }
  };

})();