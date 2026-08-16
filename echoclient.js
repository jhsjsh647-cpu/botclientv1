/* ================================================================
 *  ZYROX MESSIAH v5 â€” BEYOND MESSIAH
 *  ----------------------------------------------------------------
 *  Fully automatic. Zero toggles. Every tick optimized.
 *  Based on exact decompiled game source (aMd, aKj, gW, n8, adX).
 *
 *  Conquest phases (TIME-BASED, not land-based):
 *    Tick 0-356:    BLITZ    divisor = u0 = 1+floor(mapSize/300) â‰ˆ 875
 *    Tick 357-713:  FAST    divisor = 4*u0
 *    Tick 714-1070: MEDIUM  divisor = 10*u0
 *    Tick 1071-2141: SLOW   divisor = 30*u0
 *    Tick 2142-3212: V.SLOW divisor = 100*u0
 *    Tick 3213+:     DEF     divisor = defenseTroops of target
 *
 *  Interest: every 10 ticks (tick%10===9), max rate=700, cap at 100x land
 *  Augmentation: first 1920 ticks, rate = max(700, floor(100*(13440-6*tick)/1920))
 *  Overstack: balance>100*land â†’ income -= floor(2*income*(balance-100*land)/(100*land))
 *  Hard cap: 150*land â†’ income = 0
 *  Attack tax: 12/1024 if attack >= 50% of balance
 *  Attack power: 2 + floor(100 * attackAmount / divisor)
 *  Conquest: BFS, max 2048 tiles/batch, min 2 troops/tile
 *
 *  Hooks: window.gameManager, window.playerData, window.mapData,
 *  window.protocolHandler, window.gameLoop
 * ================================================================ */

const M = {
  TICK_MS: 56,
  INCOME_INTERVAL: 10,
  TEAM_INCOME_INTERVAL: 100,
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
    { endTick: 357,  mult: 1 },
    { endTick: 714,  mult: 4 },
    { endTick: 1071, mult: 10 },
    { endTick: 2142, mult: 30 },
    { endTick: 3213, mult: 100 },
    { endTick: Infinity, mult: -1 },
  ],

  CMD_ATTACK: 1,
  CMD_BOAT: 3,
  CMD_CANCEL: 5,
  CMD_DONATE: 2,
};


/* ================================================================
 *  API HOOKS
 * ================================================================ */
const API = {
  _ready: false,

  check() {
    this._ready = !!(
      window.gameManager && window.playerData &&
      window.mapData && window.protocolHandler && window.gameLoop
    );
    return this._ready;
  },

  get myId() { return window.gameManager?.OwnPlayerId; },
  get arraySize() { return window.gameManager?.arraySize || 0; },
  get mapSize() { return window.gameManager?.gS || 262144; },
  get neutralId() { return window.gameManager?.yB || 0; },

  troops(id) { try { return window.playerData?.playerTroops?.[id] || 0; } catch { return 0; } },
  land(id) { try { return window.playerData?.landOwned?.[id] || 0; } catch { return 0; } },
  density(id) { const l = this.land(id); return l > 0 ? this.troops(id) / l : 0; },
  borderTiles(id) { try { return window.playerData?.gp?.[id]?.length || 0; } catch { return 0; } },

  get tick() { return window.gameLoop?.getTick() ?? -1; },
};

window.EchoAPI = {
  ready: false,
  check() { API.check(); this.ready = API._ready; return this.ready; },
  debug() {
    console.log('%c[MESSIAH v5]', 'color:#f59e0b;font-weight:bold;font-size:14px');
    console.log('  myId:', API.myId, 'tick:', API.tick, 'mapSize:', API.mapSize);
    console.log('  troops:', API.troops(API.myId), 'land:', API.land(API.myId),
      'density:', API.density(API.myId).toFixed(1));
    console.log('  borders:', API.borderTiles(API.myId), 'phase:', Phase.name);
  }
};


/* ================================================================
 *  CONQUEST PHASE â€” time-based attack power calculation
 * ================================================================ */
const Phase = {
  name: 'IDLE',
  divisor: 1,
  isDefense: false,
  u0: 875,

  update(tick) {
    if (tick < 0) { this.name = 'IDLE'; return; }
    this.u0 = 1 + Math.floor(API.mapSize / 300);

    for (const phase of M.CONQUEST_PHASES) {
      if (tick < phase.endTick) {
        if (phase.mult === -1) {
          this.name = 'DEFENSE';
          this.isDefense = true;
        } else {
          const names = ['BLITZ', 'FAST', 'MEDIUM', 'SLOW', 'V.SLOW'];
          const idx = M.CONQUEST_PHASES.indexOf(phase);
          this.name = names[idx] || 'UNKNOWN';
          this.divisor = phase.mult * this.u0;
          this.isDefense = false;
        }
        return;
      }
    }
  },

  /** aMd: exact attack power per tile */
  attackPower(troopsSent, targetDefense) {
    if (this.isDefense) {
      const d = Math.max(1, targetDefense);
      return 2 + Math.floor((100 * troopsSent + 0.5) / d);
    }
    return 2 + Math.floor((100 * troopsSent + 0.5) / Math.max(1, this.divisor));
  },

  /** Tiles one attack wave can conquer */
  tilesPerWave(attackTroops, targetDefense) {
    const power = this.attackPower(attackTroops, targetDefense);
    const troopsPerTile = M.MIN_TROOPS_PER_TILE;
    return Math.floor(attackTroops / Math.max(1, troopsPerTile));
  },
};


/* ================================================================
 *  INCOME ENGINE â€” exact aKj formula
 * ================================================================ */
const Income = {
  /** aKj: exact income rate */
  getRate(tick, territory, balance) {
    if (territory <= 0) return 0;

    // Base rate from territory occupation
    const idx = Math.floor(511 * territory / API.mapSize);
    const table = window.incomeManager?.rateTable;
    let rate = 10; // fallback base
    if (table && table[idx] !== undefined) rate = table[idx];
    else rate = Math.min(700, Math.floor(10 + 690 * Math.min(1, territory / (API.mapSize * 0.002))));

    // Augmentation boost (first 1920 ticks)
    if (tick < M.AUGMENTATION_END) {
      const augRate = Math.floor(100 * (13440 - 6 * tick) / M.AUGMENTATION_END);
      rate = Math.max(rate, augRate);
    }

    // Overstack penalty (red zone)
    const defTroops = Math.min(M.PERFECT_DENSITY * territory, M.MAX_BALANCE);
    if (balance > defTroops) {
      rate -= Math.floor(2 * rate * (balance - defTroops) / defTroops);
    }

    return Math.max(0, Math.min(M.MAX_INCOME_RATE, rate));
  },

  getMyRate() {
    return this.getRate(Cycle.tick, API.land(API.myId), API.troops(API.myId));
  },

  /** Territory gained next income tick */
  predictedGain() {
    const rate = this.getMyRate();
    const balance = API.troops(API.myId);
    return Math.max(1, Math.floor(rate * balance / 10000));
  },

  /** Ticks until next income */
  ticksUntilIncome() {
    const next = Math.ceil((Cycle.tick + 1) / M.INCOME_INTERVAL) * M.INCOME_INTERVAL - 1;
    return next - Cycle.tick;
  },

  isIncomeTick() {
    return Cycle.tick % M.INCOME_INTERVAL === M.INCOME_INTERVAL - 1;
  },

  isPreIncomeTick() {
    return Cycle.tick % M.INCOME_INTERVAL === M.INCOME_INTERVAL - 2;
  },
};


/* ================================================================
 *  CYCLE TRACKER
 * ================================================================ */
const Cycle = {
  tick: -1,
  prevTick: -1,
  tickChanged: false,
  cycle: 0,
  inAugmentation: true,

  update() {
    const t = API.tick;
    if (t == null || t <= this.tick) { this.tickChanged = false; return; }
    this.prevTick = this.tick;
    this.tick = t;
    this.tickChanged = true;
    this.cycle = Math.floor(t / M.INCOME_INTERVAL);
    this.inAugmentation = t < M.AUGMENTATION_END;
  },
};


/* ================================================================
 *  BORDER INTELLIGENCE
 * ================================================================ */
const Borders = {
  _cache: null,
  _cacheTick: -1,

  getEnemies() {
    if (this._cacheTick === Cycle.tick) return this._cache;
    this._cacheTick = Cycle.tick;

    const myId = API.myId;
    if (myId == null) { this._cache = new Map(); return this._cache; }

    const pd = window.playerData;
    const as = API.arraySize;
    const offsets = window.mapData?.neighborOffsets;
    const myTiles = pd?.gp?.[myId];

    if (!myTiles || !offsets || !as) { this._cache = new Map(); return this._cache; }

    const mySet = new Set(myTiles);
    const enemies = new Map();

    for (let pid = 0; pid < as; pid++) {
      if (pid === myId) continue;
      if (!API.land(pid)) continue;

      const theirTiles = pd.gp?.[pid];
      if (!theirTiles) continue;

      let shared = 0;
      for (let i = 0; i < theirTiles.length; i++) {
        const c = theirTiles[i];
        for (let d = 0; d < offsets.length; d++) {
          if (mySet.has(c - offsets[d])) { shared++; break; }
        }
      }

      if (shared > 0) {
        enemies.set(pid, {
          id: pid,
          shared,
          troops: API.troops(pid),
          land: API.land(pid),
          density: API.density(pid),
          defense: Math.min(M.PERFECT_DENSITY * API.land(pid), M.MAX_BALANCE),
          isNeutral: pid === 0 || pid === API.neutralId,
        });
      }
    }
    this._cache = enemies;
    return enemies;
  },

  getNeutralInfo() {
    const nid = API.neutralId;
    return {
      id: nid,
      troops: API.troops(nid),
      land: API.land(nid),
      density: API.density(nid),
      defense: 0, // Neutral has 0 defense
      isNeutral: true,
      shared: API.borderTiles(API.myId),
    };
  },

  getThreats() {
    const enemies = this.getEnemies();
    const myTroops = API.troops(API.myId);
    const myDensity = API.density(API.myId);
    const threats = [];

    for (const [, e] of enemies) {
      if (e.isNeutral) continue;
      let score = 0;
      score += (e.troops / Math.max(1, myTroops)) * 30;
      score += (e.density / Math.max(1, myDensity)) * 25;
      score += (e.land / Math.max(1, API.land(API.myId))) * 15;
      score += (e.shared / Math.max(1, this.totalEnemyBorder())) * 10;
      if (e.density < myDensity * 0.6) score -= 30;
      threats.push({ ...e, threat: score, isEasy: e.density < myDensity * 0.6 });
    }
    threats.sort((a, b) => b.threat - a.threat);
    return threats;
  },

  totalEnemyBorder() {
    let t = 0;
    for (const [, e] of this.getEnemies()) if (!e.isNeutral) t += e.shared;
    return t;
  },

  compactness() {
    const l = API.land(API.myId);
    return l > 0 ? API.borderTiles(API.myId) / l : 0;
  },
};


/* ================================================================
 *  ATTACK PROTOCOL â€” raw game commands
 * ================================================================ */
const p2v = (p) => Math.max(0, Math.min(1023, Math.round(1023 * p / 100)));

function sendAttack(percent, targetId) {
  try { return window.protocolHandler?.gameCommandSender.attackTargetHandler(p2v(percent), targetId); } catch { return false; }
}
function sendBoat(percent, targetId) {
  try { return window.protocolHandler?.gameCommandSender.sendBoatHandler(p2v(percent), targetId); } catch { return false; }
}
function cancelAttack(targetId) {
  try { return window.protocolHandler?.gameCommandSender.cancelAttackHandler(targetId); } catch { return false; }
}


/* ================================================================
 *  CORE BOT BRAIN â€” fully automatic, zero toggles
 * ================================================================ */
const Bot = {
  state: 'init',
  stats: { attacks: 0, expansions: 0, retreats: 0, boats: 0, kills: 0 },
  lastAttackTick: new Map(),
  activeTargets: new Set(),
  lastBalance: 0,
  balanceDrops: [],
  underAttack: false,
  openingDone: false,

  /** Can I safely send X%? */
  canAfford(percent) {
    const troops = API.troops(API.myId);
    const land = API.land(API.myId);
    const remaining = troops * (1 - percent / 100);
    return land > 0 ? (remaining / land) >= 40 : remaining > 500;
  },

  /** Perfect attack % to maintain density at exactly 100 */
  perfectAttackPercent(targetDefense) {
    const troops = API.troops(API.myId);
    const land = API.land(API.myId);
    if (troops <= 0 || land <= 0) return 0;

    // How many troops to send to bring density to exactly 100
    const idealTroops = land * M.PERFECT_DENSITY;
    const excess = troops - idealTroops;

    if (excess <= 0) {
      // Below perfect density â€” send minimum for border expansion
      return 0.1; // 0.1% just to expand borders
    }

    // Send exactly the excess, but account for tax if >= 50%
    let pct = (excess / troops) * 100;

    // If attack >= 50% of balance, tax applies
    if (pct >= 50) {
      const tax = Math.floor(M.ATTACK_TAX * troops);
      const actualSend = excess + tax; // Need to send more to compensate tax
      pct = Math.min(99, (actualSend / troops) * 100);
    }

    return Math.max(0.1, Math.min(99, pct));
  },

  /** Kill an enemy â€” calculate exact % needed */
  killPercent(enemy) {
    const myTroops = API.troops(API.myId);
    const myLand = API.land(API.myId);
    if (myTroops <= 0 || enemy.land <= 0) return 0;

    // Defense is 2x: need 2x their balance to kill
    // Plus need to overcome their land defense
    const needed = enemy.troops * 2 + enemy.land * 50;
    const withTax = needed / (1 - M.ATTACK_TAX);
    let pct = (withTax / myTroops) * 100;

    // Verify we can afford it
    const remaining = myTroops * (1 - pct / 100);
    if (myLand > 0 && (remaining / myLand) < 40) {
      pct = this.maxSafePercent();
    }

    return Math.max(1, Math.min(99, Math.round(pct)));
  },

  maxSafePercent() {
    const troops = API.troops(API.myId);
    const land = API.land(API.myId);
    if (land <= 0 || troops <= 0) return 0;
    const minTroops = land * 40;
    const maxSend = troops - minTroops;
    return maxSend > 0 ? Math.min(99, (maxSend / troops) * 100) : 0;
  },

  /** Execute with IFS-aware cooldown */
  execute(percent, targetId) {
    if (percent <= 0) return false;
    if (!this.canAfford(percent)) return false;

    const last = this.lastAttackTick.get(targetId) || -100;
    if (Cycle.tick - last < 1) return false;

    const ok = sendAttack(percent, targetId);
    if (ok !== false) {
      this.lastAttackTick.set(targetId, Cycle.tick);
      this.activeTargets.add(targetId);
      this.stats.attacks++;
      return true;
    }
    return false;
  },

  /** Detect incoming attacks via balance drops */
  detectIncoming() {
    const troops = API.troops(API.myId);
    this.balanceDrops.push({ tick: Cycle.tick, troops });
    if (this.balanceDrops.length > 5) this.balanceDrops.shift();

    if (this.balanceDrops.length >= 2) {
      const prev = this.balanceDrops[this.balanceDrops.length - 2];
      const curr = this.balanceDrops[this.balanceDrops.length - 1];
      const drop = prev.troops - curr.troops;
      const expectedTax = this.activeTargets.size * (troops * M.ATTACK_TAX);
      this.underAttack = drop > expectedTax + troops * 0.03;
    }
  },

  /** Retreat from dangerous targets */
  prioritizeRetreat() {
    if (!this.underAttack) return;
    const myDensity = API.density(API.myId);
    if (myDensity >= M.PERFECT_DENSITY) return;

    const threats = Borders.getThreats();
    for (const t of this.activeTargets) {
      const enemy = threats.find(e => e.id === t);
      if (enemy && enemy.threat > 30) {
        cancelAttack(t);
        this.activeTargets.delete(t);
        this.stats.retreats++;
      }
    }
  },
};


/* ================================================================
 *  OPENING ENGINE â€” TerriEngine V6 + blitz optimization
 * ================================================================ */
const Opening = {
  moves: null,
  executed: new Set(),

  init() {
    const nid = API.neutralId;
    this.moves = [
      // BLITZ PHASE â€” maximize land while conquest is cheapest
      // Tick 10: first possible attack (after spawn)
      { tick: 10,  pct: 100,  target: nid },   // Full send during blitz
      { tick: 30,  pct: 0.1,  target: nid },   // Reinforcement
      { tick: 60,  pct: 85,   target: nid },
      { tick: 81,  pct: 0.1,  target: nid },   // Reinforcement

      // FAST PHASE â€” still good conquest, multiple waves
      { tick: 150, pct: 60, target: nid },
      { tick: 165, pct: 0.1, target: nid },   // Reinforcement
      { tick: 172, pct: 80, target: nid },
      { tick: 186, pct: 0.1, target: nid },   // Reinforcement

      // MEDIUM PHASE â€” slow down, start interest farming
      { tick: 256, pct: 0.1, target: nid },   // Reinforcement only
      { tick: 263, pct: 45,  target: nid },
      { tick: 270, pct: 0.1, target: nid },   // Reinforcement
      { tick: 284, pct: 35,  target: nid },

      // SLOW PHASE â€” minimal attacks, maximize interest
      { tick: 354, pct: 0.1, target: nid },
      { tick: 361, pct: 25,  target: nid },
      { tick: 375, pct: 0.1, target: nid },
      { tick: 382, pct: 20,  target: nid },
    ];
  },

  processTick() {
    if (Bot.openingDone || !this.moves) return;

    for (const move of this.moves) {
      if (move.tick === Cycle.tick && !this.executed.has(move.tick)) {
        this.executed.add(move.tick);
        sendAttack(move.pct, move.target);
      }
    }

    // Opening complete after last move + buffer
    if (Cycle.tick > 500) {
      Bot.openingDone = true;
    }
  },
};


/* ================================================================
 *  EXPANSION ENGINE â€” density-perfect infinite expansion
 * ================================================================ */
const Expansion = {
  processTick() {
    if (Bot.openingDone === false) return;
    if (Bot.underAttack && API.density(API.myId) < 80) return;

    const tick = Cycle.tick;
    const myDensity = API.density(API.myId);
    const myLand = API.land(API.myId);
    const myTroops = API.troops(API.myId);

    if (myTroops <= 0 || myLand <= 0) return;

    // Hard capped â€” do nothing
    if (myDensity >= M.HARD_CAP_MULT) return;

    const nid = API.neutralId;

    if (Phase.isDefense) {
      // DEFENSE PHASE (tick 3213+): Reinforcement mode
      // Send 1/1024% every tick for sustained slow expansion
      // This keeps the conquest pipeline full
      if (tick % 2 === 0) {
        if (myDensity > M.PERFECT_DENSITY) {
          // Above perfect: send excess as reinforcement
          const pct = Bot.perfectAttackPercent(0);
          if (pct > 0.1) Bot.execute(pct, nid);
        } else {
          // Below perfect: minimal reinforcement to keep borders expanding
          Bot.execute(0.1, nid);
        }
      }
      return;
    }

    // PRE-INCOME ATTACK (PIAI): Attack 1 tick before interest
    // This way new territory earns interest NEXT tick
    if (Income.isPreIncomeTick()) {
      const pct = Bot.perfectAttackPercent(0);
      if (pct >= 0.1) {
        Bot.execute(pct, nid);
        Bot.stats.expansions++;
        return;
      }
    }

    // On income tick itself: DO NOT attack, let interest compound
    if (Income.isIncomeTick()) return;

    // RED ZONE: density > 100, dump excess immediately
    if (myDensity > M.PERFECT_DENSITY) {
      const pct = Bot.perfectAttackPercent(0);
      if (pct >= 1) {
        Bot.execute(pct, nid);
        Bot.stats.expansions++;
      }
      return;
    }

    // BLITZ PHASE: Attack aggressively when conquest is cheap
    if (Phase.name === 'BLITZ' && !Bot.openingDone) {
      // Opening handles blitz
      return;
    }

    // POST-OPENING, PRE-DEFENSE: Interest farming with periodic dumps
    // Attack every few ticks to maintain ~100 density
    if (tick % 3 === 0 && myDensity > 90) {
      const pct = Bot.perfectAttackPercent(0);
      if (pct >= 0.5) {
        Bot.execute(pct, nid);
        Bot.stats.expansions++;
      }
    }
  },
};


/* ================================================================
 *  COMBAT ENGINE â€” automatic enemy elimination
 * ================================================================ */
const Combat = {
  processTick() {
    if (Bot.openingDone === false) return;
    if (Bot.underAttack && API.density(API.myId) < 60) return;

    const enemies = Borders.getEnemies();
    let targets = [];
    for (const [, e] of enemies) {
      if (e.isNeutral) continue;
      if (e.land <= 0 || e.troops <= 0) continue;
      targets.push(e);
    }
    if (targets.length === 0) return;

    // Clean dead targets
    for (const id of [...Bot.activeTargets]) {
      if (!API.land(id) || API.land(id) === 0) {
        Bot.activeTargets.delete(id);
        Bot.stats.kills++;
      }
    }

    const myDensity = API.density(API.myId);

    // Don't attack enemies if we're too weak
    if (myDensity < 50) return;

    // Sort: easiest kills first (lowest density), then most dangerous
    targets.sort((a, b) => {
      const aEasy = a.density < myDensity * 0.6 ? -1 : 1;
      const bEasy = b.density < myDensity * 0.6 ? -1 : 1;
      if (aEasy !== bEasy) return aEasy - bEasy;
      return a.density - b.density;
    });

    // Attack on ticks that DON'T conflict with expansion
    // Expansion uses pre-income tick (tick%10==8), so combat uses tick%10==5
    const tickInCycle = Cycle.tick % M.INCOME_INTERVAL;
    if (tickInCycle !== 5 && tickInCycle !== 6) return;

    const maxTargets = Math.min(targets.length, 3);
    const budget = Bot.maxSafePercent();
    let used = 0;

    for (let i = 0; i < maxTargets; i++) {
      const enemy = targets[i];
      if (used + 5 > budget) break;

      let pct;
      if (enemy.density < myDensity * 0.5) {
        // Easy kill â€” send enough to eliminate
        pct = Bot.killPercent(enemy);
        pct = Math.min(pct, budget - used);
      } else if (enemy.density < myDensity * 0.8) {
        // Weaker enemy â€” proportional attack
        const ratio = myDensity / Math.max(1, enemy.density);
        pct = Math.max(3, Math.min(25, 15 / ratio));
      } else {
        // Similar strength â€” small chip attacks
        pct = 3;
      }

      pct = Math.min(pct, budget - used);
      if (pct >= 1 && Bot.execute(pct, enemy.id)) {
        used += pct;
      }
    }
  },
};


/* ================================================================
 *  BOAT ENGINE â€” automatic coastal attacks
 * ================================================================ */
const Boats = {
  lastTick: -100,

  processTick() {
    if (Bot.openingDone === false) return;
    if (Cycle.tick - this.lastTick < 30) return;
    if (API.density(API.myId) < 80) return;

    // Check for coastal targets
    const enemies = Borders.getEnemies();
    const myDensity = API.density(API.myId);

    for (const [, e] of enemies) {
      if (e.isNeutral) continue;
      if (e.density >= myDensity * 0.7) continue;

      // Check if enemy has coast
      try {
        const hasCoast = window.playerData?.bJ?.[e.id]?.length > 0;
        const weHaveCoast = window.playerData?.bJ?.[API.myId]?.length > 0;
        if (hasCoast && weHaveCoast) {
          const pct = Math.max(3, Math.min(8, Math.round(
            (1 - e.density / Math.max(1, myDensity)) * 10
          )));
          if (Bot.canAfford(pct) && API.troops(API.myId) * pct / 100 >= 60) {
            sendBoat(pct, e.id);
            this.lastTick = Cycle.tick;
            Bot.stats.boats++;
            return;
          }
        }
      } catch {}
    }
  },
};


/* ================================================================
 *  MINIMAL GUI â€” status only, no toggles
 * ================================================================ */
function createGUI() {
  if (document.getElementById('m5-gui')) return;

  const s = document.createElement('style');
  s.id = 'm5-style';
  s.textContent = `
    #m5-gui{position:fixed;top:8px;left:8px;background:rgba(10,8,18,.92);border:1px solid #2a1f4a;border-radius:8px;padding:8px 12px;color:#fde68a;font:11px/1.5 'Rajdhani',sans-serif;z-index:999999;user-select:none;-webkit-user-select:none;pointer-events:none;min-width:160px}
    #m5-gui b{color:#fbbf24;font-size:12px;letter-spacing:1px}
    .m5-r{display:flex;justify-content:space-between;gap:12px}
    .m5-v{color:#fbbf24;font-weight:600;text-align:right}
    .m5-phase{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:1px;margin-left:4px}
    .m5-phase.BLITZ{background:#ef444444;color:#ef4444}
    .m5-phase.FAST{background:#f9731644;color:#f97316}
    .m5-phase.MEDIUM{background:#eab30844;color:#eab308}
    .m5-phase.SLOW{background:#22c55e44;color:#22c55e}
    .m5-phase.V.SLOW{background:#3b82f644;color:#3b82f6}
    .m5-phase.DEFENSE{background:#a855f744;color:#a855f7}
    .m5-idle{color:#6b7280}
    #m5-toggle{position:fixed;bottom:16px;right:16px;width:40px;height:40px;background:linear-gradient(135deg,#f59e0b,#fbbf24);border:2px solid #f59e0b66;border-radius:10px;color:#000;font:700 16px/1 'Rajdhani',sans-serif;display:flex;align-items:center;justify-content:center;z-index:999998;cursor:pointer;box-shadow:0 2px 12px #f59e0b88;touch-action:none;-webkit-tap-highlight-color:transparent;user-select:none}
    #m5-toggle:active{transform:scale(.92)}
  `;
  document.head.appendChild(s);

  if (!document.getElementById('echo-font')) {
    const lk = document.createElement('link');
    lk.id = 'echo-font'; lk.rel = 'stylesheet';
    lk.href = 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&display=swap';
    document.head.appendChild(lk);
  }

  const gui = document.createElement('div');
  gui.id = 'm5-gui';
  gui.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
      <b>MESSIAH v5</b><span class="m5-phase m5-idle" id="m5-phase">IDLE</span>
    </div>
    <div class="m5-r"><span>Tick</span><span class="m5-v" id="m5-tick">-</span></div>
    <div class="m5-r"><span>Troops</span><span class="m5-v" id="m5-troops">-</span></div>
    <div class="m5-r"><span>Land</span><span class="m5-v" id="m5-land">-</span></div>
    <div class="m5-r"><span>Density</span><span class="m5-v" id="m5-density">-</span></div>
    <div class="m5-r"><span>Income</span><span class="m5-v" id="m5-income">-</span></div>
    <div class="m5-r"><span>Enemies</span><span class="m5-v" id="m5-enemies">-</span></div>
    <div class="m5-r"><span>Atk/Kill</span><span class="m5-v" id="m5-stats">0/0</span></div>
  `;
  document.body.appendChild(gui);

  // Draggable toggle button
  const btn = document.createElement('div');
  btn.id = 'm5-toggle';
  btn.textContent = 'M';
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    gui.style.display = gui.style.display === 'none' ? 'block' : 'none';
  });
  document.body.appendChild(btn);

  let dragging = false, ox = 0, oy = 0, moved = false;
  btn.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; const r = btn.getBoundingClientRect();
    ox = t.clientX - r.left; oy = t.clientY - r.top; dragging = true; moved = false;
  }, { passive: true });
  btn.addEventListener('touchmove', (e) => {
    if (!dragging) return; e.preventDefault(); moved = true;
    const t = e.touches[0];
    btn.style.left = Math.max(0, Math.min(innerWidth - 40, t.clientX - ox)) + 'px';
    btn.style.top = Math.max(0, Math.min(innerHeight - 40, t.clientY - oy)) + 'px';
    btn.style.right = 'auto'; btn.style.bottom = 'auto';
  }, { passive: false });
  btn.addEventListener('touchend', () => { dragging = false; });

  return gui;
}

function updateGUI(gui) {
  const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : Math.round(n)+'';

  const phaseEl = gui.querySelector('#m5-phase');
  if (phaseEl) {
    phaseEl.textContent = Phase.name;
    phaseEl.className = 'm5-phase ' + Phase.name;
  }

  const s = (id, v) => { const e = gui.querySelector('#'+id); if(e) e.textContent = v; };
  s('m5-tick', Cycle.tick);
  s('m5-troops', fmt(API.troops(API.myId)));
  s('m5-land', fmt(API.land(API.myId)));
  s('m5-density', API.density(API.myId).toFixed(1));
  s('m5-income', Income.getMyRate());
  s('m5-enemies', Borders.getEnemies().size);
  s('m5-stats', Bot.stats.attacks + '/' + Bot.stats.kills);
}


/* ================================================================
 *  MAIN LOOP â€” every frame, fully automatic
 * ================================================================ */
let gui;
let guiUpdateCounter = 0;

function mainLoop() {
  const gameOn = window.gameManager?.isGameStarted?.();

  if (!gameOn) {
    Cycle.tick = -1;
    Bot.openingDone = false;
    Bot.executedMoves?.clear?.();
    Opening.executed.clear();
    Bot.activeTargets.clear();
    Bot.lastAttackTick.clear();
    Bot.underAttack = false;
    Bot.balanceDrops = [];
    Bot.stats = { attacks: 0, expansions: 0, retreats: 0, boats: 0, kills: 0 };
    Borders._cacheTick = -1;
    requestAnimationFrame(mainLoop);
    return;
  }

  if (!API.check()) { requestAnimationFrame(mainLoop); return; }

  Cycle.update();
  if (!Cycle.tickChanged) { requestAnimationFrame(mainLoop); return; }

  Phase.update(Cycle.tick);

  // Detect incoming attacks
  Bot.detectIncoming();
  if (Bot.underAttack) Bot.prioritizeRetreat();

  // 1. Opening (first ~500 ticks)
  Opening.processTick();

  // 2. Expansion (density-perfect, cycle-aware)
  Expansion.processTick();

  // 3. Combat (auto-attack enemies)
  Combat.processTick();

  // 4. Boats (coastal attacks)
  Boats.processTick();

  // GUI update every 5 ticks (~280ms)
  guiUpdateCounter++;
  if (guiUpdateCounter >= 5) {
    guiUpdateCounter = 0;
    if (gui && gui.style.display !== 'none') updateGUI(gui);
  }

  requestAnimationFrame(mainLoop);
}


/* ================================================================
 *  INIT
 * ================================================================ */
Opening.init();
gui = createGUI();
requestAnimationFrame(mainLoop);

console.log('%c[MESSIAH v5] BEYOND MESSIAH â€” Fully automatic', 'color:#f59e0b;font-weight:bold;font-size:14px');
console.log('[v5] Zero toggles. Every tick optimized. Press M to toggle HUD.');
console.log('[v5] Conquest phases: BLITZâ†’FASTâ†’MEDIUMâ†’SLOWâ†’V.SLOWâ†’DEFENSE');
console.log('[v5] PIAI attacks, reinforcement mode, density-perfect expansion');
console.log('[v5] Type EchoAPI.debug() to verify hooks');