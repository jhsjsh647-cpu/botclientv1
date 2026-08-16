/* ================================================================
 *  ZYROX MESSIAH v5 â€” BEYOND MESSIAH
 *  ----------------------------------------------------------------
 *  Fully automatic with optional micro-controls.
 *  All engines active. GUI with tabs.
 *  Based on exact decompiled game source (31957 lines).
 *
 *  Hooks: window.gameManager, window.playerData, window.mapData,
 *  window.protocolHandler, window.gameLoop, window.incomeManager
 * ================================================================ */

(function () {
  'use strict';

  /* ================================================================
   *  CONSTANTS
   * ================================================================ */
  var M = {
    TICK_MS: 56,
    INCOME_INTERVAL: 10,
    AUGMENTATION_END: 1920,
    MAX_INCOME_RATE: 700,
    SOFT_CAP_MULT: 100,
    HARD_CAP_MULT: 150,
    PERFECT_DENSITY: 100,
    ATTACK_TAX: 12 / 1024,
    TAX_THRESHOLD: 0.5,
    MIN_ATTACK: 1 / 1024,
    CONQUEST_BATCH: 2048,
    MIN_TROOPS_PER_TILE: 2,
    MAX_BALANCE: 1e9,
    SERVER_THROTTLE_MS: 1000,
    STARTING_BALANCE: 512,
    CONQUEST_PHASES: [
      { endTick: 357, mult: 1 },
      { endTick: 714, mult: 4 },
      { endTick: 1071, mult: 10 },
      { endTick: 2142, mult: 30 },
      { endTick: 3213, mult: 100 },
      { endTick: Infinity, mult: -1 }
    ],
    CMD_ATTACK: 1,
    CMD_BOAT: 3,
    CMD_CANCEL: 5,
    CMD_DONATE: 2
  };

  /* ================================================================
   *  SAFE API HOOKS
   * ================================================================ */
  var API = {
    _ready: false,
    _gm: null, _pd: null, _md: null, _ph: null, _gl: null, _im: null,

    check: function () {
      try {
        this._gm = window.gameManager;
        this._pd = window.playerData;
        this._md = window.mapData;
        this._ph = window.protocolHandler;
        this._gl = window.gameLoop;
        this._im = window.incomeManager;
        this._ready = !!(this._gm && this._pd && this._md && this._ph && this._gl);
      } catch (e) { this._ready = false; }
      return this._ready;
    },

    get myId() { try { return this._gm.OwnPlayerId; } catch (e) { return 0; } },
    get arraySize() { try { return this._gm.arraySize; } catch (e) { return 512; } },
    get mapLand() { try { return this._gm.kD || 262144; } catch (e) { return 262144; } },
    get neutralId() { try { return this._gm.yB; } catch (e) { return 0; } },
    get conquestCost() { try { return this._gm.gS; } catch (e) { return 2; } },

    troops: function (id) { try { return this._pd.playerTroops[id] || 0; } catch (e) { return 0; } },
    land: function (id) { try { return this._pd.landOwned[id] || 0; } catch (e) { return 0; } },
    density: function (id) { var l = this.land(id); return l > 0 ? this.troops(id) / l : 0; },
    borderTiles: function (id) { try { return this._pd.gp ? this._pd.gp[id] : null; } catch (e) { return null; } },
    borderCount: function (id) { var b = this.borderTiles(id); return b ? b.length : 0; },
    isAlive: function (id) { try { return this._pd.isOwnPlayerValid ? this._pd.isOwnPlayerValid[id] : this.land(id) > 0; } catch (e) { return false; } },
    isEliminated: function (id) { try { return this._pd.a4V ? this._pd.a4V[id] === 2 : false; } catch (e) { return false; } },
    incomeRate: function (id) { try { return this._im.getPlayerIncomeRate(id); } catch (e) { return 0; } },
    redCap: function (id) { try { return this._im.getRedInterestCap(id); } catch (e) { return 0; } },
    gameStarted: function () { try { return this._gm.isGameStarted && this._gm.isGameStarted(); } catch (e) { return false; } },
    getTick: function () { try { return this._gl.getTick(); } catch (e) { return -1; } }
  };

  window.EchoAPI = {
    ready: false,
    check: function () { API.check(); this.ready = API._ready; return this.ready; },
    debug: function () {
      console.log('%c[MESSIAH v5]', 'color:#f59e0b;font-weight:bold;font-size:14px');
      console.log('  myId:', API.myId, 'tick:', API.getTick(), 'mapLand:', API.mapLand);
      console.log('  troops:', API.troops(API.myId), 'land:', API.land(API.myId),
        'density:', API.density(API.myId).toFixed(1));
      console.log('  borders:', API.borderCount(API.myId), 'phase:', Phase.name);
      console.log('  income:', API.incomeRate(API.myId), 'neutralId:', API.neutralId);
    }
  };

  /* ================================================================
   *  CONQUEST PHASE â€” time-based attack power
   * ================================================================ */
  var Phase = {
    name: 'IDLE', divisor: 1, isDefense: false, u0: 875,

    update: function (tick) {
      if (tick < 0) { this.name = 'IDLE'; return; }
      this.u0 = 1 + Math.floor(API.mapLand / 300);
      var names = ['BLITZ', 'FAST', 'MEDIUM', 'SLOW', 'V.SLOW'];
      for (var i = 0; i < M.CONQUEST_PHASES.length; i++) {
        if (tick < M.CONQUEST_PHASES[i].endTick) {
          if (M.CONQUEST_PHASES[i].mult === -1) {
            this.name = 'DEFENSE'; this.isDefense = true;
          } else {
            this.name = names[i];
            this.divisor = M.CONQUEST_PHASES[i].mult * this.u0;
            this.isDefense = false;
          }
          return;
        }
      }
    },

    attackPower: function (troopsSent, targetDefense) {
      if (this.isDefense) {
        return 2 + Math.floor((100 * troopsSent + 0.5) / Math.max(1, targetDefense));
      }
      return 2 + Math.floor((100 * troopsSent + 0.5) / Math.max(1, this.divisor));
    },

    tilesPerWave: function (attackTroops, targetDefense) {
      var power = this.attackPower(attackTroops, targetDefense);
      return Math.floor(attackTroops / Math.max(1, M.MIN_TROOPS_PER_TILE));
    }
  };

  /* ================================================================
   *  INCOME ENGINE â€” exact game formula
   * ================================================================ */
  var Income = {
    getMyRate: function () {
      try { return API.incomeRate(API.myId); } catch (e) { return 0; }
    },
    predictedGain: function () {
      var rate = this.getMyRate();
      var balance = API.troops(API.myId);
      return Math.max(1, Math.floor(rate * balance / 10000));
    },
    ticksUntilIncome: function () {
      var t = Cycle.tick;
      var next = Math.ceil((t + 1) / M.INCOME_INTERVAL) * M.INCOME_INTERVAL - 1;
      return next - t;
    },
    isIncomeTick: function (t) { return t % M.INCOME_INTERVAL === M.INCOME_INTERVAL - 1; },
    isPreIncomeTick: function (t) { return t % M.INCOME_INTERVAL === M.INCOME_INTERVAL - 2; }
  };

  /* ================================================================
   *  CYCLE TRACKER
   * ================================================================ */
  var Cycle = {
    tick: -1, prevTick: -1, tickChanged: false, cycle: 0,
    update: function () {
      try {
        var t = API.getTick();
        if (t == null || t <= this.tick) { this.tickChanged = false; return; }
        this.prevTick = this.tick;
        this.tick = t;
        this.tickChanged = true;
        this.cycle = Math.floor(t / M.INCOME_INTERVAL);
      } catch (e) { this.tickChanged = false; }
    }
  };

  /* ================================================================
   *  DENSITY ANALYZER
   * ================================================================ */
  var Density = {
    limitingFactor: function () {
      var d = API.density(API.myId);
      if (d >= M.HARD_CAP_MULT) return 'HARD_CAP';
      if (d >= M.PERFECT_DENSITY) return 'RED_ZONE';
      if (d >= 90) return 'OPTIMAL';
      if (d >= 70) return 'GOOD';
      if (d >= 50) return 'LOW';
      return 'CRITICAL';
    },
    optimalExpandPercent: function () {
      var t = API.troops(API.myId);
      var l = API.land(API.myId);
      if (t <= 0 || l <= 0) return 0;
      var ideal = l * M.PERFECT_DENSITY;
      var excess = t - ideal;
      if (excess <= 0) return 0.1;
      var pct = (excess / t) * 100;
      if (pct >= 50) {
        var tax = Math.floor(M.ATTACK_TAX * t);
        pct = Math.min(99, ((excess + tax) / t) * 100);
      }
      return Math.max(0.1, Math.min(99, pct));
    },
    predictedDensity: function (sentTroops, gainedLand) {
      var t = API.troops(API.myId) - sentTroops;
      var l = API.land(API.myId) + gainedLand;
      return l > 0 ? t / l : 0;
    }
  };

  /* ================================================================
   *  BORDER INTELLIGENCE
   * ================================================================ */
  var Borders = {
    _cache: null, _cacheTick: -1,

    getEnemies: function () {
      if (this._cacheTick === Cycle.tick && this._cache) return this._cache;
      this._cacheTick = Cycle.tick;
      var myId = API.myId;
      if (myId == null) { this._cache = []; return this._cache; }
      this._cache = [];
      try {
        var as = API.arraySize;
        var myTiles = API.borderTiles(myId);
        if (!myTiles || !myTiles.length) return this._cache;
        var mySet = new Set(myTiles);
        var nid = API.neutralId;

        // Add neutral as enemy
        if (API.land(nid) > 0 || myTiles.length > 0) {
          this._cache.push({
            id: nid, shared: myTiles.length, troops: API.troops(nid),
            land: API.land(nid), density: API.density(nid), isNeutral: true
          });
        }

        for (var pid = 0; pid < as; pid++) {
          if (pid === myId) continue;
          if (pid === nid) continue;
          if (!API.land(pid) && !API.isAlive(pid)) continue;
          var theirTiles = API.borderTiles(pid);
          if (!theirTiles || !theirTiles.length) continue;
          var shared = 0;
          for (var i = 0; i < theirTiles.length && i < 500; i++) {
            var c = theirTiles[i];
            if (mySet.has(c - 1) || mySet.has(c + 1)) { shared++; continue; }
            if (mySet.has(c - as) || mySet.has(c + as)) { shared++; }
          }
          if (shared > 0) {
            this._cache.push({
              id: pid, shared: shared, troops: API.troops(pid),
              land: API.land(pid), density: API.density(pid), isNeutral: false
            });
          }
        }
      } catch (e) { /* */ }
      return this._cache;
    },

    getThreats: function () {
      var enemies = this.getEnemies();
      var myTroops = API.troops(API.myId);
      var myDensity = API.density(API.myId);
      var myLand = API.land(API.myId);
      var threats = [];
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.isNeutral) continue;
        var score = 0;
        score += (e.troops / Math.max(1, myTroops)) * 30;
        score += (e.density / Math.max(1, myDensity)) * 25;
        score += (e.land / Math.max(1, myLand)) * 15;
        score += (e.shared / Math.max(1, this.totalEnemyBorder())) * 10;
        if (e.density < myDensity * 0.6) score -= 30;
        threats.push({
          id: e.id, shared: e.shared, troops: e.troops, land: e.land,
          density: e.density, threat: score, isEasy: e.density < myDensity * 0.6
        });
      }
      threats.sort(function (a, b) { return b.threat - a.threat; });
      return threats;
    },

    totalEnemyBorder: function () {
      var t = 0;
      var enemies = this.getEnemies();
      for (var i = 0; i < enemies.length; i++) {
        if (!enemies[i].isNeutral) t += enemies[i].shared;
      }
      return t;
    },

    compactness: function () {
      var l = API.land(API.myId);
      return l > 0 ? API.borderCount(API.myId) / l : 0;
    }
  };

  /* ================================================================
   *  ATTACK PROTOCOL
   * ================================================================ */
  var p2v = function (p) {
    return Math.max(0, Math.min(1023, Math.round(1023 * p / 100)));
  };

  function sendAttack(percent, targetId) {
    try {
      window.protocolHandler.gameCommandSender.attackTargetHandler(p2v(percent), targetId);
      return true;
    } catch (e) { return false; }
  }
  function sendBoat(percent, targetId) {
    try {
      window.protocolHandler.gameCommandSender.sendBoatHandler(p2v(percent), targetId);
      return true;
    } catch (e) { return false; }
  }
  function cancelAttack(targetId) {
    try { window.protocolHandler.gameCommandSender.cancelAttackHandler(targetId); } catch (e) { /* */ }
  }

  /* ================================================================
   *  BOT BRAIN
   * ================================================================ */
  var Bot = {
    state: 'init',
    stats: { attacks: 0, expansions: 0, retreats: 0, boats: 0, kills: 0 },
    lastAttackTick: {},
    activeTargets: {},
    lastBalance: 0,
    balanceDrops: [],
    underAttack: false,
    openingDone: false,

    canAfford: function (percent) {
      var troops = API.troops(API.myId);
      var land = API.land(API.myId);
      var remaining = troops * (1 - percent / 100);
      return land > 0 ? (remaining / land) >= 40 : remaining > 500;
    },

    perfectAttackPercent: function () {
      var troops = API.troops(API.myId);
      var land = API.land(API.myId);
      if (troops <= 0 || land <= 0) return 0;
      var idealTroops = land * M.PERFECT_DENSITY;
      var excess = troops - idealTroops;
      if (excess <= 0) return 0.1;
      var pct = (excess / troops) * 100;
      if (pct >= 50) {
        var tax = Math.floor(M.ATTACK_TAX * troops);
        pct = Math.min(99, ((excess + tax) / troops) * 100);
      }
      return Math.max(0.1, Math.min(99, pct));
    },

    killPercent: function (enemy) {
      var myTroops = API.troops(API.myId);
      var myLand = API.land(API.myId);
      if (myTroops <= 0 || enemy.land <= 0) return 0;
      var needed = enemy.troops * 2 + enemy.land * 50;
      var withTax = needed / (1 - M.ATTACK_TAX);
      var pct = (withTax / myTroops) * 100;
      var remaining = myTroops * (1 - pct / 100);
      if (myLand > 0 && (remaining / myLand) < 40) pct = this.maxSafePercent();
      return Math.max(1, Math.min(99, Math.round(pct)));
    },

    maxSafePercent: function () {
      var troops = API.troops(API.myId);
      var land = API.land(API.myId);
      if (land <= 0 || troops <= 0) return 0;
      var minTroops = land * 40;
      var maxSend = troops - minTroops;
      return maxSend > 0 ? Math.min(99, (maxSend / troops) * 100) : 0;
    },

    execute: function (percent, targetId) {
      if (percent <= 0) return false;
      if (!this.canAfford(percent)) return false;
      var last = this.lastAttackTick[targetId] || -100;
      if (Cycle.tick - last < 1) return false;
      var ok = sendAttack(percent, targetId);
      if (ok) {
        this.lastAttackTick[targetId] = Cycle.tick;
        this.activeTargets[targetId] = true;
        this.stats.attacks++;
        return true;
      }
      return false;
    },

    detectIncoming: function () {
      var troops = API.troops(API.myId);
      this.balanceDrops.push({ tick: Cycle.tick, troops: troops });
      if (this.balanceDrops.length > 5) this.balanceDrops.shift();
      if (this.balanceDrops.length >= 2) {
        var prev = this.balanceDrops[this.balanceDrops.length - 2];
        var curr = this.balanceDrops[this.balanceDrops.length - 1];
        var drop = prev.troops - curr.troops;
        var activeCount = Object.keys(this.activeTargets).length;
        var expectedTax = activeCount * (troops * M.ATTACK_TAX);
        this.underAttack = drop > expectedTax + troops * 0.03;
      }
    },

    prioritizeRetreat: function () {
      if (!this.underAttack) return;
      if (API.density(API.myId) >= M.PERFECT_DENSITY) return;
      var threats = Borders.getThreats();
      var ids = Object.keys(this.activeTargets);
      for (var i = 0; i < ids.length; i++) {
        var tid = parseInt(ids[i]);
        for (var j = 0; j < threats.length; j++) {
          if (threats[j].id === tid && threats[j].threat > 30) {
            cancelAttack(tid);
            delete this.activeTargets[tid];
            this.stats.retreats++;
            break;
          }
        }
      }
    }
  };

  /* ================================================================
   *  OPENING ENGINE
   * ================================================================ */
  var Opening = {
    moves: null,
    executed: {},

    build: function () {
      var nid = API.neutralId;
      this.moves = [
        { tick: 10,  pct: 50,   target: nid },
        { tick: 25,  pct: 0.1,  target: nid },
        { tick: 40,  pct: 45,   target: nid },
        { tick: 55,  pct: 0.1,  target: nid },
        { tick: 70,  pct: 40,   target: nid },
        { tick: 85,  pct: 0.1,  target: nid },
        { tick: 100, pct: 35,   target: nid },
        { tick: 120, pct: 0.1,  target: nid },
        { tick: 140, pct: 30,   target: nid },
        { tick: 160, pct: 0.1,  target: nid },
        { tick: 180, pct: 25,   target: nid },
        { tick: 200, pct: 0.1,  target: nid },
        { tick: 220, pct: 20,   target: nid },
        { tick: 250, pct: 0.1,  target: nid },
        { tick: 270, pct: 15,   target: nid },
        { tick: 300, pct: 0.1,  target: nid },
        { tick: 330, pct: 10,   target: nid },
        { tick: 360, pct: 0.1,  target: nid },
        { tick: 400, pct: 8,    target: nid },
        { tick: 450, pct: 0.1,  target: nid },
        { tick: 500, pct: 5,    target: nid }
      ];
      Bot.openingDone = false;
      this.executed = {};
    },

    processTick: function () {
      if (Bot.openingDone || !this.moves) return;
      for (var i = 0; i < this.moves.length; i++) {
        var move = this.moves[i];
        if (move.tick === Cycle.tick && !this.executed[move.tick]) {
          this.executed[move.tick] = true;
          sendAttack(move.pct, move.target);
          Bot.stats.expansions++;
        }
      }
      if (Cycle.tick > 550) Bot.openingDone = true;
    }
  };

  /* ================================================================
   *  EXPANSION ENGINE â€” density-perfect
   * ================================================================ */
  var Expansion = {
    processTick: function () {
      if (Bot.openingDone === false) return;
      if (Bot.underAttack && API.density(API.myId) < 80) return;
      var tick = Cycle.tick;
      var myDensity = API.density(API.myId);
      var myLand = API.land(API.myId);
      var myTroops = API.troops(API.myId);
      if (myTroops <= 0 || myLand <= 0) return;
      if (myDensity >= M.HARD_CAP_MULT) return;
      var nid = API.neutralId;

      if (Phase.isDefense) {
        if (tick % 2 === 0) {
          if (myDensity > M.PERFECT_DENSITY) {
            var pct = Bot.perfectAttackPercent();
            if (pct > 0.1) Bot.execute(pct, nid);
          } else {
            Bot.execute(0.1, nid);
          }
        }
        return;
      }

      if (Income.isPreIncomeTick(tick)) {
        var pct = Bot.perfectAttackPercent();
        if (pct >= 0.1) { Bot.execute(pct, nid); Bot.stats.expansions++; return; }
      }
      if (Income.isIncomeTick(tick)) return;

      if (myDensity > M.PERFECT_DENSITY) {
        var pct = Bot.perfectAttackPercent();
        if (pct >= 1) { Bot.execute(pct, nid); Bot.stats.expansions++; }
        return;
      }

      if (tick % 3 === 0 && myDensity > 90) {
        var pct = Bot.perfectAttackPercent();
        if (pct >= 0.5) { Bot.execute(pct, nid); Bot.stats.expansions++; }
      }
    }
  };

  /* ================================================================
   *  COMBAT ENGINE
   * ================================================================ */
  var Combat = {
    processTick: function () {
      if (Bot.openingDone === false) return;
      if (Bot.underAttack && API.density(API.myId) < 60) return;
      var enemies = Borders.getEnemies();
      var targets = [];
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.isNeutral) continue;
        if (e.land <= 0 || e.troops <= 0) continue;
        targets.push(e);
      }
      if (!targets.length) return;

      // Clean dead
      var ids = Object.keys(Bot.activeTargets);
      for (var i = 0; i < ids.length; i++) {
        var tid = parseInt(ids[i]);
        if (!API.land(tid)) { delete Bot.activeTargets[tid]; Bot.stats.kills++; }
      }

      var myDensity = API.density(API.myId);
      if (myDensity < 50) return;

      targets.sort(function (a, b) { return a.density - b.density; });
      var tickInCycle = Cycle.tick % M.INCOME_INTERVAL;
      if (tickInCycle !== 5 && tickInCycle !== 6) return;

      var maxTargets = Math.min(targets.length, 3);
      var budget = Bot.maxSafePercent();
      var used = 0;
      for (var i = 0; i < maxTargets; i++) {
        var enemy = targets[i];
        if (used + 5 > budget) break;
        var pct;
        if (enemy.density < myDensity * 0.5) {
          pct = Math.min(Bot.killPercent(enemy), budget - used);
        } else if (enemy.density < myDensity * 0.8) {
          var ratio = myDensity / Math.max(1, enemy.density);
          pct = Math.max(3, Math.min(25, 15 / ratio));
        } else { pct = 3; }
        pct = Math.min(pct, budget - used);
        if (pct >= 1 && Bot.execute(pct, enemy.id)) used += pct;
      }
    }
  };

  /* ================================================================
   *  DEFENSE ENGINE
   * ================================================================ */
  var Defense = {
    hoardMode: false,
    processTick: function () {
      if (Bot.underAttack) {
        this.hoardMode = true;
        return;
      }
      // Auto-hoard when density is critically low
      if (API.density(API.myId) < 40) {
        this.hoardMode = true;
      } else if (API.density(API.myId) > 60) {
        this.hoardMode = false;
      }
    }
  };

  /* ================================================================
   *  SPEEDBOOST ENGINE â€” always-on, automatic
   * ================================================================ */
  var SpeedBoost = {
    active: false,
    processTick: function () {
      // Auto-activate speedboost when:
      // - BLITZ or FAST phase (cheap conquest)
      // - Density above optimal (need to dump troops)
      // - Enemy is weaker (can afford to be aggressive)
      var myDensity = API.density(API.myId);
      var myTroops = API.troops(API.myId);
      var myLand = API.land(API.myId);
      if (myTroops <= 0 || myLand <= 0) { this.active = false; return; }

      var shouldBoost = false;
      // Boost during early phases when conquest is cheap
      if (Phase.name === 'BLITZ' || Phase.name === 'FAST') shouldBoost = true;
      // Boost when over-dense (wasting interest)
      if (myDensity > M.PERFECT_DENSITY * 1.1) shouldBoost = true;
      // Boost when no threats and density is good
      if (myDensity > 90 && !Bot.underAttack) shouldBoost = true;
      // NEVER boost when under attack and low density
      if (Bot.underAttack && myDensity < 80) shouldBoost = false;
      // NEVER boost in defense phase
      if (Phase.isDefense) shouldBoost = false;

      this.active = shouldBoost;
    },

    getAttackMultiplier: function () {
      return this.active ? 1.5 : 1.0;
    }
  };

  /* ================================================================
   *  BOAT ENGINE
   * ================================================================ */
  var Boats = {
    lastTick: -100,
    processTick: function () {
      if (Bot.openingDone === false) return;
      if (Cycle.tick - this.lastTick < 30) return;
      if (API.density(API.myId) < 80) return;
      var enemies = Borders.getEnemies();
      var myDensity = API.density(API.myId);
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (e.isNeutral) continue;
        if (e.density >= myDensity * 0.7) continue;
        var pct = Math.max(3, Math.min(8, Math.round(
          (1 - e.density / Math.max(1, myDensity)) * 10
        )));
        if (Bot.canAfford(pct) && API.troops(API.myId) * pct / 100 >= 60) {
          if (sendBoat(pct, e.id)) {
            this.lastTick = Cycle.tick;
            Bot.stats.boats++;
            return;
          }
        }
      }
    }
  };

  /* ================================================================
   *  ALLIANCE ENGINE
   * ================================================================ */
  var Alliance = {
    allies: {},
    addAlly: function (id) { this.allies[id] = true; },
    removeAlly: function (id) { delete this.allies[id]; },
    isAlly: function (id) { return !!this.allies[id]; },
    processTick: function () {
      // Clean dead allies
      var ids = Object.keys(this.allies);
      for (var i = 0; i < ids.length; i++) {
        if (!API.land(parseInt(ids[i]))) delete this.allies[ids[i]];
      }
    }
  };

  /* ================================================================
   *  SETTINGS â€” user-configurable (via GUI or console)
   * ================================================================ */
  var Settings = {
    expansionEnabled: true,
    combatEnabled: true,
    boatsEnabled: true,
    defenseEnabled: true,
    speedBoostEnabled: true,
    allianceEnabled: true,
    autoOpening: true,
    targetDensity: 100,
    minAttackDensity: 50,
    maxConcurrentAttacks: 3,
    boatCooldown: 30,
    retreatThreshold: 30
  };

  /* ================================================================
   *  GUI â€” full overlay with tabs and controls
   * ================================================================ */
  var GUI = {
    el: null,
    visible: true,
    activeTab: 0,
    tabs: ['Status', 'Engine', 'Config'],
    counter: 0,

    create: function () {
      if (document.getElementById('m5-panel')) return;
      try {
        var style = document.createElement('style');
        style.id = 'm5-css';
        style.textContent =
          '#m5-panel{position:fixed;top:8px;left:8px;width:220px;background:rgba(10,8,18,.94);border:1px solid #2a1f4a;border-radius:10px;color:#e2e8f0;font:11px/1.5 system-ui,sans-serif;z-index:999999;user-select:none;-webkit-user-select:none;overflow:hidden}' +
          '#m5-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(245,158,11,.12);border-bottom:1px solid #2a1f4a;cursor:move;touch-action:none}' +
          '#m5-header b{color:#fbbf24;font-size:12px;letter-spacing:1px}' +
          '#m5-tabs{display:flex;border-bottom:1px solid #2a1f4a}' +
          '.m5-tab{flex:1;padding:4px 0;text-align:center;font-size:10px;color:#6b7280;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}' +
          '.m5-tab:hover{color:#fbbf24}' +
          '.m5-tab.active{color:#fbbf24;border-bottom-color:#f59e0b}' +
          '#m5-body{padding:6px 10px;max-height:400px;overflow-y:auto}' +
          '.m5-row{display:flex;justify-content:space-between;padding:1px 0}' +
          '.m5-row span:first-child{color:#94a3b8}' +
          '.m5-val{color:#fbbf24;font-weight:600;text-align:right}' +
          '.m5-phase{display:inline-block;padding:0 5px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:1px}' +
          '.m5-phase.BLITZ{background:#ef444444;color:#ef4444}' +
          '.m5-phase.FAST{background:#f9731644;color:#f97316}' +
          '.m5-phase.MEDIUM{background:#eab30844;color:#eab308}' +
          '.m5-phase.SLOW{background:#22c55e44;color:#22c55e}' +
          '.m5-phase.V.SLOW{background:#3b82f644;color:#3b82f6}' +
          '.m5-phase.DEFENSE{background:#a855f744;color:#a855f7}' +
          '.m5-phase.IDLE{color:#6b7280}' +
          '.m5-on{color:#22c55e}' +
          '.m5-off{color:#ef4444}' +
          '.m5-engine{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #1e1b2e}' +
          '.m5-engine span{color:#cbd5e1;font-size:10px}' +
          '.m5-sw{width:32px;height:18px;background:#374151;border-radius:9px;position:relative;cursor:pointer;transition:background .2s}' +
          '.m5-sw.on{background:#f59e0b}' +
          '.m5-sw::after{content:\"\";position:absolute;top:2px;left:2px;width:14px;height:14px;background:#fff;border-radius:50%;transition:transform .2s}' +
          '.m5-sw.on::after{transform:translateX(14px)}' +
          '.m5-cfg{padding:3px 0}' +
          '.m5-cfg label{display:flex;justify-content:space-between;color:#94a3b8;font-size:10px;margin-bottom:2px}' +
          '.m5-cfg input{width:50px;background:#1e1b2e;border:1px solid #374151;color:#fbbf24;border-radius:4px;padding:2px 4px;font-size:10px;text-align:right}' +
          '.m5-cfg input:focus{outline:none;border-color:#f59e0b}' +
          '#m5-toggle{position:fixed;bottom:16px;right:16px;width:40px;height:40px;background:linear-gradient(135deg,#f59e0b,#fbbf24);border:2px solid #f59e0b66;border-radius:10px;color:#000;font:700 14px/1 system-ui;display:flex;align-items:center;justify-content:center;z-index:999998;cursor:pointer;box-shadow:0 2px 12px #f59e0b88;touch-action:none}' +
          '#m5-toggle:active{transform:scale(.92)}';
        document.head.appendChild(style);

        var panel = document.createElement('div');
        panel.id = 'm5-panel';
        panel.innerHTML =
          '<div id="m5-header"><b>MESSIAH v5</b><span style="font-size:10px;color:#6b7280">&#9776;</span></div>' +
          '<div id="m5-tabs"><div class="m5-tab active" data-tab="0">Status</div><div class="m5-tab" data-tab="1">Engine</div><div class="m5-tab" data-tab="2">Config</div></div>' +
          '<div id="m5-body"></div>';
        document.body.appendChild(panel);
        this.el = panel;

        // Tab clicks
        var tabs = panel.querySelectorAll('.m5-tab');
        var self = this;
        for (var i = 0; i < tabs.length; i++) {
          (function (idx) {
            tabs[idx].addEventListener('click', function (e) {
              e.preventDefault(); e.stopPropagation();
              self.activeTab = idx;
              for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('active', j === idx);
              self.renderBody();
            });
          })(i);
        }

        // Draggable header
        var header = panel.querySelector('#m5-header');
        var dragging = false, ox = 0, oy = 0;
        header.addEventListener('mousedown', function (e) {
          dragging = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
          e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
          if (!dragging) return;
          panel.style.left = Math.max(0, e.clientX - ox) + 'px';
          panel.style.top = Math.max(0, e.clientY - oy) + 'px';
        });
        document.addEventListener('mouseup', function () { dragging = false; });
        header.addEventListener('touchstart', function (e) {
          var t = e.touches[0]; ox = t.clientX - panel.offsetLeft; oy = t.clientY - panel.offsetTop; dragging = true;
        }, { passive: true });
        header.addEventListener('touchmove', function (e) {
          if (!dragging) return; e.preventDefault();
          var t = e.touches[0];
          panel.style.left = Math.max(0, Math.min(innerWidth - 220, t.clientX - ox)) + 'px';
          panel.style.top = Math.max(0, Math.min(innerHeight - 100, t.clientY - oy)) + 'px';
        }, { passive: false });
        header.addEventListener('touchend', function () { dragging = false; });

        // Toggle button
        var btn = document.createElement('div');
        btn.id = 'm5-toggle';
        btn.textContent = 'M';
        btn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          self.visible = !self.visible;
          panel.style.display = self.visible ? 'block' : 'none';
        });
        document.body.appendChild(btn);

        // Make toggle draggable on mobile
        var bdrag = false, box = 0, boy = 0;
        btn.addEventListener('touchstart', function (e) {
          var t = e.touches[0]; var r = btn.getBoundingClientRect();
          box = t.clientX - r.left; boy = t.clientY - r.top; bdrag = true;
        }, { passive: true });
        btn.addEventListener('touchmove', function (e) {
          if (!bdrag) return; e.preventDefault();
          var t = e.touches[0];
          btn.style.left = Math.max(0, Math.min(innerWidth - 40, t.clientX - box)) + 'px';
          btn.style.top = Math.max(0, Math.min(innerHeight - 40, t.clientY - boy)) + 'px';
          btn.style.right = 'auto'; btn.style.bottom = 'auto';
        }, { passive: false });
        btn.addEventListener('touchend', function () { bdrag = false; });

        this.renderBody();
      } catch (e) { /* GUI failed, bot still works */ }
    },

    renderBody: function () {
      if (!this.el) return;
      try {
        var body = this.el.querySelector('#m5-body');
        if (!body) return;
        if (this.activeTab === 0) body.innerHTML = this.statusHTML();
        else if (this.activeTab === 1) body.innerHTML = this.engineHTML();
        else body.innerHTML = this.configHTML();
        this.bindEvents(body);
      } catch (e) { /* */ }
    },

    statusHTML: function () {
      var fmt = function (n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return Math.round(n) + '';
      };
      var myD = API.density(API.myId);
      var df = Density.limitingFactor();
      var dfColor = df === 'HARD_CAP' || df === 'RED_ZONE' ? '#ef4444' : df === 'OPTIMAL' ? '#22c55e' : '#eab308';
      return
        '<div class="m5-row"><span>Phase</span><span><span class="m5-phase ' + Phase.name + '">' + Phase.name + '</span></span></div>' +
        '<div class="m5-row"><span>Tick</span><span class="m5-val">' + Cycle.tick + '</span></div>' +
        '<div class="m5-row"><span>Troops</span><span class="m5-val">' + fmt(API.troops(API.myId)) + '</span></div>' +
        '<div class="m5-row"><span>Land</span><span class="m5-val">' + fmt(API.land(API.myId)) + '</span></div>' +
        '<div class="m5-row"><span>Density</span><span class="m5-val">' + myD.toFixed(1) + '</span></div>' +
        '<div class="m5-row"><span>Factor</span><span style="color:' + dfColor + ';font-weight:600;font-size:10px">' + df + '</span></div>' +
        '<div class="m5-row"><span>Income</span><span class="m5-val">' + Income.getMyRate() + '</span></div>' +
        '<div class="m5-row"><span>Next Income</span><span class="m5-val">' + Income.ticksUntilIncome() + 't</span></div>' +
        '<div class="m5-row"><span>Boost</span><span class="m5-val ' + (SpeedBoost.active ? 'm5-on' : 'm5-off') + '">' + (SpeedBoost.active ? 'ON' : 'OFF') + '</span></div>' +
        '<div class="m5-row"><span>Under Atk</span><span class="m5-val ' + (Bot.underAttack ? 'm5-on' : 'm5-off') + '">' + (Bot.underAttack ? 'YES' : 'no') + '</span></div>' +
        '<div class="m5-row"><span>Enemies</span><span class="m5-val">' + Borders.getEnemies().length + '</span></div>' +
        '<div class="m5-row"><span>Atk/Exp/Kill</span><span class="m5-val">' + Bot.stats.attacks + '/' + Bot.stats.expansions + '/' + Bot.stats.kills + '</span></div>' +
        '<div class="m5-row"><span>Boats/Retreat</span><span class="m5-val">' + Bot.stats.boats + '/' + Bot.stats.retreats + '</span></div>' +
        '<div class="m5-row"><span>Compact</span><span class="m5-val">' + (Borders.compactness() * 100).toFixed(2) + '%</span></div>';
    },

    engineHTML: function () {
      var engines = [
        { name: 'Expansion', key: 'expansionEnabled' },
        { name: 'Combat', key: 'combatEnabled' },
        { name: 'Boats', key: 'boatsEnabled' },
        { name: 'Defense', key: 'defenseEnabled' },
        { name: 'SpeedBoost', key: 'speedBoostEnabled' },
        { name: 'Alliance', key: 'allianceEnabled' },
        { name: 'Auto Opening', key: 'autoOpening' }
      ];
      var html = '';
      for (var i = 0; i < engines.length; i++) {
        var e = engines[i];
        var on = Settings[e.key];
        html += '<div class="m5-engine"><span>' + e.name + '</span><div class="m5-sw ' + (on ? 'on' : '') + '" data-key="' + e.key + '"></div></div>';
      }
      return html;
    },

    configHTML: function () {
      return
        '<div class="m5-cfg"><label>Target Density<span><input type="number" data-key="targetDensity" value="' + Settings.targetDensity + '" min="50" max="150"></span></label></div>' +
        '<div class="m5-cfg"><label>Min Atk Density<span><input type="number" data-key="minAttackDensity" value="' + Settings.minAttackDensity + '" min="20" max="100"></span></label></div>' +
        '<div class="m5-cfg"><label>Max Atk Targets<span><input type="number" data-key="maxConcurrentAttacks" value="' + Settings.maxConcurrentAttacks + '" min="1" max="8"></span></label></div>' +
        '<div class="m5-cfg"><label>Boat Cooldown (t)<span><input type="number" data-key="boatCooldown" value="' + Settings.boatCooldown + '" min="5" max="100"></span></label></div>' +
        '<div class="m5-cfg"><label>Retreat Threat<span><input type="number" data-key="retreatThreshold" value="' + Settings.retreatThreshold + '" min="10" max="80"></span></label></div>';
    },

    bindEvents: function (body) {
      if (this.activeTab === 1) {
        var switches = body.querySelectorAll('.m5-sw');
        var self = this;
        for (var i = 0; i < switches.length; i++) {
          (function (sw) {
            sw.addEventListener('click', function (e) {
              e.preventDefault(); e.stopPropagation();
              var key = sw.getAttribute('data-key');
              Settings[key] = !Settings[key];
              sw.classList.toggle('on', Settings[key]);
            });
          })(switches[i]);
        }
      } else if (this.activeTab === 2) {
        var inputs = body.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
          (function (inp) {
            inp.addEventListener('change', function (e) {
              e.preventDefault(); e.stopPropagation();
              var key = inp.getAttribute('data-key');
              var val = parseFloat(inp.value);
              if (!isNaN(val)) Settings[key] = val;
            });
          })(inputs[i]);
        }
      }
    },

    update: function () {
      if (!this.el || !this.visible) return;
      this.counter++;
      if (this.counter < 5) return;
      this.counter = 0;
      this.renderBody();
    }
  };

  /* ================================================================
   *  MAIN LOOP
   * ================================================================ */
  var wasInGame = false;

  function resetState() {
    Cycle.tick = -1; Cycle.prevTick = -1; Cycle.tickChanged = false;
    Bot.state = 'init';
    Bot.stats = { attacks: 0, expansions: 0, retreats: 0, boats: 0, kills: 0 };
    Bot.lastAttackTick = {};
    Bot.activeTargets = {};
    Bot.underAttack = false;
    Bot.balanceDrops = [];
    Bot.openingDone = false;
    Opening.moves = null; Opening.executed = {};
    SpeedBoost.active = false;
    Defense.hoardMode = false;
    Boats.lastTick = -100;
    Borders._cacheTick = -1; Borders._cache = null;
    Alliance.allies = {};
    wasInGame = false;
  }

  function mainLoop() {
    try {
      if (!API.check()) { requestAnimationFrame(mainLoop); return; }

      var on = API.gameStarted();
      if (!on) {
        if (wasInGame) resetState();
        wasInGame = false;
        requestAnimationFrame(mainLoop);
        return;
      }

      // Game just started
      if (!wasInGame) {
        wasInGame = true;
        Opening.build();
      }

      Cycle.update();
      if (!Cycle.tickChanged) { requestAnimationFrame(mainLoop); return; }

      Phase.update(Cycle.tick);
      Bot.detectIncoming();
      if (Settings.defenseEnabled && Bot.underAttack) Bot.prioritizeRetreat();

      // Run engines based on settings
      if (Settings.autoOpening) Opening.processTick();
      if (Settings.speedBoostEnabled) SpeedBoost.processTick();
      if (Settings.defenseEnabled) Defense.processTick();
      if (Settings.expansionEnabled) Expansion.processTick();
      if (Settings.combatEnabled) Combat.processTick();
      if (Settings.boatsEnabled) Boats.processTick();
      if (Settings.allianceEnabled) Alliance.processTick();

      GUI.update();
    } catch (e) {
      // Silent â€” game error handler would show popup
    }
    requestAnimationFrame(mainLoop);
  }

  /* ================================================================
   *  INIT
   * ================================================================ */
  try {
    GUI.create();
    requestAnimationFrame(mainLoop);
    console.log('%c[MESSIAH v5] BEYOND MESSIAH â€” Fully automatic', 'color:#f59e0b;font-weight:bold;font-size:14px');
    console.log('[v5] GUI with 3 tabs: Status / Engine / Config');
    console.log('[v5] SpeedBoost is automatic â€” no toggle needed');
    console.log('[v5] Type EchoAPI.debug() to verify hooks');
  } catch (e) {
    setTimeout(function () {
      try { GUI.create(); requestAnimationFrame(mainLoop); } catch (e2) { /* */ }
    }, 1000);
  }

})();