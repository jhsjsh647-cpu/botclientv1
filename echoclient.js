/* ================================================================
 *  MESSIAH v5 â€” ECHO Style Merge
 *  ----------------------------------------------------------------
 *  Old ECHO GUI style (purple/Rajdhani) + Old Opening (exact ticks)
 *  + MESSIAH engines (SpeedBoost/Combat/Defense/Boat/Expansion)
 *  + Improved Micro attack formula
 *  + IIFE wrapper (no global pollution, no WindowManager conflict)
 *  + All init delayed until game is running
 * ================================================================
 */

(function () {
  'use strict';

  /* â”€â”€ Error suppression: never leak to game popup â”€â”€ */
  var _origOnError = window.onerror;
  window.onerror = function (msg, url, line, col, err) {
    if (url && url.indexOf('echoclient') !== -1) {
      try { console.log('[MESSIAH] Suppressed: ' + msg); } catch (x) {}
      return true;
    }
    return _origOnError ? _origOnError(msg, url, line, col, err) : false;
  };

  /* ================================================================
   *  CONSTANTS
   * ================================================================ */
  var M = {
    UNIT_MAX: 1023,
    ATTACK_TAX: 12,
    BOAT_TAX: 32,
    INCOME_INTERVAL: 10,
    INCOME_TICK: 9,
    AUG_END: 1920,
    BOAT_CD: 30,
    DENSITY_SOFT: 100,
    DENSITY_HARD: 150,
    DENSITY_PERFECT_LO: 93,
    DENSITY_PERFECT_HI: 100,
    PHASE_BLITZ: 357,
    PHASE_FAST: 714,
    PHASE_MEDIUM: 1071,
    PHASE_SLOW: 2142,
    PHASE_VSLOW: 3213
  };

  /* ================================================================
   *  STATE
   * ================================================================ */
  var state = {
    active: false,
    started: false,
    tick: 0,
    ownId: -1,
    neutralId: -1,
    mapLand: 0,
    troops: 0,
    land: 0,
    income: 0,
    phase: 'WAIT',
    cycleTick: 0,
    openingDone: false,
    lastBoatTick: -999,
    enemyCache: {},
    threatLevel: 0,
    totalAttacks: 0,
    retreatMode: false
  };

  /* ================================================================
   *  SETTINGS
   * ================================================================ */
  var cfg = {
    /* Opening */
    autoOpen: false,
    /* Engines */
    expansionEnabled: true,
    combatEnabled: true,
    defenseEnabled: true,
    speedboostEnabled: true,
    boatEnabled: true,
    /* Micro */
    microUseFormula: false,
    microAttackPercent: 12,
    microIntervalMs: 400,
    legitMode: false,
    /* Combat */
    attackPercent: 50,
    boatPercent: 30,
    retreatThreshold: 40,
    hoardPercent: 60,
    maxAttackTargets: 3
  };

  /* ================================================================
   *  SAFE API WRAPPER
   * ================================================================ */
  var API = {
    _s: function (n, fn) {
      try { return fn(); } catch (e) {
        try { console.log('[M5] API.' + n + ': ' + e.message); } catch (x) {}
        return null;
      }
    },
    ownId: function ()      { return this._s('ownId', function () { return window.gameManager.OwnPlayerId; }); },
    neutralId: function ()  { return this._s('neutralId', function () { return window.gameManager.yB; }); },
    mapLand: function ()   { return this._s('mapLand', function () { return window.gameManager.kD; }); },
    isStarted: function () { return this._s('isStarted', function () { return window.gameManager.isGameStarted ? window.gameManager.isGameStarted() : false; }); },
    tick: function ()       { return this._s('tick', function () { return window.gameLoop.getTick(); }); },
    troops: function (id)  { return this._s('troops', function () { return window.playerData.playerTroops[id]; }); },
    land: function (id)    { return this._s('land', function () { return window.playerData.landOwned[id]; }); },
    borders: function (id) { return this._s('borders', function () { return (window.playerData.gp && window.playerData.gp[id]) ? window.playerData.gp[id] : []; }); },
    income: function (id)  { return this._s('income', function () { return window.incomeManager.getPlayerIncomeRate(id); }); },
    arraySize: function () { return this._s('arraySize', function () { return window.gameManager.arraySize; }); },
    playerTiles: function (id) { return this._s('playerTiles', function () { return (window.playerData.playerTiles && window.playerData.playerTiles[id]) ? window.playerData.playerTiles[id] : []; }); },
    sendAttack: function (r, t) { return this._s('atk', function () { window.protocolHandler.gameCommandSender.attackTargetHandler(r, t); return true; }); },
    sendBoat: function (r, t)   { return this._s('boat', function () { window.protocolHandler.gameCommandSender.sendBoatHandler(r, t); return true; }); },
    cancelAttack: function (t)  { return this._s('cancel', function () { window.protocolHandler.gameCommandSender.cancelAttackHandler(t); return true; }); }
  };

  /* ================================================================
   *  UTILITY
   * ================================================================ */
  function p2v(pct) {
    var v = Math.round(M.UNIT_MAX * pct / 100);
    if (v < 1) v = 1;
    if (v > M.UNIT_MAX) v = M.UNIT_MAX;
    return v;
  }

  /* Old ECHO percentToValue â€” matches original opening tuning exactly */
  function percentToValue(p) {
    return Math.max(0, Math.min(1023, Math.floor(1024 * (p / 100) + 0.5) - 1));
  }

  function getPhase(tick) {
    if (tick < M.PHASE_BLITZ) return 'BLITZ';
    if (tick < M.PHASE_FAST) return 'FAST';
    if (tick < M.PHASE_MEDIUM) return 'MEDIUM';
    if (tick < M.PHASE_SLOW) return 'SLOW';
    if (tick < M.PHASE_VSLOW) return 'V.SLOW';
    return 'DEFENSE';
  }

  function getDensity() {
    return state.land > 0 ? Math.round((state.troops / state.land) * 100) : 0;
  }

  function canAfford(pct) {
    var cost = Math.ceil(state.troops * pct / 100 * M.ATTACK_TAX / 1024);
    return (state.troops - cost) > 0;
  }

  function perfectAttackPercent() {
    var d = getDensity();
    if (d >= M.DENSITY_PERFECT_LO && d <= M.DENSITY_PERFECT_HI) return cfg.attackPercent;
    if (d < M.DENSITY_SOFT) return Math.min(cfg.attackPercent + 20, 80);
    return Math.max(cfg.attackPercent - 20, 15);
  }

  /* ================================================================
   *  OLD OPENING â€” exact tick/percent values from ECHO v2
   * ================================================================ */
  var lastOpenTick = -1;

  function startAutoOpen(ticks) {
    try {
      var nid = state.neutralId > 0 ? state.neutralId : 512;
      switch (ticks) {
        /* Cycle 1: 144L, 799T */
        case 60:  API.sendAttack(percentToValue(20.800), nid); state.totalAttacks++; break;
        case 81:  API.sendAttack(percentToValue(17.871), nid); state.totalAttacks++; break;
        /* Cycle 2: 544L, 1045T */
        case 151: API.sendAttack(percentToValue(16.7),   nid); state.totalAttacks++; break;
        case 165: API.sendAttack(percentToValue(18.55),  nid); state.totalAttacks++; break;
        case 172: API.sendAttack(percentToValue(39.84),  nid); state.totalAttacks++; break;
        case 186: API.sendAttack(percentToValue(24.12),  nid); state.totalAttacks++; break;
        /* Cycle 3: 1104L, 1656T */
        case 256: API.sendAttack(percentToValue(0.1),    nid); state.totalAttacks++; break;
        case 263: API.sendAttack(percentToValue(22.3633),nid); state.totalAttacks++; break;
        case 270: API.sendAttack(percentToValue(52.54),  nid); state.totalAttacks++; break;
        case 284: API.sendAttack(percentToValue(29.98),  nid); state.totalAttacks++; break;
        /* Cycle 4: 2244L, 2484T */
        case 354: API.sendAttack(percentToValue(0.01),   nid); state.totalAttacks++; break;
        case 361: API.sendAttack(percentToValue(47.07),  nid); state.totalAttacks++; break;
        case 375: API.sendAttack(percentToValue(35.84),  nid); state.totalAttacks++; break;
        case 382: API.sendAttack(percentToValue(87.4),   nid); state.totalAttacks++; break;
        /* Cycle 5: 3784L, 4378T */
        case 452: API.sendAttack(percentToValue(28.61),  nid); state.totalAttacks++; break;
        case 466: API.sendAttack(percentToValue(23.73),  nid); state.totalAttacks++; break;
        case 473: API.sendAttack(percentToValue(31.64),  nid); state.totalAttacks++; break;
        case 480: API.sendAttack(percentToValue(71),     nid); state.totalAttacks++; break;
        default: break;
      }
      /* Mark opening done after last move */
      if (ticks >= 500) state.openingDone = true;
    } catch (e) {}
  }

  /* ================================================================
   *  PHASE / INCOME / CYCLE TRACKERS
   * ================================================================ */
  function updatePhase() {
    try {
      var t = API.tick();
      if (t === null) return;
      state.tick = t;
      state.phase = getPhase(t);
      state.cycleTick = t % M.INCOME_INTERVAL;
    } catch (e) {}
  }

  function updateCycle() {
    try {
      state.ownId = API.ownId();
      if (state.ownId === null || state.ownId < 0) return;
      state.neutralId = API.neutralId();
      state.mapLand = API.mapLand() || 0;
      state.troops = API.troops(state.ownId) || 0;
      state.land = API.land(state.ownId) || 0;
      state.income = API.income(state.ownId) || 0;
    } catch (e) {}
  }

  function isIncomeTick()  { return state.cycleTick === M.INCOME_TICK; }
  function isPreIncome()   { return state.cycleTick >= M.INCOME_INTERVAL - 3; }

  /* ================================================================
   *  DENSITY ANALYZER
   * ================================================================ */
  var Density = {
    get: function ()    { return getDensity(); },
    isLow: function ()  { return getDensity() < M.DENSITY_SOFT; },
    isPerfect: function () { var d = getDensity(); return d >= M.DENSITY_PERFECT_LO && d <= M.DENSITY_PERFECT_HI; },
    isOver: function () { return getDensity() > M.DENSITY_HARD; }
  };

  /* ================================================================
   *  BORDER INTELLIGENCE
   * ================================================================ */
  var BorderIntel = {
    getEnemyBorders: function () {
      try {
        var borders = API.borders(state.ownId);
        if (!borders || borders.length === 0) return [];
        var enemies = {};
        for (var i = 0; i < borders.length; i++) {
          var pid = borders[i];
          if (pid === state.ownId) continue;
          enemies[pid] = (enemies[pid] || 0) + 1;
        }
        var result = [];
        for (var eid in enemies) {
          result.push({ id: parseInt(eid), shared: enemies[eid] });
        }
        result.sort(function (a, b) { return b.shared - a.shared; });
        return result;
      } catch (e) { return []; }
    },
    updateCache: function () {
      try {
        var enemies = this.getEnemyBorders();
        for (var i = 0; i < enemies.length; i++) {
          var e = enemies[i];
          var old = state.enemyCache[e.id];
          state.enemyCache[e.id] = {
            shared: e.shared,
            troops: API.troops(e.id) || 0,
            land: API.land(e.id) || 0,
            prevTroops: old ? old.troops : 0,
            prevLand: old ? old.land : 0
          };
        }
        this.calcThreat();
      } catch (e) {}
    },
    calcThreat: function () {
      try {
        var maxThreat = 0;
        for (var id in state.enemyCache) {
          var e = state.enemyCache[id];
          if (id == state.neutralId) continue;
          var delta = e.troops - (e.prevTroops || 0);
          if (delta > 0 && e.shared > 3) {
            var threat = (delta / Math.max(state.troops, 1)) * 100;
            if (threat > maxThreat) maxThreat = threat;
          }
        }
        state.threatLevel = Math.min(100, Math.round(maxThreat));
      } catch (e) {}
    },
    getWeakestEnemy: function () {
      try {
        var enemies = this.getEnemyBorders();
        var best = null;
        for (var i = 0; i < enemies.length; i++) {
          var e = enemies[i];
          if (e.id === state.neutralId) continue;
          var t = API.troops(e.id) || 0;
          var l = API.land(e.id) || 0;
          if (l <= 0) continue;
          var density = t / l;
          if (!best || density < best.density) {
            best = { id: e.id, troops: t, land: l, density: density, shared: e.shared };
          }
        }
        return best;
      } catch (e) { return null; }
    },
    getBiggestEnemy: function () {
      try {
        var enemies = this.getEnemyBorders();
        var best = null;
        for (var i = 0; i < enemies.length; i++) {
          var e = enemies[i];
          if (e.id === state.neutralId) continue;
          var l = API.land(e.id) || 0;
          if (!best || l > best.land) {
            best = { id: e.id, land: l, troops: API.troops(e.id) || 0, shared: e.shared };
          }
        }
        return best;
      } catch (e) { return null; }
    }
  };

  /* ================================================================
   *  MESSIAH ENGINES
   * ================================================================ */

  /* â”€â”€ Expansion Engine â”€â”€ */
  function runExpansion() {
    try {
      if (!cfg.expansionEnabled || state.phase === 'DEFENSE' || Density.isOver()) return;
      if (!isPreIncome() || state.neutralId <= 0) return;
      var pct = perfectAttackPercent();
      if (Density.isLow()) pct = Math.min(pct + 10, 85);
      if (canAfford(pct)) { API.sendAttack(p2v(pct), state.neutralId); state.totalAttacks++; }
    } catch (e) {}
  }

  /* â”€â”€ Combat Engine â”€â”€ */
  function runCombat() {
    try {
      if (!cfg.combatEnabled || state.phase === 'BLITZ') return;
      if (state.cycleTick < 5 || state.cycleTick > 7) return;
      var weakest = BorderIntel.getWeakestEnemy();
      if (!weakest) return;
      var pct = cfg.attackPercent;
      if (weakest.density < 50) pct = Math.min(pct + 20, 90);
      if (weakest.troops > state.troops * 0.7) pct = Math.max(pct - 15, 20);
      if (canAfford(pct)) { API.sendAttack(p2v(pct), weakest.id); state.totalAttacks++; }
      var biggest = BorderIntel.getBiggestEnemy();
      if (biggest && biggest.id !== weakest.id && biggest.shared > 5) {
        var pct2 = Math.round(pct * 0.6);
        if (canAfford(pct2)) { API.sendAttack(p2v(pct2), biggest.id); state.totalAttacks++; }
      }
    } catch (e) {}
  }

  /* â”€â”€ Defense Engine â”€â”€ */
  function runDefense() {
    try {
      if (!cfg.defenseEnabled) return;
      if (state.threatLevel < cfg.retreatThreshold) { state.retreatMode = false; return; }
      state.retreatMode = true;
      for (var id in state.enemyCache) {
        var e = state.enemyCache[id];
        if (id == state.neutralId) continue;
        if (e.troops > state.troops * 0.5 && e.shared > 5) API.cancelAttack(parseInt(id));
      }
      /* Auto-hoard in defense phase */
      if (state.phase === 'DEFENSE' && state.troops < state.land * 1.5) return;
      var borders = BorderIntel.getEnemyBorders();
      for (var i = 0; i < borders.length; i++) {
        if (borders[i].id !== state.neutralId) API.cancelAttack(borders[i].id);
      }
    } catch (e) {}
  }

  /* â”€â”€ SpeedBoost Engine (AUTOMATIC) â”€â”€ */
  function runSpeedBoost() {
    try {
      if (!cfg.speedboostEnabled) return;
      var boost = false;
      if (state.phase === 'BLITZ' || state.phase === 'FAST') boost = true;
      if (Density.isLow() && state.phase !== 'DEFENSE') boost = true;
      if (state.threatLevel > 50 || Density.isOver()) boost = false;
      if (boost && state.neutralId > 0 && canAfford(15)) {
        API.sendAttack(p2v(15), state.neutralId);
        state.totalAttacks++;
      }
    } catch (e) {}
  }

  /* â”€â”€ Boat Engine â”€â”€ */
  function runBoat() {
    try {
      if (!cfg.boatEnabled) return;
      if (state.tick - state.lastBoatTick < M.BOAT_CD || Density.isOver()) return;
      var weakest = BorderIntel.getWeakestEnemy();
      if (!weakest || weakest.density < 40) return;
      if (canAfford(cfg.boatPercent)) {
        API.sendBoat(p2v(cfg.boatPercent), weakest.id);
        state.lastBoatTick = state.tick;
        state.totalAttacks++;
      }
    } catch (e) {}
  }

  /* ================================================================
   *  MICRO SYSTEM (improved attack formula)
   * ================================================================ */
  var micro = {
    isAttacking: false,
    attackQueue: [],
    lastAttack: {},
    activeTargets: {},
    interval: null
  };

  var MICRO_MAX_DENSITY = 0.5;
  var MICRO_MAX_PER_CYCLE = 1;
  var MICRO_DELAY_MS = 1;
  var MICRO_MIN_INTERVAL = 5000;

  /* Old ECHO findBorderingIds â€” precise shared-border detection */
  function findBorderingIds(myCells, allBorders, offsets, totalPlayers, myId) {
    if (!myCells || !allBorders || !offsets) return {};
    var cellSet = {}; /* using object as Set for compat */
    for (var i = 0; i < myCells.length; i++) cellSet[myCells[i]] = true;
    var neighbors = {};
    for (var p = 0; p < totalPlayers; p++) {
      if (p === myId || !allBorders[p]) continue;
      var shared = 0;
      var enemyTiles = allBorders[p];
      for (var t = 0; t < enemyTiles.length; t++) {
        var c = enemyTiles[t];
        for (var d = 0; d < offsets.length; d++) {
          if (cellSet[c - offsets[d]]) { shared++; break; }
        }
      }
      if (shared > 0) neighbors[p] = shared;
    }
    return neighbors;
  }

  /**
   * IMPROVED ATTACK FORMULA
   * Calculates optimal % to send based on:
   *   - Enemy troops to overcome
   *   - Enemy land to conquer (each tile costs gS=2 troops)
   *   - Attack tax (12/1024 lost per attack)
   *   - Your current density (don't overcommit if low)
   *   - Shared border ratio (more border = more efficient attack)
   */
  function calcMicroPercent(enemy, myTroops, myLand) {
    var CONQUEST_COST = 2; /* gameManager.gS */
    var TAX_RATE = M.ATTACK_TAX / 1024; /* ~1.17% */

    /* Troops needed to conquer all enemy land and overcome their troops */
    var conquestNeeded = enemy.land * CONQUEST_COST;
    var troopNeeded = enemy.troops * 1.15; /* 15% buffer over enemy troops */
    var totalNeeded = conquestNeeded + troopNeeded;

    /* Account for attack tax: sent troops * (1 - TAX_RATE) = arriving troops */
    var sentNeeded = totalNeeded / (1 - TAX_RATE);

    /* Convert to percentage of our troops */
    var pct = (sentNeeded / Math.max(1, myTroops)) * 100;

    /* Density-based cap: don't send too much if we're already low */
    var myDensity = myLand > 0 ? myTroops / myLand : 999;
    var maxPct;
    if (myDensity > 100) maxPct = 50;
    else if (myDensity > 60) maxPct = 65;
    else if (myDensity > 30) maxPct = 80;
    else maxPct = 90;

    /* Border efficiency bonus: more shared border = we can send less (more tiles hit per troop) */
    var borderBonus = 1.0;
    if (enemy.sharedBorderCount > 10) borderBonus = 0.85;
    if (enemy.sharedBorderCount > 20) borderBonus = 0.75;

    pct = pct * borderBonus;
    pct = Math.max(3, Math.min(maxPct, Math.round(pct)));
    return pct;
  }

  function processMicroQueue(myTroops, myLand) {
    try {
      if (micro.isAttacking || micro.attackQueue.length === 0) return;
      micro.isAttacking = true;
      var sent = 0;
      while (micro.attackQueue.length > 0 && sent < MICRO_MAX_PER_CYCLE) {
        var enemy = micro.attackQueue.shift();
        if (!enemy) continue;
        var now = Date.now();
        var last = micro.lastAttack[enemy.id] || 0;
        if (now - last < MICRO_MIN_INTERVAL) continue;

        var percent;
        if (cfg.microUseFormula) {
          percent = calcMicroPercent(enemy, myTroops, myLand);
        } else {
          percent = cfg.microAttackPercent;
        }

        API.sendAttack(percentToValue(percent), enemy.id);
        micro.lastAttack[enemy.id] = now;
        micro.activeTargets[enemy.id] = true;
        sent++;
        state.totalAttacks++;
      }
      micro.isAttacking = false;
    } catch (e) { micro.isAttacking = false; }
  }

  function runMicro() {
    try {
      if (!window.gameManager || !window.playerData || !window.mapData) return;
      var playerData = window.playerData;
      var mapData = window.mapData;
      var troopData = playerData.playerTroops;
      var landData = playerData.landOwned;
      var allTiles = playerData.playerTiles;
      var offsets = mapData.neighborOffsets;
      if (!troopData || !landData || !allTiles || !offsets) return;

      var myId = state.ownId;
      if (myId < 0 || !allTiles[myId]) return;
      var myTroops = troopData[myId] || 1;
      var myLand = landData[myId] || 1;

      /* Clean dead targets */
      for (var tid in micro.activeTargets) {
        var tidi = parseInt(tid);
        if (!landData[tidi] || landData[tidi] === 0) {
          delete micro.activeTargets[tid];
          delete micro.lastAttack[tid];
        }
      }

      /* Find bordering enemies */
      var borderNeighbors = findBorderingIds(
        allTiles[myId], allTiles, offsets, API.arraySize() || 512, myId
      );

      /* Build candidates (filter by density) */
      var candidates = [];
      for (var eid in borderNeighbors) {
        var eidi = parseInt(eid);
        var troops = troopData[eidi];
        var land = landData[eidi];
        if (troops == null || troops === 0) continue;
        if (land > 0 && troops / land > MICRO_MAX_DENSITY) continue;
        candidates.push({ id: eidi, troops: troops, land: land, sharedBorderCount: borderNeighbors[eid] });
      }
      candidates.sort(function (a, b) { return b.sharedBorderCount - a.sharedBorderCount; });
      micro.attackQueue = candidates;

      if (micro.attackQueue.length > 0 && !micro.isAttacking) {
        processMicroQueue(myTroops, myLand);
      }
    } catch (e) {}
  }

  function startAutoAttack() {
    if (micro.interval) return;
    runMicro();
    micro.interval = setInterval(runMicro, cfg.microIntervalMs);
    updateMicroStatus(true);
  }

  function stopAutoAttack() {
    clearInterval(micro.interval);
    micro.interval = null;
    micro.attackQueue = [];
    micro.isAttacking = false;
    updateMicroStatus(false);
  }

  /* ================================================================
   *  BOT BRAIN
   * ================================================================ */
  function brainRun() {
    try {
      if (!state.started) return;
      updatePhase();
      updateCycle();
      if (state.tick <= 0 || state.ownId < 0) return;

      /* Old Opening */
      if (cfg.autoOpen && state.tick !== lastOpenTick && !state.openingDone) {
        lastOpenTick = state.tick;
        startAutoOpen(state.tick);
      }

      /* MESSIAH Engines */
      BorderIntel.updateCache();
      runDefense();
      runSpeedBoost();
      runExpansion();
      runCombat();
      runBoat();
    } catch (e) {
      try { console.log('[M5] Brain: ' + e.message); } catch (x) {}
    }
  }

  /* ================================================================
   *  GUI â€” Old ECHO Purple Style
   * ================================================================ */
  var gui = { panel: null, visible: false, currentTab: 'opening' };

  function updateMicroStatus(active) {
    try {
      var el = document.getElementById('micro-status');
      var sb = document.getElementById('micro-start-btn');
      if (el) { el.textContent = active ? 'ACTIVE' : 'INACTIVE'; el.className = 'eg-status ' + (active ? 'on' : 'off'); }
      if (sb) sb.classList.toggle('active', active);
    } catch (e) {}
  }

  function createGUI() {
    try {
      if (gui.panel) return;

      /* Load font */
      if (!document.getElementById('echo-font')) {
        var link = document.createElement('link');
        link.id = 'echo-font';
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500&display=swap';
        document.head.appendChild(link);
      }

      /* CSS */
      var style = document.createElement('style');
      style.id = 'echo-gui-style';
      style.textContent = `
        :root {
          --eg-bg: #0d0b14; --eg-surface: #13101e; --eg-border: #2a1f4a;
          --eg-accent: #7c3aed; --eg-accent2: #a855f7; --eg-text: #c4b5fd;
          --eg-muted: #6d5d8a; --eg-toggle-off: #2e2040;
        }
        #echo-gui * { box-sizing: border-box; margin: 0; padding: 0; }
        #echo-gui {
          position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
          width: 280px; max-width: calc(100vw - 16px); max-height: calc(100vh - 80px);
          background: var(--eg-bg); border: 1px solid var(--eg-border); border-radius: 10px;
          color: var(--eg-text); font-family: Inter, sans-serif; font-size: 13px;
          box-shadow: 0 0 0 1px #7c3aed22, 0 8px 32px #0007, inset 0 1px 0 #ffffff08;
          display: none; z-index: 999999; user-select: none; -webkit-user-select: none;
          overflow: hidden; touch-action: none;
        }
        #eg-titlebar {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 14px; background: var(--eg-surface);
          border-bottom: 1px solid var(--eg-border); cursor: move;
          touch-action: none; min-height: 44px;
        }
        #eg-logo {
          font-family: Rajdhani, sans-serif; font-weight: 700; font-size: 15px;
          letter-spacing: 2px; color: var(--eg-accent2);
          text-shadow: 0 0 12px #a855f766; pointer-events: none;
        }
        #eg-close {
          width: 32px; height: 32px; background: #3b2060; border: none; border-radius: 6px;
          color: var(--eg-text); cursor: pointer; font-size: 14px;
          display: flex; align-items: center; justify-content: center;
          min-width: 44px; min-height: 44px; -webkit-tap-highlight-color: transparent;
        }
        #eg-close:hover, #eg-close:active { background: var(--eg-accent); color: #fff; }
        #eg-tabs {
          display: flex; background: var(--eg-surface); border-bottom: 1px solid var(--eg-border);
        }
        .eg-tab {
          flex: 1; padding: 10px 0; text-align: center;
          font-family: Rajdhani, sans-serif; font-weight: 600; font-size: 11px;
          letter-spacing: 1px; text-transform: uppercase; color: var(--eg-muted);
          cursor: pointer; border-bottom: 2px solid transparent;
          -webkit-tap-highlight-color: transparent; min-height: 44px;
          display: flex; align-items: center; justify-content: center;
        }
        .eg-tab:hover, .eg-tab:active { color: var(--eg-text); }
        .eg-tab.active { color: var(--eg-accent2); border-bottom-color: var(--eg-accent); }
        #eg-content { padding: 10px 14px 14px; overflow-y: auto; max-height: calc(100vh - 180px); -webkit-overflow-scrolling: touch; }
        .eg-panel { display: none; } .eg-panel.active { display: block; }
        .eg-section {
          font-family: Rajdhani, sans-serif; font-weight: 700; font-size: 10px;
          letter-spacing: 2px; text-transform: uppercase; color: var(--eg-accent);
          margin: 10px 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--eg-border);
        }
        .eg-section:first-child { margin-top: 2px; }
        .eg-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; min-height: 44px; }
        .eg-label { font-size: 13px; color: #d8caff; font-weight: 400; }
        .eg-toggle-wrap { position: relative; width: 44px; height: 26px; flex-shrink: 0; }
        .eg-toggle-wrap input { opacity: 0; width: 0; height: 0; position: absolute; }
        .eg-toggle-track {
          position: absolute; inset: 0; background: var(--eg-toggle-off);
          border-radius: 26px; cursor: pointer; transition: background .2s; border: 1px solid #3d2d5e;
        }
        .eg-toggle-track::after {
          content: ""; position: absolute; width: 20px; height: 20px;
          top: 2px; left: 2px; background: var(--eg-muted); border-radius: 50%;
          transition: transform .2s, background .2s;
        }
        .eg-toggle-wrap input:checked + .eg-toggle-track { background: var(--eg-accent); border-color: var(--eg-accent); }
        .eg-toggle-wrap input:checked + .eg-toggle-track::after { transform: translateX(18px); background: #fff; }
        .eg-slider-wrap { display: flex; flex-direction: column; padding: 6px 0 8px; gap: 6px; }
        .eg-slider-header { display: flex; justify-content: space-between; align-items: center; }
        .eg-slider-val { font-family: Rajdhani, sans-serif; font-weight: 600; font-size: 12px; color: var(--eg-accent2); }
        .eg-slider {
          -webkit-appearance: none; appearance: none; width: 100%; height: 4px;
          border-radius: 4px; background: var(--eg-border); outline: none; cursor: pointer;
        }
        .eg-slider::-webkit-slider-thumb {
          -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%;
          background: var(--eg-accent2); cursor: pointer; box-shadow: 0 0 6px #a855f766;
        }
        .eg-slider::-moz-range-thumb {
          width: 22px; height: 22px; border-radius: 50%; background: var(--eg-accent2);
          cursor: pointer; border: none;
        }
        .eg-slider:disabled { opacity: 0.35; cursor: not-allowed; }
        .eg-btn-row { display: flex; gap: 8px; padding: 8px 0 4px; margin-top: 14px; }
        .eg-btn {
          flex: 1; padding: 12px 0; border: 1px solid var(--eg-border); border-radius: 6px;
          background: var(--eg-surface); color: var(--eg-text); font-family: Rajdhani, sans-serif;
          font-weight: 600; font-size: 12px; letter-spacing: 1px; text-transform: uppercase;
          cursor: pointer; min-height: 44px; display: flex; align-items: center;
          justify-content: center; -webkit-tap-highlight-color: transparent;
        }
        .eg-btn:hover, .eg-btn:active { background: var(--eg-border); }
        .eg-btn.active { background: var(--eg-accent); border-color: var(--eg-accent); color: #fff; }
        .eg-status {
          font-family: Rajdhani, sans-serif; font-size: 11px; letter-spacing: 1px;
          text-align: center; padding: 4px 0 0; color: var(--eg-muted);
        }
        .eg-status.on { color: #4CAF50; } .eg-status.off { color: #f44336; }
        .eg-status-row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 11px; }
        .eg-status-key { color: var(--eg-muted); }
        .eg-status-val { color: var(--eg-text); font-weight: 500; }
        #echo-mobile-toggle {
          position: fixed; bottom: 20px; right: 20px; width: 44px; height: 44px;
          background: linear-gradient(135deg, #7c3aed, #a855f7); border: 2px solid #a855f766;
          border-radius: 12px; color: #fff; font-family: Rajdhani, sans-serif;
          font-weight: 700; font-size: 18px; display: flex; align-items: center;
          justify-content: center; z-index: 999998; cursor: pointer;
          box-shadow: 0 2px 12px #7c3aed88, 0 0 20px #a855f733;
          touch-action: none; -webkit-tap-highlight-color: transparent;
          user-select: none; -webkit-user-select: none; transition: transform 0.1s;
        }
        #echo-mobile-toggle:active { transform: scale(0.92); }
      `;
      document.head.appendChild(style);

      /* Build GUI */
      var panel = document.createElement('div');
      panel.id = 'echo-gui';
      panel.innerHTML = `
        <div id="eg-titlebar">
          <span id="eg-logo">MESSIAH</span>
          <button id="eg-close">\u2715</button>
        </div>
        <div id="eg-tabs">
          <div class="eg-tab active" data-tab="opening">Opening</div>
          <div class="eg-tab" data-tab="micro">Micro</div>
          <div class="eg-tab" data-tab="engines">Engines</div>
        </div>
        <div id="eg-content">
          <!-- OPENING TAB -->
          <div class="eg-panel active" id="panel-opening">
            <div class="eg-section">Auto Opening</div>
            <div class="eg-row">
              <span class="eg-label">Auto Opening</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-auto-open"><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-section">Status</div>
            <div id="opening-status-info"></div>
          </div>
          <!-- MICRO TAB -->
          <div class="eg-panel" id="panel-micro">
            <div class="eg-section">Auto Attack</div>
            <div class="eg-row">
              <span class="eg-label">Attack Formula</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-formula"><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-slider-wrap">
              <div class="eg-slider-header">
                <span class="eg-label">Attack Percent</span>
                <span class="eg-slider-val" id="opt-pct-val">12%</span>
              </div>
              <input class="eg-slider" type="range" id="opt-pct" min="1" max="30" value="12">
            </div>
            <div class="eg-slider-wrap">
              <div class="eg-slider-header">
                <span class="eg-label">Interval</span>
                <span class="eg-slider-val" id="opt-interval-val">400ms</span>
              </div>
              <input class="eg-slider" type="range" id="opt-interval" min="100" max="667" value="400">
            </div>
            <div class="eg-btn-row">
              <button class="eg-btn" id="micro-start-btn">Start (Q)</button>
              <button class="eg-btn" id="micro-stop-btn">Stop (E)</button>
            </div>
            <div class="eg-status off" id="micro-status">INACTIVE</div>
            <div class="eg-section">Legit</div>
            <div class="eg-row">
              <span class="eg-label">Legit Mode</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-legit"><span class="eg-toggle-track"></span></label>
            </div>
          </div>
          <!-- ENGINES TAB -->
          <div class="eg-panel" id="panel-engines">
            <div class="eg-section">Bot</div>
            <div class="eg-row">
              <span class="eg-label">Bot Active</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-bot-active" checked><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-section">Engines</div>
            <div class="eg-row">
              <span class="eg-label">SpeedBoost</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-speedboost" checked><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-row">
              <span class="eg-label">Expansion</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-expansion" checked><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-row">
              <span class="eg-label">Combat</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-combat" checked><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-row">
              <span class="eg-label">Defense</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-defense" checked><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-row">
              <span class="eg-label">Boat</span>
              <label class="eg-toggle-wrap"><input type="checkbox" id="opt-boat" checked><span class="eg-toggle-track"></span></label>
            </div>
            <div class="eg-section">Config</div>
            <div class="eg-slider-wrap">
              <div class="eg-slider-header">
                <span class="eg-label">Attack %</span>
                <span class="eg-slider-val" id="opt-atk-pct-val">50%</span>
              </div>
              <input class="eg-slider" type="range" id="opt-atk-pct" min="10" max="90" value="50">
            </div>
            <div class="eg-slider-wrap">
              <div class="eg-slider-header">
                <span class="eg-label">Boat %</span>
                <span class="eg-slider-val" id="opt-boat-pct-val">30%</span>
              </div>
              <input class="eg-slider" type="range" id="opt-boat-pct" min="10" max="80" value="30">
            </div>
            <div class="eg-slider-wrap">
              <div class="eg-slider-header">
                <span class="eg-label">Retreat At</span>
                <span class="eg-slider-val" id="opt-retreat-val">40%</span>
              </div>
              <input class="eg-slider" type="range" id="opt-retreat" min="10" max="80" value="40">
            </div>
            <div class="eg-section">Info</div>
            <div id="engine-status-info"></div>
          </div>
        </div>
      `;
      document.body.appendChild(panel);
      gui.panel = panel;

      /* Mobile toggle */
      var toggle = document.createElement('div');
      toggle.id = 'echo-mobile-toggle';
      toggle.textContent = 'M';
      document.body.appendChild(toggle);

      /* â”€â”€ Wire events â”€â”€ */
      wireGUI(panel, toggle);
    } catch (e) {
      try { console.log('[M5] GUI create error: ' + e.message); } catch (x) {}
    }
  }

  function wireGUI(panel, toggleBtn) {
    try {
      /* Close */
      var closeBtn = document.getElementById('eg-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { toggleGUI(); });

      /* Mobile toggle */
      if (toggleBtn) toggleBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleGUI(); });

      /* Drag titlebar */
      var bar = document.getElementById('eg-titlebar');
      var ox = 0, oy = 0, dragging = false;
      bar.addEventListener('mousedown', function (e) {
        if (e.target.id === 'eg-close') return;
        dragging = true; var r = panel.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return; e.preventDefault();
        panel.style.left = e.clientX - ox + 'px'; panel.style.top = e.clientY - oy + 'px'; panel.style.transform = 'none';
      });
      document.addEventListener('mouseup', function () { dragging = false; });
      bar.addEventListener('touchstart', function (e) {
        if (e.target.id === 'eg-close') return;
        var t = e.touches[0]; var r = panel.getBoundingClientRect(); ox = t.clientX - r.left; oy = t.clientY - r.top; dragging = true;
      }, { passive: true });
      bar.addEventListener('touchmove', function (e) {
        if (!dragging) return; e.preventDefault(); var t = e.touches[0];
        var nx = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, t.clientX - ox));
        var ny = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, t.clientY - oy));
        panel.style.left = nx + 'px'; panel.style.top = ny + 'px'; panel.style.transform = 'none';
      }, { passive: false });
      bar.addEventListener('touchend', function () { dragging = false; });

      /* Touch guard inside GUI */
      panel.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

      /* Mobile toggle drag */
      var tdrag = false, tox = 0, toy = 0, tmoved = false;
      toggleBtn.addEventListener('touchstart', function (e) {
        var t = e.touches[0]; var r = toggleBtn.getBoundingClientRect();
        tox = t.clientX - r.left; toy = t.clientY - r.top; tdrag = true; tmoved = false;
      }, { passive: true });
      toggleBtn.addEventListener('touchmove', function (e) {
        if (!tdrag) return; e.preventDefault(); tmoved = true; var t = e.touches[0];
        toggleBtn.style.left = Math.max(0, Math.min(window.innerWidth - 44, t.clientX - tox)) + 'px';
        toggleBtn.style.top = Math.max(0, Math.min(window.innerHeight - 44, t.clientY - toy)) + 'px';
        toggleBtn.style.right = 'auto'; toggleBtn.style.bottom = 'auto';
      }, { passive: false });
      toggleBtn.addEventListener('touchend', function (e) { tdrag = false; if (tmoved) { e.preventDefault(); e.stopPropagation(); } });

      /* Tabs */
      var tabs = panel.querySelectorAll('.eg-tab');
      for (var i = 0; i < tabs.length; i++) {
        (function (tab) {
          tab.addEventListener('click', function () {
            for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
            var panels = panel.querySelectorAll('.eg-panel');
            for (var j = 0; j < panels.length; j++) panels[j].classList.remove('active');
            tab.classList.add('active');
            var p = panel.querySelector('#panel-' + tab.dataset.tab);
            if (p) p.classList.add('active');
            gui.currentTab = tab.dataset.tab;
          });
        })(tabs[i]);
      }

      /* Opening toggle */
      bindToggle('opt-auto-open', function (v) { cfg.autoOpen = v; });

      /* Micro toggles */
      bindToggle('opt-formula', function (v) {
        cfg.microUseFormula = v;
        var ps = document.getElementById('opt-pct');
        if (ps) ps.disabled = v;
      });
      bindToggle('opt-legit', function (v) { cfg.legitMode = v; });

      /* Micro sliders */
      bindSlider('opt-pct', 'opt-pct-val', function (v) { cfg.microAttackPercent = v; }, '%');
      bindSlider('opt-interval', 'opt-interval-val', function (v) {
        cfg.microIntervalMs = v;
        if (micro.interval) { clearInterval(micro.interval); micro.interval = setInterval(runMicro, cfg.microIntervalMs); }
      }, 'ms');

      /* Micro buttons */
      var startBtn = document.getElementById('micro-start-btn');
      var stopBtn = document.getElementById('micro-stop-btn');
      if (startBtn) startBtn.addEventListener('click', startAutoAttack);
      if (stopBtn) stopBtn.addEventListener('click', stopAutoAttack);

      /* Engine toggles */
      bindToggle('opt-bot-active', function (v) { state.active = v; });
      bindToggle('opt-speedboost', function (v) { cfg.speedboostEnabled = v; });
      bindToggle('opt-expansion', function (v) { cfg.expansionEnabled = v; });
      bindToggle('opt-combat', function (v) { cfg.combatEnabled = v; });
      bindToggle('opt-defense', function (v) { cfg.defenseEnabled = v; });
      bindToggle('opt-boat', function (v) { cfg.boatEnabled = v; });

      /* Config sliders */
      bindSlider('opt-atk-pct', 'opt-atk-pct-val', function (v) { cfg.attackPercent = v; }, '%');
      bindSlider('opt-boat-pct', 'opt-boat-pct-val', function (v) { cfg.boatPercent = v; }, '%');
      bindSlider('opt-retreat', 'opt-retreat-val', function (v) { cfg.retreatThreshold = v; }, '%');
    } catch (e) {
      try { console.log('[M5] Wire error: ' + e.message); } catch (x) {}
    }
  }

  function bindToggle(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function () { fn(el.checked); });
  }

  function bindSlider(id, valId, fn, unit) {
    var el = document.getElementById(id);
    var valEl = document.getElementById(valId);
    if (el) el.addEventListener('input', function () {
      var v = parseInt(el.value);
      fn(v);
      if (valEl) valEl.textContent = v + (unit || '');
    });
  }

  function toggleGUI() {
    try {
      gui.visible = !gui.visible;
      gui.panel.style.display = gui.visible ? 'block' : 'none';
      var tb = document.getElementById('echo-mobile-toggle');
      if (tb) tb.style.display = gui.visible ? 'none' : 'flex';
    } catch (e) {}
  }

  /* â”€â”€ Status update (runs every 500ms) â”€â”€ */
  var statusInterval = null;
  function updateStatus() {
    try {
      if (!gui.visible) return;
      /* Opening tab status */
      var oi = document.getElementById('opening-status-info');
      if (oi && gui.currentTab === 'opening') {
        var d = getDensity();
        oi.innerHTML =
          statusRow('Tick', state.tick) +
          statusRow('Phase', state.phase) +
          statusRow('Troops', state.troops.toLocaleString()) +
          statusRow('Land', state.land.toLocaleString()) +
          statusRow('Density', d + (d >= 93 && d <= 100 ? ' PERFECT' : '')) +
          statusRow('Income', state.income) +
          statusRow('Total Atks', state.totalAttacks) +
          statusRow('Opening', state.openingDone ? 'DONE' : 'RUNNING (' + Math.min(state.tick, 480) + '/480)');
      }
      /* Engines tab status */
      var ei = document.getElementById('engine-status-info');
      if (ei && gui.currentTab === 'engines') {
        ei.innerHTML =
          statusRow('Bot', state.active ? 'ON' : 'OFF') +
          statusRow('Threat', state.threatLevel + '%') +
          statusRow('Retreat', state.retreatMode ? 'YES' : 'no') +
          statusRow('Boat CD', Math.max(0, M.BOAT_CD - (state.tick - state.lastBoatTick)) + 't') +
          statusRow('Cycle', state.cycleTick + '/' + M.INCOME_INTERVAL);
      }
    } catch (e) {}
  }

  function statusRow(key, val) {
    return '<div class="eg-status-row"><span class="eg-status-key">' + key + '</span><span class="eg-status-val">' + val + '</span></div>';
  }

  /* ================================================================
   *  KEYBINDS
   * ================================================================ */
  document.addEventListener('keydown', function (e) {
    try {
      if (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type === 'text')) return;
      var key = e.key;
      if (key === 'o' || key === 'O') toggleGUI();
      if (key === 'q' || key === 'Q') { e.preventDefault(); startAutoAttack(); }
      if (key === 'e' || key === 'E') { e.preventDefault(); stopAutoAttack(); }
    } catch (x) {}
  });

  /* ================================================================
   *  GAME LOOP
   * ================================================================ */
  var botInterval = null;

  function startBot() {
    try {
      if (botInterval) return;
      state.started = true;
      state.active = true;
      createGUI();
      botInterval = setInterval(brainRun, 200);
      statusInterval = setInterval(updateStatus, 500);
      console.log('%c[MESSIAH v5] Bot started! Press O for GUI, Q/E for micro.', 'color:#a855f7;font-weight:bold;font-size:14px');
    } catch (e) {
      try { console.log('[M5] startBot: ' + e.message); } catch (x) {}
    }
  }

  /* â”€â”€ Wait for game â”€â”€ */
  var waitCount = 0;
  var waitInterval = setInterval(function () {
    try {
      waitCount++;
      if (waitCount > 300) { clearInterval(waitInterval); return; }
      if (!window.gameManager || !window.playerData || !window.protocolHandler || !window.gameLoop) return;
      if (!window.gameManager.isGameStarted || !window.gameManager.isGameStarted()) return;
      clearInterval(waitInterval);
      setTimeout(startBot, 500);
    } catch (e) {}
  }, 1000);

  console.log('%c[MESSIAH v5] Loaded. Waiting for game...', 'color:#a855f7;font-weight:bold');

})();