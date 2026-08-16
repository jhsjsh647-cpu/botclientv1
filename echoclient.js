/* ================================================================
 *  ZYROX MESSIAH CLIENT v4 â€” FULL REBUILD
 *  ----------------------------------------------------------------
 *  Complete territorial.io bot with ALL advanced features:
 *  - Tick/cycle/mini-tick awareness with IFS tick detection
 *  - Border management with compactness analysis
 *  - Density analysis (soft 100 / hard 150) with real-time management
 *  - Attack engine (formula/density/border/smart/multi-target)
 *  - Speed boost system (density-adaptive expansion acceleration)
 *  - Border-to-border attack prioritization
 *  - Perfect infinite expansion (density-targeted, never stops)
 *  - Multi-target attack distribution (threat-based proportional split)
 *  - Defense prioritization (auto-hoard when under fire)
 *  - Cycle-perfect attack timing (IFS-aware, resolves at cycle end)
 *  - Terrain-aware attacks (mountain/boat/sea exploitation)
 *  - Dynamic state machine (opening/expansion/attack/defense/cleanup/boat)
 *  - Boat attack automation
 *  - Smart retreat (cancel attacks when losing)
 *  - Alliance management (auto-accept, smart donate)
 *  - Mountain pass exploitation
 *  - Troop income prediction
 *  - Perfect opening engine (TerriEngine-inspired V6 timing)
 *  - Mobile touch support with draggable GUI
 *
 *  Hooks into deobfuscated script.js via window.gameManager,
 *  window.playerData, window.mapData, window.protocolHandler,
 *  window.gameLoop, window.incomeManager.
 * ================================================================ */

/* â”€â”€ CONSTANTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const MESSIAH = {
  /* Timing â€” from decompiled source */
  MINI_TICK_MS: 56,
  TICK_MS: 560,
  CYCLE_MS: 5600,
  TICKS_PER_CYCLE: 10,
  MINI_TICKS_PER_TICK: 10,
  MINI_TICKS_PER_CYCLE: 100,
  AUGMENTATION_END_TICK: 1920,   // 107.52s of 7xâ†’1x interest decay

  /* Density â€” from decompiled: ih=150, soft=100 */
  SOFT_LIMIT_DENSITY: 100,
  HARD_LIMIT_DENSITY: 150,
  TARGET_DENSITY: 93,             // Optimal: just below soft cap for max interest
  DENSITY_BUFFER: 7,              // Stay 7 below soft cap
  MIN_DENSITY: 60,                // Below this, slow attacks (build troops)

  /* Attack â€” from official tutorial: 12/1024 land, 32/1024 boat */
  LAND_ATTACK_TAX: 12 / 1024,
  BOAT_TAX: 32 / 1024,
  BOAT_RELOCATE_TAX: 8 / 1024,
  DEFENSE_MULTIPLIER: 2,          // Defense is 2x as strong as attack
  SUPPORT_TAX: 64 / 1024,
  MIN_BOAT_STRENGTH: 60,

  /* Conquest speed tiers â€” from decompiled: floor(2 + clamp(floor(pixels/100), 0, 8)) */
  CONQUEST_TIERS: [
    { maxLand: 100,   tier: 2, auTicks: 10 },
    { maxLand: 200,   tier: 3, auTicks: 8 },
    { maxLand: 300,   tier: 4, auTicks: 7 },
    { maxLand: 400,   tier: 5, auTicks: 6 },
    { maxLand: 500,   tier: 6, auTicks: 5 },
    { maxLand: 600,   tier: 7, auTicks: 4 },
    { maxLand: 700,   tier: 8, auTicks: 3 },
    { maxLand: 800,   tier: 9, auTicks: 2 },
    { maxLand: Infinity, tier: 10, auTicks: 1 },
  ],

  /* Interest formula: 1.00% + (0.16 * sqrt(occupation))% */
  BASE_INTEREST: 0.01,
  LAND_INTEREST_FACTOR: 0.0016,

  /* Starting balance */
  STARTING_BALANCE: 512,

  /* Defense */
  SAFE_DENSITY_THRESHOLD: 40,     // Below this, enter defense mode
  INCOMING_ATTACK_SAFETY: 0.3,    // If projected loss > 30% of balance, defend

  /* Game commands (protocol IDs) */
  CMD_SPAWN: 0,
  CMD_ATTACK: 1,
  CMD_DONATE: 2,
  CMD_BOAT: 3,
  CMD_INTERCEPT_BOAT: 4,
  CMD_CANCEL_ATTACK: 5,
  CMD_EMOJI: 6,
  CMD_PEACE_VOTE: 7,
  CMD_SURRENDER: 8,
  CMD_MINE: 10,
};


/* ================================================================
 *  API VERIFICATION
 * ================================================================ */
const EchoAPI = {
  ready: false,
  lastCheck: 0,

  check() {
    this.ready = !!(
      window.gameManager &&
      window.playerData &&
      window.mapData &&
      window.protocolHandler &&
      window.gameLoop
    );
    return this.ready;
  },

  debug() {
    const g = window.gameManager;
    const p = window.playerData;
    const m = window.mapData;
    const l = window.gameLoop;
    console.log('%c[MESSIAH v4] API Debug', 'color: #f59e0b; font-weight: bold');
    console.log('  gameManager:', !!g, g ? {
      ownId: g.OwnPlayerId, started: g.isGameStarted(), mode: g.gameMode,
      arraySize: g.arraySize, kD: g.kD, gS: g.gS, yB: g.yB
    } : null);
    console.log('  playerData:', !!p, p ? {
      troopsLen: p.playerTroops?.length, landLen: p.landOwned?.length,
      gpLen: p.gp?.length, gaLen: p.ga?.length
    } : null);
    console.log('  mapData:', !!m, m ? {
      offsets: m.neighborOffsets?.length, aIL: m.aIL?.length,
      mapWidth: m.mapWidth, mapHeight: m.mapHeight
    } : null);
    console.log('  incomeManager:', !!window.incomeManager);
    console.log('  gameLoop:', !!l, l ? { tick: l.getTick() } : null);
    console.log('  MESSIAH ready:', this.ready);
    console.log('  Bot state:', BotState.state);
  }
};

window.EchoAPI = EchoAPI;


/* ================================================================
 *  CYCLE TRACKER â€” tick/cycle/mini-tick with IFS awareness
 * ================================================================ */
const CycleTracker = {
  lastTick: -1,
  tickInCycle: 0,
  cycleNumber: 0,
  isInAugmentation: true,
  isIncomeTick: false,
  isTerritoryIncomeTick: false,

  update(tick) {
    if (tick == null) return;
    if (tick <= this.lastTick) return;
    this.lastTick = tick;

    this.tickInCycle = tick % MESSIAH.TICKS_PER_CYCLE;
    this.cycleNumber = Math.floor(tick / MESSIAH.TICKS_PER_CYCLE);
    this.isInAugmentation = tick < MESSIAH.AUGMENTATION_END_TICK;
    this.isIncomeTick = (tick % 10 === 9);
    this.isTerritoryIncomeTick = (tick % 100 === 99);
  },

  ticksUntilIncome() {
    const next = Math.ceil((this.lastTick + 1) / 10) * 10 - 1;
    return next - this.lastTick;
  },

  ticksUntilTerritoryIncome() {
    const next = Math.ceil((this.lastTick + 1) / 100) * 100 - 1;
    return next - this.lastTick;
  },

  /** Augmentation factor: floor(100 * (13440 - 6*tick) / 1920) / 100 */
  getAugmentationFactor() {
    if (this.lastTick >= MESSIAH.AUGMENTATION_END_TICK) return 1.0;
    if (this.lastTick < 0) return 7.0;
    return Math.floor(100 * (13440 - 6 * this.lastTick) / 1920) / 100;
  },

  /** IFS ticks: ticks within a cycle where attack instructions can be initiated
   *  Based on auInterval (conquest speed tier) */
  getIFSTicks(land) {
    const tier = SpeedTier.getTier(land);
    const auInterval = tier.auTicks;
    const ifsTicks = [];
    // IFS ticks are every auInterval ticks within the cycle
    for (let t = 0; t < MESSIAH.TICKS_PER_CYCLE; t += auInterval) {
      ifsTicks.push(t);
    }
    return ifsTicks;
  },

  /** Is current tick an IFS tick? */
  isIFSTick(land) {
    const tier = SpeedTier.getTier(land);
    const auInterval = tier.auTicks;
    return (this.tickInCycle % auInterval === 0);
  },

  /** Ticks until next IFS tick */
  ticksUntilIFS(land) {
    const tier = SpeedTier.getTier(land);
    const auInterval = tier.auTicks;
    const next = Math.ceil((this.tickInCycle + 1) / auInterval) * auInterval;
    return next - this.tickInCycle;
  },
};


/* ================================================================
 *  DENSITY ANALYZER â€” troop density, income rate, interest prediction
 * ================================================================ */
const DensityAnalyzer = {
  getMyId() {
    try { return window.gameManager?.OwnPlayerId; } catch { return null; }
  },

  getTroops(playerId) {
    try { return window.playerData?.playerTroops?.[playerId] || 0; } catch { return 0; }
  },

  getLand(playerId) {
    try { return window.playerData?.landOwned?.[playerId] || 0; } catch { return 0; }
  },

  getDensity(playerId) {
    const land = this.getLand(playerId);
    if (land === 0) return 0;
    return this.getTroops(playerId) / land;
  },

  getMyTroops() { return this.getTroops(this.getMyId()); },
  getMyLand() { return this.getLand(this.getMyId()); },
  getMyDensity() { return this.getDensity(this.getMyId()); },

  getSoftCap(playerId) {
    return this.getLand(playerId) * MESSIAH.SOFT_LIMIT_DENSITY;
  },

  getHardCap(playerId) {
    return this.getLand(playerId) * MESSIAH.HARD_LIMIT_DENSITY;
  },

  getMySoftCap() { return this.getSoftCap(this.getMyId()); },
  getMyHardCap() { return this.getHardCap(this.getMyId()); },

  /** Balance limiting factor: 1.0 at/below soft cap, 0.0 at/above hard cap, linear between */
  getBalanceLimitingFactor(playerId) {
    const bal = this.getTroops(playerId);
    const soft = this.getSoftCap(playerId);
    const hard = this.getHardCap(playerId);
    if (bal <= soft) return 1.0;
    if (bal >= hard) return 0.0;
    return (hard - bal) / (hard - soft);
  },

  getMyBalanceLimitingFactor() { return this.getBalanceLimitingFactor(this.getMyId()); },

  /** Territorial interest rate: 1.00% + (0.16 * sqrt(occupation))% */
  getTerritorialInterestRate(playerId) {
    const land = this.getLand(playerId);
    const totalPixels = window.gameManager?.gS || 500000;
    const occupation = land / totalPixels;
    return MESSIAH.BASE_INTEREST + MESSIAH.LAND_INTEREST_FACTOR * Math.sqrt(occupation);
  },

  getMyTerritorialInterestRate() { return this.getTerritorialInterestRate(this.getMyId()); },

  /** Full effective interest rate per tick */
  getMyEffectiveInterestRate() {
    const territorial = this.getMyTerritorialInterestRate();
    const augmentation = CycleTracker.getAugmentationFactor();
    const limiting = this.getMyBalanceLimitingFactor();
    return territorial * augmentation * limiting;
  },

  /** Is my density in red zone? (above soft cap) */
  isRedZone() {
    return this.getMyDensity() > MESSIAH.SOFT_LIMIT_DENSITY;
  },

  /** Is my density at hard cap? */
  isHardCapped() {
    return this.getMyDensity() >= MESSIAH.HARD_LIMIT_DENSITY;
  },

  /** Am I in danger zone? (too low density to defend) */
  isInDanger() {
    return this.getMyDensity() < MESSIAH.SAFE_DENSITY_THRESHOLD;
  },

  /** Predicted balance after N ticks (compound interest + income) */
  predictBalance(ticks) {
    let bal = this.getMyTroops();
    const rate = this.getMyEffectiveInterestRate();
    const land = this.getMyLand();
    const incomeTicks = Math.floor(ticks / MESSIAH.TICKS_PER_CYCLE);

    for (let i = 0; i < ticks; i++) {
      bal *= (1 + rate);
      bal = Math.min(bal, this.getMyHardCap());
    }
    // Add territory income
    bal += incomeTicks * land;
    return Math.min(bal, this.getMyHardCap());
  },

  /** Predicted balance after exactly 1 cycle (10 ticks) */
  predictBalanceNextCycle() {
    return this.predictBalance(MESSIAH.TICKS_PER_CYCLE);
  },

  /** Optimal attack % to maintain target density after expansion */
  getOptimalExpandPercent() {
    const troops = this.getMyTroops();
    const land = this.getMyLand();
    const density = this.getMyDensity();
    const target = MESSIAH.TARGET_DENSITY;
    const hardCap = this.getMyHardCap();

    if (troops <= 0 || land <= 0) return 0;

    // If already at/below target, expand more aggressively
    if (density <= target) {
      // How much land can we gain while keeping density near target?
      // target = troops / (land + newLand) => newLand = troops/target - land
      const idealLand = troops / target;
      const landToGain = idealLand - land;
      if (landToGain <= 0) return 1;
      // Estimate: each 1% attack captures ~land*0.01*tier tiles
      const tier = SpeedTier.getTier(land).tier;
      const tilesPerPercent = land * 0.01 * tier;
      const pct = landToGain / Math.max(1, tilesPerPercent);
      return Math.max(1, Math.min(50, Math.round(pct)));
    }

    // If above target but below soft cap, expand gently
    if (density < MESSIAH.SOFT_LIMIT_DENSITY) {
      // Drain just enough troops to reach target
      const excessTroops = troops - (land * target);
      const pct = (excessTroops / troops) * 100;
      return Math.max(1, Math.min(30, Math.round(pct)));
    }

    // In red zone: minimal expansion
    return 1;
  },
};


/* ================================================================
 *  CONQUEST SPEED â€” tier tracking
 * ================================================================ */
const SpeedTier = {
  getTier(land) {
    const tiers = MESSIAH.CONQUEST_TIERS;
    for (let i = 0; i < tiers.length; i++) {
      if (land < tiers[i].maxLand) return { ...tiers[i], level: i + 1 };
    }
    return { ...tiers[tiers.length - 1], level: tiers.length };
  },

  getMyTier() {
    return this.getTier(DensityAnalyzer.getMyLand());
  },
};


/* ================================================================
 *  BORDER MANAGER â€” border analysis, compactness, terrain
 * ================================================================ */
const BorderManager = {
  _cachedEnemies: null,
  _cacheTick: -1,

  /** Get all bordering player IDs with detailed border info */
  getBorderingPlayers() {
    const myId = DensityAnalyzer.getMyId();
    if (myId == null) return new Map();

    const tick = CycleTracker.lastTick;
    if (this._cachedEnemies && this._cacheTick === tick) return this._cachedEnemies;

    const pd = window.playerData;
    const offsets = window.mapData?.neighborOffsets;
    const landData = pd?.landOwned;
    const troopData = pd?.playerTroops;
    const as = window.gameManager?.arraySize;

    if (!offsets || !landData || !troopData || !as) return new Map();

    const myBorderTiles = pd.gp?.[myId];
    if (!myBorderTiles || myBorderTiles.length === 0) {
      this._cachedEnemies = new Map();
      this._cacheTick = tick;
      return this._cachedEnemies;
    }

    const myTileSet = new Set(myBorderTiles);
    const players = new Map();

    for (let pid = 0; pid < as; pid++) {
      if (pid === myId) continue;
      if (!landData[pid] || landData[pid] === 0) continue;

      const theirTiles = pd.gp?.[pid];
      if (!theirTiles) continue;

      let shared = 0;
      let closestDist = Infinity;

      for (let t = 0; t < theirTiles.length; t++) {
        const c = theirTiles[t];
        for (let d = 0; d < offsets.length; d++) {
          if (myTileSet.has(c - offsets[d])) {
            shared++;
            if (t < closestDist) closestDist = t;
            break;
          }
        }
      }

      if (shared > 0) {
        players.set(pid, {
          id: pid,
          sharedBorder: shared,
          closestDist: closestDist,
          troops: troopData[pid] || 0,
          land: landData[pid] || 0,
          density: landData[pid] > 0 ? (troopData[pid] || 0) / landData[pid] : 999,
          isNeutral: (pid === 0 || pid === (window.gameManager?.yB || 512)),
        });
      }
    }

    this._cachedEnemies = players;
    this._cacheTick = tick;
    return players;
  },

  /** Get only actual enemy players (not neutral) */
  getBorderingEnemies() {
    const all = this.getBorderingPlayers();
    const enemies = new Map();
    for (const [id, info] of all) {
      if (!info.isNeutral) enemies.set(id, info);
    }
    return enemies;
  },

  /** Get bordering neutral territory info */
  getBorderingNeutral() {
    const all = this.getBorderingPlayers();
    for (const [id, info] of all) {
      if (info.isNeutral) return info;
    }
    return null;
  },

  /** Get my border tile count */
  getMyBorderCount() {
    const myId = DensityAnalyzer.getMyId();
    try { return window.playerData?.gp?.[myId]?.length || 0; } catch { return 0; }
  },

  /** Border compactness ratio (border/total land) â€” lower = more compact = better defense */
  getCompactness() {
    const land = DensityAnalyzer.getMyLand();
    if (land === 0) return 0;
    return this.getMyBorderCount() / land;
  },

  /** Defense quality score (higher = better defense) */
  getDefenseScore() {
    const compactness = this.getCompactness();
    const density = DensityAnalyzer.getMyDensity();
    // Compact territory with good density = high defense score
    return (1 - Math.min(compactness, 1)) * Math.min(density, 150);
  },

  /** Find mountain passes â€” mountains adjacent to both us and an enemy */
  findMountainPasses() {
    const myId = DensityAnalyzer.getMyId();
    if (myId == null) return [];

    const pd = window.playerData;
    const offsets = window.mapData?.neighborOffsets;
    const ga = pd?.ga; // secondary border tiles (mountains)
    if (!ga || !offsets) return [];

    const myGa = ga[myId]; // my mountain-adjacent border tiles
    if (!myGa) return [];

    const passes = [];
    const myLandSet = new Set(pd.gp?.[myId] || []);

    // For each of my secondary border tiles, check if it's near enemy territory
    for (let i = 0; i < myGa.length; i++) {
      const tile = myGa[i];
      for (let d = 0; d < offsets.length; d++) {
        const neighbor = tile + offsets[d];
        // Check if this neighbor belongs to an enemy
        // We'd need the tile ownership map for pixel-level check
        // Fallback: check if any bordering player's tiles are near this mountain
      }
    }
    return passes;
  },

  /** Get total shared border length with all enemies */
  getTotalEnemyBorder() {
    let total = 0;
    const enemies = this.getBorderingEnemies();
    for (const [, info] of enemies) total += info.sharedBorder;
    return total;
  },

  /** Threat assessment: how dangerous is each enemy? */
  assessThreats() {
    const enemies = this.getBorderingEnemies();
    const myTroops = DensityAnalyzer.getMyTroops();
    const myLand = DensityAnalyzer.getMyLand();
    const myDensity = DensityAnalyzer.getMyDensity();
    const threats = [];

    for (const [id, enemy] of enemies) {
      // Threat score: higher = more dangerous
      let threat = 0;

      // 1. Troop ratio (enemy troops / my troops)
      const troopRatio = myTroops > 0 ? enemy.troops / myTroops : 999;
      threat += troopRatio * 30;

      // 2. Density advantage (enemy density / my density)
      const densityRatio = myDensity > 0 ? enemy.density / myDensity : 999;
      threat += densityRatio * 25;

      // 3. Growth potential (enemy land as fraction of mine â€” bigger = more income)
      const landRatio = myLand > 0 ? enemy.land / myLand : 0;
      threat += landRatio * 20;

      // 4. Border pressure (more shared border = more attack surface)
      const totalBorder = this.getTotalEnemyBorder();
      const borderPressure = totalBorder > 0 ? enemy.sharedBorder / totalBorder : 0;
      threat += borderPressure * 15;

      // 5. Low density enemies are easy kills (negative threat = opportunity)
      if (enemy.density < myDensity * 0.7) {
        threat -= 20;
      }

      threats.push({
        ...enemy,
        threatScore: threat,
        isEasy: enemy.density < myDensity * 0.6,
        isDangerous: troopRatio > 0.8 && densityRatio > 0.8,
      });
    }

    // Sort: most dangerous first, then easiest kills
    threats.sort((a, b) => {
      if (a.isDangerous && !b.isDangerous) return -1;
      if (!a.isDangerous && b.isDangerous) return 1;
      if (a.isEasy && b.isEasy) return a.density - b.density;
      return b.threatScore - a.threatScore;
    });

    return threats;
  },
};


/* ================================================================
 *  ATTACK ENGINE â€” smart multi-target with formula, density, borders
 * ================================================================ */
const percentToValue = (p) =>
  Math.max(0, Math.min(1023, Math.floor(1024 * (p / 100) + 0.5) - 1));

function attackTarget(unitRatio, targetPlayerId) {
  try {
    return window.protocolHandler?.gameCommandSender.attackTargetHandler(unitRatio, targetPlayerId);
  } catch (e) {
    console.error('[MESSIAH] attackTarget failed:', e);
    return false;
  }
}

function attackTargetSP(ownPlayerId, unitRatio, targetPlayer) {
  try {
    return window.protocolHandler?.localCommandProcessor.attackTargetSp(ownPlayerId, unitRatio, targetPlayer);
  } catch (e) {
    console.error('[MESSIAH] attackTargetSP failed:', e);
    return false;
  }
}

function sendBoatAttack(unitRatio, targetPlayerId) {
  try {
    return window.protocolHandler?.gameCommandSender.sendBoatHandler(unitRatio, targetPlayerId);
  } catch (e) {
    console.error('[MESSIAH] sendBoat failed:', e);
    return false;
  }
}

function cancelAttack(targetPlayerId) {
  try {
    return window.protocolHandler?.gameCommandSender.cancelAttackHandler(targetPlayerId);
  } catch (e) {
    console.error('[MESSIAH] cancelAttack failed:', e);
    return false;
  }
}

function mountainAttack(unitRatio, tileIndex, targetPlayer) {
  try {
    return window.protocolHandler?.gameCommandSender.hb(unitRatio, tileIndex, targetPlayer);
  } catch (e) {
    console.error('[MESSIAH] mountainAttack failed:', e);
    return false;
  }
}

function donateTroops(unitRatio, targetPlayerId) {
  try {
    return window.protocolHandler?.gameCommandSender.donateHandler(unitRatio, targetPlayerId);
  } catch (e) {
    console.error('[MESSIAH] donate failed:', e);
    return false;
  }
}

const AttackEngine = {
  lastAttackTick: new Map(),
  activeAttacks: new Set(),
  cancelledAttacks: new Set(),
  totalTroopsSent: new Map(),  // Track total troops sent to each target

  /** Calculate exact troops needed to conquer enemy */
  calculateTroopsNeeded(enemy) {
    // Defense is 2x attack: need 2x their balance + 2x their land defense
    const enemyDefense = enemy.troops * MESSIAH.DEFENSE_MULTIPLIER
      + enemy.land * MESSIAH.SOFT_LIMIT_DENSITY * 0.5;
    // Add tax overhead: needed / (1 - tax)
    const withTax = enemyDefense / (1 - MESSIAH.LAND_ATTACK_TAX);
    return Math.ceil(withTax);
  },

  /** Can I afford to send X% without dropping below safe density? */
  canAfford(percent, reservePercent = 0) {
    const myTroops = DensityAnalyzer.getMyTroops();
    const myLand = DensityAnalyzer.getMyLand();
    const sendTroops = myTroops * (percent / 100);
    const remaining = myTroops - sendTroops;
    const remainingDensity = myLand > 0 ? remaining / myLand : 0;
    return remainingDensity >= MESSIAH.SAFE_DENSITY_THRESHOLD - reservePercent;
  },

  /** Smart attack formula: exact % based on enemy data */
  calculateAttackPercent(enemy) {
    const myTroops = DensityAnalyzer.getMyTroops();
    if (myTroops <= 0 || enemy.land <= 0) return 0;

    const needed = this.calculateTroopsNeeded(enemy);
    const percent = (needed / myTroops) * 100;

    // Add 20% safety margin
    const withSafety = percent * 1.2;

    // If we can't afford full kill, send what we can safely
    if (!this.canAfford(withSafety)) {
      // Send max safe amount
      const safePercent = this.getMaxSafeAttackPercent(enemy);
      return safePercent;
    }

    return Math.max(1, Math.min(90, Math.round(withSafety)));
  },

  /** Density-based attack: proportional to density advantage */
  calculateDensityAttack(enemy) {
    const myDensity = DensityAnalyzer.getMyDensity();
    if (myDensity <= enemy.density) return 0;

    const ratio = myDensity / Math.max(1, enemy.density);
    let pct;
    if (ratio > 4) pct = 2;
    else if (ratio > 3) pct = 3;
    else if (ratio > 2) pct = 5;
    else if (ratio > 1.5) pct = 8;
    else if (ratio > 1.2) pct = 12;
    else pct = 18;

    // Verify we can afford it
    if (!this.canAfford(pct)) return 0;
    return pct;
  },

  /** Border-weighted attack */
  calculateBorderAttack(enemy, allEnemies) {
    const totalBorder = BorderManager.getTotalEnemyBorder();
    if (totalBorder === 0) return 10;

    const borderWeight = enemy.sharedBorder / totalBorder;
    const percent = 5 + borderWeight * 20;
    const clamped = Math.max(3, Math.min(25, Math.round(percent)));

    if (!this.canAfford(clamped)) return 0;
    return clamped;
  },

  /** Speed-boost attack: send more when density is low for faster expansion */
  calculateSpeedBoostAttack(enemy) {
    const myDensity = DensityAnalyzer.getMyDensity();
    const myLand = DensityAnalyzer.getMyLand();
    const aug = CycleTracker.getAugmentationFactor();

    // During augmentation, be more aggressive
    let basePercent = 15;
    if (aug > 3) basePercent = 25;
    else if (aug > 1.5) basePercent = 20;

    // Scale by density: lower density = can afford more
    if (myDensity < MESSIAH.TARGET_DENSITY - 20) basePercent *= 1.5;
    else if (myDensity < MESSIAH.TARGET_DENSITY) basePercent *= 1.2;
    else if (myDensity > MESSIAH.SOFT_LIMIT_DENSITY) basePercent *= 0.3;

    const percent = Math.round(basePercent);
    if (!this.canAfford(percent)) return 0;
    return Math.max(1, Math.min(50, percent));
  },

  /** Master attack: combines all formulas with mode selection */
  calculateOptimalAttack(enemy, allEnemies, mode) {
    switch (mode) {
      case 'formula': return this.calculateAttackPercent(enemy);
      case 'density': return this.calculateDensityAttack(enemy);
      case 'border': return this.calculateBorderAttack(enemy, allEnemies);
      case 'speedboost': return this.calculateSpeedBoostAttack(enemy);
      case 'smart': {
        const f = this.calculateAttackPercent(enemy);
        const d = this.calculateDensityAttack(enemy);
        const b = this.calculateBorderAttack(enemy, allEnemies);
        const s = this.calculateSpeedBoostAttack(enemy);
        // Weight: formula 30%, density 25%, border 20%, speed 25%
        return Math.max(1, Math.min(90, Math.round(f * 0.3 + d * 0.25 + b * 0.2 + s * 0.25)));
      }
      default: return microState.attackPercent;
    }
  },

  /** Get maximum safe attack % that won't drop below danger zone */
  getMaxSafeAttackPercent(enemy) {
    const myTroops = DensityAnalyzer.getMyTroops();
    const myLand = DensityAnalyzer.getMyLand();
    if (myLand <= 0) return 0;

    // Keep at least SAFE_DENSITY_THRESHOLD after attack
    const minTroops = myLand * MESSIAH.SAFE_DENSITY_THRESHOLD;
    const maxSend = myTroops - minTroops;
    if (maxSend <= 0) return 0;
    return Math.max(1, Math.min(90, Math.round((maxSend / myTroops) * 100)));
  },

  /** Execute attack with cycle-perfect timing awareness */
  executeAttack(enemy, percent) {
    if (percent <= 0) return false;
    if (!this.canAfford(percent)) return false;

    const tick = CycleTracker.lastTick;
    const lastTick = this.lastAttackTick.get(enemy.id) || -100;

    // IFS-aware cooldown: respect auInterval
    const myLand = DensityAnalyzer.getMyLand();
    const tier = SpeedTier.getTier(myLand);
    const minInterval = Math.max(1, Math.floor(tier.auTicks / 2));
    if (tick - lastTick < minInterval) return false;

    const result = attackTarget(percentToValue(percent), enemy.id);
    if (result !== false) {
      this.lastAttackTick.set(enemy.id, tick);
      this.activeAttacks.add(enemy.id);
      this.cancelledAttacks.delete(enemy.id);

      // Track troops sent
      const sent = DensityAnalyzer.getMyTroops() * (percent / 100);
      this.totalTroopsSent.set(enemy.id, (this.totalTroopsSent.get(enemy.id) || 0) + sent);

      microState.lastAttackTime = Date.now();
      microState.totalAttacks++;
      return true;
    }
    return false;
  },

  /** Cancel attack on a target (smart retreat) */
  retreatFrom(targetId) {
    if (this.activeAttacks.has(targetId)) {
      cancelAttack(targetId);
      this.activeAttacks.delete(targetId);
      this.cancelledAttacks.add(targetId);
      microState.totalRetreats++;
      return true;
    }
    return false;
  },

  /** Multi-target attack: distribute troops across multiple enemies */
  executeMultiTargetAttack(threats, mode) {
    if (threats.length === 0) return 0;
    if (threats.length === 1) {
      const pct = this.calculateOptimalAttack(threats[0], new Map(), mode);
      return this.executeAttack(threats[0], pct) ? 1 : 0;
    }

    const myTroops = DensityAnalyzer.getMyTroops();
    const maxTotalPercent = this.getMaxSafeAttackPercent(threats[0]);
    let attacksMade = 0;
    let totalPercentUsed = 0;

    // Calculate proportional split based on threat/opportunity
    const splits = [];
    let totalWeight = 0;

    for (const enemy of threats) {
      let weight;
      if (enemy.isEasy) {
        // Easy kills get higher weight (opportunity)
        weight = (1 - enemy.density / Math.max(1, DensityAnalyzer.getMyDensity())) * enemy.sharedBorder;
      } else {
        // Dangerous enemies get proportional threat weight
        weight = enemy.threatScore * enemy.sharedBorder;
      }
      weight = Math.max(0.1, weight);
      splits.push({ enemy, weight });
      totalWeight += weight;
    }

    // Normalize and distribute
    const maxTargets = Math.min(threats.length, microState.maxAttackTargets);
    const perTargetBudget = Math.min(maxTotalPercent / maxTargets, 35);

    for (let i = 0; i < Math.min(splits.length, maxTargets); i++) {
      const { enemy, weight } = splits[i];
      const proportion = weight / totalWeight;
      const allocPercent = Math.min(perTargetBudget, Math.round(maxTotalPercent * proportion));

      if (allocPercent < 2) continue;
      if (totalPercentUsed + allocPercent > maxTotalPercent) break;

      const pct = this.calculateOptimalAttack(enemy, new Map(), mode);
      const finalPct = Math.min(pct, allocPercent);

      if (this.executeAttack(enemy, finalPct)) {
        attacksMade++;
        totalPercentUsed += finalPct;
      }
    }

    return attacksMade;
  },
};


/* ================================================================
 *  DEFENSE ENGINE â€” threat detection, auto-hoard, smart retreat
 * ================================================================ */
const DefenseEngine = {
  isUnderAttack: false,
  incomingThreats: new Map(),
  lastBalance: 0,
  balanceHistory: [],

  update() {
    const myTroops = DensityAnalyzer.getMyTroops();
    const myLand = DensityAnalyzer.getMyLand();
    const myId = DensityAnalyzer.getMyId();

    if (!myId || myTroops <= 0) return;

    // Track balance history (last 5 ticks)
    this.balanceHistory.push({ tick: CycleTracker.lastTick, troops: myTroops });
    if (this.balanceHistory.length > 5) this.balanceHistory.shift();

    // Detect incoming attacks: if balance dropped significantly in 1 tick
    if (this.balanceHistory.length >= 2) {
      const prev = this.balanceHistory[this.balanceHistory.length - 2];
      const curr = this.balanceHistory[this.balanceHistory.length - 1];
      const diff = prev.troops - curr.troops;

      // Expected loss from own attacks (tax only)
      const expectedTax = AttackEngine.activeAttacks.size * (myTroops * MESSIAH.LAND_ATTACK_TAX);

      // If loss exceeds expected, we're being attacked
      const unexpectedLoss = diff - expectedTax;
      if (unexpectedLoss > myTroops * 0.05) {
        this.isUnderAttack = true;
      } else {
        this.isUnderAttack = false;
      }
    }

    // Check density danger
    const density = DensityAnalyzer.getMyDensity();
    const enemies = BorderManager.getBorderingEnemies();

    // Calculate total enemy threat
    let maxEnemyTroopRatio = 0;
    for (const [, enemy] of enemies) {
      const ratio = enemy.troops / Math.max(1, myTroops);
      if (ratio > maxEnemyTroopRatio) maxEnemyTroopRatio = ratio;
    }

    // Determine if we should enter defense mode
    const shouldDefend =
      density < MESSIAH.SAFE_DENSITY_THRESHOLD ||
      (this.isUnderAttack && density < MESSIAH.TARGET_DENSITY) ||
      maxEnemyTroopRatio > 1.5;

    if (shouldDefend && AttackEngine.activeAttacks.size > 0) {
      this.enterDefenseMode();
    }
  },

  enterDefenseMode() {
    // Cancel attacks on dangerous enemies, keep attacks on easy kills
    const threats = BorderManager.assessThreats();
    const myDensity = DensityAnalyzer.getMyDensity();

    for (const targetId of [...AttackEngine.activeAttacks]) {
      const enemy = threats.find(t => t.id === targetId);
      if (!enemy) continue;

      // Retreat from dangerous enemies when density is low
      if (enemy.isDangerous && myDensity < MESSIAH.TARGET_DENSITY) {
        AttackEngine.retreatFrom(targetId);
      }
    }

    BotState.setMode('defense');
  },

  shouldSkipAttack() {
    return this.isUnderAttack && DensityAnalyzer.getMyDensity() < MESSIAH.TARGET_DENSITY;
  },
};


/* ================================================================
 *  SPEED BOOST ENGINE â€” self-sustaining expansion acceleration
 * ================================================================ */
const SpeedBoostEngine = {
  isActive: false,
  boostHistory: [],

  /** Calculate if speed boost is achievable */
  canBoost() {
    const density = DensityAnalyzer.getMyDensity();
    const aug = CycleTracker.getAugmentationFactor();
    const interestRate = DensityAnalyzer.getMyEffectiveInterestRate();

    // Speed boost works when:
    // 1. Density is below target (room to expand)
    // 2. Interest rate is high enough to sustain continuous expansion
    // 3. We have enough troops to not bottom out
    return density < MESSIAH.TARGET_DENSITY &&
           interestRate > 0.02 &&
           DensityAnalyzer.getMyTroops() > DensityAnalyzer.getMyLand() * 50;
  },

  /** Get optimal expansion % for speed boost phase */
  getBoostPercent() {
    const density = DensityAnalyzer.getMyDensity();
    const predicted = DensityAnalyzer.predictBalanceNextCycle();
    const current = DensityAnalyzer.getMyTroops();
    const land = DensityAnalyzer.getMyLand();

    // The goal: expand just enough that next cycle's income fills us back to target density
    // predicted + income - attack_cost â‰ˆ target_density * (land + gained)
    // Simplified: attack% = (current - target_density*land) / current * 100
    const idealTroops = land * MESSIAH.TARGET_DENSITY;
    const excess = current - idealTroops;
    if (excess <= 0) return 1; // Below target, minimal expand to gain land

    const pct = (excess / current) * 100;

    // During augmentation, boost more aggressively
    const aug = CycleTracker.getAugmentationFactor();
    const augMultiplier = aug > 2 ? 1.5 : aug > 1 ? 1.2 : 1.0;

    return Math.max(1, Math.min(50, Math.round(pct * augMultiplier)));
  },

  processTick(tick) {
    if (!features.speedBoost) return;
    if (!EchoAPI.check()) return;

    this.isActive = this.canBoost();
    if (!this.isActive) return;

    // Only act on IFS ticks
    const myLand = DensityAnalyzer.getMyLand();
    if (!CycleTracker.isIFSTick(myLand)) return;

    // Don't boost if in defense mode
    if (BotState.state === 'defense') return;

    const neutral = BorderManager.getBorderingNeutral();
    if (!neutral) return;

    const pct = this.getBoostPercent();
    if (pct >= 1) {
      const neutralId = window.gameManager?.yB || 512;
      attackTarget(percentToValue(pct), neutralId);
      microState.totalBoosts++;
    }
  },
};


/* ================================================================
 *  OPENING ENGINE â€” TerriEngine-inspired V6 perfect opening
 * ================================================================ */
const OpeningEngine = {
  /** TerriEngine V6-inspired opening â€” optimized for max land by cycle 5
   *  Uses reinforcement attacks (tiny sends to keep attack wave alive)
   *  and PIAI (Pre-Interest Attack Initialization) timing.
   *  All attacks timed to resolve JUST BEFORE income tick for max compounding. */
  getOpeningMoves() {
    const neutralId = window.gameManager?.yB || 512;
    return [
      // Cycle 1 â€” Initial burst (ticks 60, 81) â€” PIAI timing
      { tick: 60,  pct: 20.8,  target: neutralId, type: 'expand' },
      { tick: 81,  pct: 17.9,  target: neutralId, type: 'expand' },

      // Cycle 2 â€” Growth phase (ticks 151, 165, 172, 186)
      { tick: 151, pct: 16.7,  target: neutralId, type: 'expand' },
      { tick: 165, pct: 18.6,  target: neutralId, type: 'expand' },
      { tick: 172, pct: 39.8,  target: neutralId, type: 'expand' },
      { tick: 186, pct: 24.1,  target: neutralId, type: 'expand' },

      // Cycle 3 â€” Reinforcement + expansion
      { tick: 256, pct: 0.1,   target: neutralId, type: 'reinforce' },
      { tick: 263, pct: 22.4,  target: neutralId, type: 'expand' },
      { tick: 270, pct: 52.5,  target: neutralId, type: 'expand' },
      { tick: 284, pct: 30.0,  target: neutralId, type: 'expand' },

      // Cycle 4 â€” Push phase
      { tick: 354, pct: 0.01,  target: neutralId, type: 'reinforce' },
      { tick: 361, pct: 47.1,  target: neutralId, type: 'expand' },
      { tick: 375, pct: 35.8,  target: neutralId, type: 'expand' },
      { tick: 382, pct: 87.4,  target: neutralId, type: 'expand' },

      // Cycle 5 â€” Finalize opening
      { tick: 452, pct: 28.6,  target: neutralId, type: 'expand' },
      { tick: 466, pct: 23.7,  target: neutralId, type: 'expand' },
      { tick: 473, pct: 31.6,  target: neutralId, type: 'expand' },
      { tick: 480, pct: 71.0,  target: neutralId, type: 'expand' },
    ];
  },

  executedMoves: new Set(),
  openingComplete: false,

  processTick(tick) {
    if (!features.autoOpen) return;
    if (this.openingComplete) return;

    const moves = this.getOpeningMoves();
    const lastMoveTick = moves[moves.length - 1].tick;

    if (tick > lastMoveTick + 20) {
      this.openingComplete = true;
      BotState.setMode('expansion');
      return;
    }

    for (const move of moves) {
      if (move.tick === tick && !this.executedMoves.has(tick)) {
        this.executedMoves.add(tick);
        attackTarget(percentToValue(move.pct), move.target);
      }
    }
  },
};


/* ================================================================
 *  EXPANSION ENGINE â€” perfect infinite expansion (density-targeted)
 * ================================================================ */
const ExpansionEngine = {
  lastExpandTick: -100,
  consecutiveExpansions: 0,

  processTick(tick) {
    if (!features.autoExpand) return;
    if (!EchoAPI.check()) return;

    const myId = DensityAnalyzer.getMyId();
    if (myId == null) return;

    // Don't expand if in defense mode
    if (BotState.state === 'defense') return;

    // Don't expand if hard capped
    if (DensityAnalyzer.isHardCapped()) return;

    // Density-adaptive expansion %
    let pct;
    if (features.useDensityExpand) {
      pct = DensityAnalyzer.getOptimalExpandPercent();
    } else {
      pct = features.expandPercent;
    }

    // Reduce in red zone
    if (DensityAnalyzer.isRedZone()) {
      pct = Math.max(1, pct * 0.2);
    }

    // In augmentation, expand more aggressively
    if (CycleTracker.isInAugmentation) {
      const aug = CycleTracker.getAugmentationFactor();
      pct = Math.min(pct * (1 + (aug - 1) * 0.3), 50);
    }

    // Cycle-perfect timing: expand on IFS ticks, 2-3 ticks before income
    const ticksToIncome = CycleTracker.ticksUntilIncome();
    const myLand = DensityAnalyzer.getMyLand();
    const isIFS = CycleTracker.isIFSTick(myLand);

    // Expand at optimal time: IFS tick that's 2-3 ticks before income
    const shouldExpand = isIFS && (ticksToIncome <= 3 && ticksToIncome >= 1);

    if (shouldExpand && pct >= 1) {
      const neutralId = window.gameManager?.yB || 512;
      const result = attackTarget(percentToValue(pct), neutralId);
      if (result !== false) {
        this.lastExpandTick = tick;
        this.consecutiveExpansions++;
        microState.totalExpansions++;
      }
    }
  },
};


/* ================================================================
 *  ATTACK DURING EXPANSION â€” multitask expansion + combat
 * ================================================================ */
const AttackDuringExpansion = {
  processTick(tick) {
    if (!features.attackDuringExp) return;
    if (!EchoAPI.check()) return;
    if (BotState.state === 'defense') return;

    const myId = DensityAnalyzer.getMyId();
    if (myId == null) return;

    const enemies = BorderManager.getBorderingEnemies();
    if (enemies.size === 0) return;

    const threats = BorderManager.assessThreats();
    const easyKills = threats.filter(t => t.isEasy);
    if (easyKills.length === 0) return;

    const ticksToIncome = CycleTracker.ticksUntilIncome();
    const myLand = DensityAnalyzer.getMyLand();

    // Attack at IFS ticks that DON'T conflict with expansion (ticks 5-7 in cycle)
    const isIFS = CycleTracker.isIFSTick(myLand);
    if (isIFS && ticksToIncome >= 3 && ticksToIncome <= 7) {
      // Attack weakest enemy
      const target = easyKills[0];
      const pct = AttackEngine.calculateDensityAttack(target);
      if (pct > 0) {
        AttackEngine.executeAttack(target, Math.min(pct, 15));
      }
    }
  },
};


/* ================================================================
 *  BOAT ENGINE â€” automated coastal attacks
 * ================================================================ */
const BoatEngine = {
  activeBoats: new Map(),
  lastBoatTick: -100,

  /** Check if we have coastal access */
  hasCoastalAccess() {
    try {
      const myId = DensityAnalyzer.getMyId();
      const pd = window.playerData;
      // bJ = boat border tiles
      return pd?.bJ?.[myId]?.length > 0;
    } catch { return false; }
  },

  /** Find weak coastal enemies */
  findCoastalTargets() {
    const enemies = BorderManager.getBorderingEnemies();
    const targets = [];
    for (const [id, enemy] of enemies) {
      // Check if enemy has boat-accessible coast
      try {
        const hasCoast = window.playerData?.bJ?.[id]?.length > 0;
        if (hasCoast && enemy.density < DensityAnalyzer.getMyDensity() * 0.7) {
          targets.push(enemy);
        }
      } catch {}
    }
    targets.sort((a, b) => a.density - b.density);
    return targets;
  },

  processTick(tick) {
    if (!features.autoBoat) return;
    if (!this.hasCoastalAccess()) return;
    if (BotState.state === 'defense') return;

    const cooldown = 20; // Don't spam boats
    if (tick - this.lastBoatTick < cooldown) return;

    const targets = this.findCoastalTargets();
    if (targets.length === 0) return;

    const target = targets[0];
    const myTroops = DensityAnalyzer.getMyTroops();
    const myLand = DensityAnalyzer.getMyLand();

    // Send small boat attack (3-8%)
    const pct = Math.min(8, Math.max(3, Math.round(
      (target.density / Math.max(1, DensityAnalyzer.getMyDensity())) * 10
    )));

    if (myTroops * (pct / 100) >= MESSIAH.MIN_BOAT_STRENGTH) {
      if (AttackEngine.canAfford(pct, 10)) {
        sendBoatAttack(percentToValue(pct), target.id);
        this.lastBoatTick = tick;
        microState.totalBoats++;
      }
    }
  },
};


/* ================================================================
 *  ALLIANCE ENGINE â€” auto-accept, smart donate
 * ================================================================ */
const AllianceEngine = {
  allies: new Set(),
  lastDonateTick: -100,

  /** Smart donate: donate before cycle end when interest is maximized */
  processTick(tick) {
    if (!features.autoAlliance) return;

    const ticksToIncome = CycleTracker.ticksUntilIncome();

    // Donate 1 tick before income (max compounded interest)
    if (ticksToIncome === 1 && this.allies.size > 0) {
      const myTroops = DensityAnalyzer.getMyTroops();
      const myDensity = DensityAnalyzer.getMyDensity();

      // Only donate if we're above target density
      if (myDensity > MESSIAH.TARGET_DENSITY && tick - this.lastDonateTick >= 10) {
        // Find weakest ally and donate 5%
        let weakestAlly = null;
        let lowestTroops = Infinity;

        for (const allyId of this.allies) {
          const troops = DensityAnalyzer.getTroops(allyId);
          if (troops < lowestTroops) {
            lowestTroops = troops;
            weakestAlly = allyId;
          }
        }

        if (weakestAlly !== null) {
          donateTroops(percentToValue(5), weakestAlly);
          this.lastDonateTick = tick;
        }
      }
    }
  },
};


/* ================================================================
 *  BOT STATE MACHINE â€” dynamic mode switching
 * ================================================================ */
const BotState = {
  state: 'idle',  // idle, opening, expansion, attack, defense, cleanup, boat
  stateHistory: [],
  stateTicks: 0,

  setMode(mode) {
    if (this.state === mode) return;
    const prev = this.state;
    this.state = mode;
    this.stateTicks = 0;
    this.stateHistory.push({ from: prev, to: mode, tick: CycleTracker.lastTick });
  },

  /** Determine optimal mode based on game state */
  evaluateState() {
    const tick = CycleTracker.lastTick;
    const myTroops = DensityAnalyzer.getMyTroops();
    const myLand = DensityAnalyzer.getMyLand();
    const myDensity = DensityAnalyzer.getMyDensity();
    const enemies = BorderManager.getBorderingEnemies();
    const threats = BorderManager.assessThreats();
    const hasEnemies = enemies.size > 0;
    const hasEasyKills = threats.some(t => t.isEasy);
    const hasDanger = threats.some(t => t.isDangerous);

    this.stateTicks++;

    // Opening phase: first 5 cycles (tick 0-50)
    if (tick < 500 && features.autoOpen && !OpeningEngine.openingComplete) {
      this.setMode('opening');
      return;
    }

    // Defense: if under attack or density critically low
    if (DefenseEngine.isUnderAttack && myDensity < MESSIAH.TARGET_DENSITY) {
      this.setMode('defense');
      return;
    }
    if (myDensity < MESSIAH.SAFE_DENSITY_THRESHOLD && hasDanger) {
      this.setMode('defense');
      return;
    }

    // Attack: if we have easy kills and good density
    if (hasEasyKills && myDensity > MESSIAH.TARGET_DENSITY && !DensityAnalyzer.isRedZone()) {
      this.setMode('attack');
      return;
    }

    // Cleanup: late game, hunt weak players
    if (tick > 3000 && myLand > 50000 && hasEnemies && !hasDanger) {
      const weakEnemies = threats.filter(t => t.land < myLand * 0.1);
      if (weakEnemies.length > 0) {
        this.setMode('cleanup');
        return;
      }
    }

    // Expansion: default mode
    if (features.autoExpand) {
      this.setMode('expansion');
      return;
    }

    this.setMode('idle');
  },
};


/* ================================================================
 *  MICRO STATE
 * ================================================================ */
const microState = {
  attackPercent: 12,
  intervalMs: 400,
  attackInterval: null,
  isAttacking: false,
  attackMode: 'smart',
  attacksPerCycle: 2,
  maxAttackTargets: 3,
  totalAttacks: 0,
  totalRetreats: 0,
  totalExpansions: 0,
  totalBoosts: 0,
  totalBoats: 0,
  lastAttackTime: 0,
};


/* ================================================================
 *  MAIN ATTACK LOOP â€” state-machine driven with all engines
 * ================================================================ */
function startMicro() {
  if (!EchoAPI.check()) return;

  const myId = DensityAnalyzer.getMyId();
  if (myId == null) return;

  const pd = window.playerData;
  const myTroops = DensityAnalyzer.getMyTroops();
  const myLand = DensityAnalyzer.getMyLand();

  if (myTroops <= 0 || myLand <= 0) return;

  // Clean dead targets
  for (const id of [...AttackEngine.activeAttacks]) {
    if (!pd.landOwned[id] || pd.landOwned[id] === 0) {
      AttackEngine.activeAttacks.delete(id);
      AttackEngine.totalTroopsSent.delete(id);
    }
  }

  // Update defense engine
  DefenseEngine.update();

  // Skip attack if in defense mode
  if (DefenseEngine.shouldSkipAttack()) return;

  // Get threats
  const threats = BorderManager.assessThreats();
  if (threats.length === 0) return;

  // Filter out hard-capped density enemies
  const candidates = threats.filter(e =>
    e.troops > 0 && e.density < DensityAnalyzer.getMyDensity() * 2.5
  );

  if (candidates.length === 0) return;

  // State-based attack logic
  switch (BotState.state) {
    case 'attack': {
      // Aggressive multi-target on easy kills
      const easyKills = candidates.filter(c => c.isEasy);
      if (easyKills.length > 0) {
        AttackEngine.executeMultiTargetAttack(easyKills, microState.attackMode);
      } else {
        // No easy kills, attack weakest
        const pct = AttackEngine.calculateOptimalAttack(
          candidates[0], new Map(), microState.attackMode
        );
        AttackEngine.executeAttack(candidates[0], pct);
      }
      break;
    }
    case 'cleanup': {
      // Hunt weak players aggressively
      const weak = candidates.filter(c => c.land < myLand * 0.1);
      if (weak.length > 0) {
        AttackEngine.executeMultiTargetAttack(weak, microState.attackMode);
      }
      break;
    }
    case 'expansion': {
      // During expansion, only attack if attackDuringExp is on
      if (features.attackDuringExp) {
        const easyKills = candidates.filter(c => c.isEasy);
        if (easyKills.length > 0) {
          const pct = AttackEngine.calculateDensityAttack(easyKills[0]);
          AttackEngine.executeAttack(easyKills[0], Math.min(pct, 12));
        }
      }
      break;
    }
    case 'defense': {
      // In defense, only counter-attack very weak enemies
      const veryWeak = candidates.filter(c => c.density < DensityAnalyzer.getMyDensity() * 0.3);
      if (veryWeak.length > 0 && DensityAnalyzer.getMyDensity() > MESSIAH.TARGET_DENSITY) {
        const pct = AttackEngine.calculateDensityAttack(veryWeak[0]);
        AttackEngine.executeAttack(veryWeak[0], Math.min(pct, 5));
      }
      break;
    }
    default:
      break;
  }
}

function startAutoAttack() {
  if (microState.attackInterval) return;
  startMicro();
  microState.attackInterval = setInterval(startMicro, microState.intervalMs);
  if (echoSettings?.setMicroStatus) echoSettings.setMicroStatus(true);
}

function stopAutoAttack() {
  clearInterval(microState.attackInterval);
  microState.attackInterval = null;
  microState.isAttacking = false;
  if (echoSettings?.setMicroStatus) echoSettings.setMicroStatus(false);
}


/* ================================================================
 *  FEATURES STATE
 * ================================================================ */
const features = {
  autoOpen: false,
  autoExpand: false,
  useDensityExpand: true,    // NEW: use density-adaptive expansion %
  expandPercent: 25,
  attackDuringExp: false,
  speedBoost: false,          // NEW: speed boost system
  autoBoat: false,            // NEW: boat automation
  autoAlliance: false,        // NEW: alliance management
  autoDefense: true,          // NEW: auto defense (on by default)
  multiTarget: true,          // NEW: multi-target attacks
  esp: false,
  fullbright: false,
  legitMode: false,
  smartRetreat: true,         // NEW: auto retreat when losing
};


/* ================================================================
 *  WINDOW MANAGER
 * ================================================================ */
var WindowManager = {
  currentScreen: null,
  openWindow: function (screenName) {
    if (this.currentScreen && typeof this.currentScreen.hide === 'function')
      this.currentScreen.hide();
    if (screenName === 'echoSettings' || screenName === 'settings') {
      if (typeof echoSettings !== 'undefined') {
        echoSettings.show();
        this.currentScreen = echoSettings;
      }
    }
  },
  closeCurrent: function () {
    if (this.currentScreen && typeof this.currentScreen.hide === 'function')
      this.currentScreen.hide();
    this.currentScreen = null;
  },
};


/* ================================================================
 *  MOBILE FLOATING TOGGLE BUTTON
 * ================================================================ */
function createMobileToggle() {
  if (document.getElementById('echo-mobile-toggle')) return;
  const btn = document.createElement('div');
  btn.id = 'echo-mobile-toggle';
  btn.textContent = 'E';
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); echoSettings.toggle(); });
  document.body.appendChild(btn);

  let dragging = false, ox = 0, oy = 0, moved = false;
  btn.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; const r = btn.getBoundingClientRect();
    ox = t.clientX - r.left; oy = t.clientY - r.top;
    dragging = true; moved = false;
  }, { passive: true });
  btn.addEventListener('touchmove', (e) => {
    if (!dragging) return; e.preventDefault(); moved = true;
    const t = e.touches[0];
    let nx = Math.max(0, Math.min(window.innerWidth - 44, t.clientX - ox));
    let ny = Math.max(0, Math.min(window.innerHeight - 44, t.clientY - oy));
    btn.style.left = nx + 'px'; btn.style.top = ny + 'px';
    btn.style.right = 'auto'; btn.style.bottom = 'auto';
  }, { passive: false });
  btn.addEventListener('touchend', (e) => {
    dragging = false;
    if (moved) { e.preventDefault(); e.stopPropagation(); }
  });
}


/* ================================================================
 *  GUI â€” MESSIAH v4 EDITION (6 tabs)
 * ================================================================ */
function EchoSettings() {
  if (!document.getElementById('echo-font')) {
    const link = document.createElement('link');
    link.id = 'echo-font'; link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500&display=swap';
    document.head.appendChild(link);
  }

  const style = document.createElement('style');
  style.id = 'echo-gui-style';
  style.innerHTML = `
    :root {
      --eg-bg: #0a0812; --eg-surface: #110e1c; --eg-border: #2a1f4a;
      --eg-accent: #f59e0b; --eg-accent2: #fbbf24; --eg-text: #fde68a;
      --eg-muted: #92731a; --eg-toggle-off: #2e2040; --eg-danger: #ef4444;
      --eg-success: #22c55e; --eg-info: #3b82f6; --eg-purple: #a855f7;
    }
    #echo-gui * { box-sizing: border-box; margin: 0; padding: 0; }
    #echo-gui {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 300px; max-width: calc(100vw - 16px); max-height: calc(100vh - 60px);
      background: var(--eg-bg); border: 1px solid var(--eg-border); border-radius: 10px;
      color: var(--eg-text); font-family: 'Inter', sans-serif; font-size: 13px;
      box-shadow: 0 0 0 1px #f59e0b22, 0 8px 32px #0007, inset 0 1px 0 #ffffff08;
      display: none; z-index: 999999; user-select: none; -webkit-user-select: none;
      overflow: hidden; touch-action: none; -webkit-touch-callout: none;
    }
    #eg-titlebar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 14px; background: var(--eg-surface); border-bottom: 1px solid var(--eg-border);
      cursor: move; touch-action: none; min-height: 44px;
    }
    #eg-logo {
      font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 15px;
      letter-spacing: 2px; color: var(--eg-accent2); text-shadow: 0 0 12px #f59e0b66;
      pointer-events: none;
    }
    #eg-state {
      font-family: 'Rajdhani', sans-serif; font-weight: 600; font-size: 10px;
      letter-spacing: 1px; padding: 2px 8px; border-radius: 4px;
      pointer-events: none;
    }
    #eg-state.idle { background: #374151; color: #9ca3af; }
    #eg-state.opening { background: #7c3aed33; color: #a855f7; }
    #eg-state.expansion { background: #22c55e22; color: #22c55e; }
    #eg-state.attack { background: #ef444422; color: #ef4444; }
    #eg-state.defense { background: #f59e0b22; color: #f59e0b; }
    #eg-state.cleanup { background: #3b82f622; color: #3b82f6; }
    #eg-state.boat { background: #06b6d422; color: #06b6d4; }
    #eg-close {
      width: 32px; height: 32px; background: #3b2060; border: none; border-radius: 6px;
      color: var(--eg-text); cursor: pointer; font-size: 14px;
      display: flex; align-items: center; justify-content: center;
      min-width: 44px; min-height: 44px; -webkit-tap-highlight-color: transparent;
    }
    #eg-close:hover { background: var(--eg-accent); color: #000; }
    #eg-close:active { background: var(--eg-accent); color: #000; transform: scale(0.95); }
    #eg-tabs { display: flex; background: var(--eg-surface); border-bottom: 1px solid var(--eg-border); overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .eg-tab {
      flex: 1; padding: 8px 2px; text-align: center; font-family: 'Rajdhani', sans-serif;
      font-weight: 600; font-size: 9px; letter-spacing: 0.5px; text-transform: uppercase;
      color: var(--eg-muted); cursor: pointer; border-bottom: 2px solid transparent;
      -webkit-tap-highlight-color: transparent; min-height: 44px; white-space: nowrap;
      display: flex; align-items: center; justify-content: center;
    }
    .eg-tab:hover { color: var(--eg-text); }
    .eg-tab.active { color: var(--eg-accent2); border-bottom: 2px solid var(--eg-accent); }
    #eg-content { padding: 8px 14px 14px; overflow-y: auto; max-height: calc(100vh - 170px); -webkit-overflow-scrolling: touch; }
    .eg-panel { display: none; }
    .eg-panel.active { display: block; }
    .eg-section {
      font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 10px;
      letter-spacing: 2px; text-transform: uppercase; color: var(--eg-accent);
      margin: 8px 0 4px; padding-bottom: 2px; border-bottom: 1px solid var(--eg-border);
    }
    .eg-section:first-child { margin-top: 2px; }
    .eg-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; min-height: 44px; }
    .eg-label { font-size: 12px; color: #fde68a; font-weight: 400; }
    .eg-label small { color: var(--eg-muted); font-size: 9px; display: block; }
    .eg-toggle-wrap { position: relative; width: 44px; height: 26px; flex-shrink: 0; }
    .eg-toggle-wrap input { opacity: 0; width: 0; height: 0; position: absolute; }
    .eg-toggle-track {
      position: absolute; inset: 0; background: var(--eg-toggle-off); border-radius: 26px;
      cursor: pointer; transition: background .2s; border: 1px solid #3d2d5e;
    }
    .eg-toggle-track::after {
      content: ''; position: absolute; width: 20px; height: 20px; top: 2px; left: 2px;
      background: var(--eg-muted); border-radius: 50%; transition: transform .2s, background .2s;
    }
    .eg-toggle-wrap input:checked + .eg-toggle-track { background: var(--eg-accent); border-color: var(--eg-accent); }
    .eg-toggle-wrap input:checked + .eg-toggle-track::after { transform: translateX(18px); background: #000; }
    .eg-slider-wrap { display: flex; flex-direction: column; padding: 4px 0 6px; gap: 4px; }
    .eg-slider-header { display: flex; justify-content: space-between; align-items: center; }
    .eg-slider-val { font-family: 'Rajdhani', sans-serif; font-weight: 600; font-size: 12px; color: var(--eg-accent2); }
    .eg-slider {
      -webkit-appearance: none; appearance: none; width: 100%; height: 4px;
      border-radius: 4px; background: var(--eg-border); outline: none; cursor: pointer;
    }
    .eg-slider::-webkit-slider-thumb {
      -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%;
      background: var(--eg-accent2); cursor: pointer; box-shadow: 0 0 6px #f59e0b66;
    }
    .eg-slider::-moz-range-thumb { width: 22px; height: 22px; border-radius: 50%; background: var(--eg-accent2); cursor: pointer; border: none; }
    .eg-slider:disabled { opacity: 0.35; cursor: not-allowed; }
    .eg-btn-row { display: flex; gap: 6px; padding: 6px 0 4px; margin-top: 10px; }
    .eg-btn {
      flex: 1; padding: 10px 0; border: 1px solid var(--eg-border); border-radius: 6px;
      background: var(--eg-surface); color: var(--eg-text); font-family: 'Rajdhani', sans-serif;
      font-weight: 600; font-size: 12px; letter-spacing: 1px; text-transform: uppercase;
      cursor: pointer; min-height: 44px; display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    .eg-btn:hover { background: var(--eg-border); }
    .eg-btn:active { background: var(--eg-border); transform: scale(0.97); }
    .eg-btn.active { background: var(--eg-accent); border-color: var(--eg-accent); color: #000; }
    .eg-status { font-family: 'Rajdhani', sans-serif; font-size: 11px; letter-spacing: 1px; text-align: center; padding: 4px 0 0; color: var(--eg-muted); }
    .eg-status.on { color: var(--eg-success); }
    .eg-status.off { color: var(--eg-danger); }
    .eg-info { font-family: 'Rajdhani', sans-serif; font-size: 10px; color: var(--eg-muted); padding: 2px 0; letter-spacing: 0.5px; }
    .eg-info span { color: var(--eg-accent2); font-weight: 600; }
    .eg-select {
      background: var(--eg-surface); color: var(--eg-text); border: 1px solid var(--eg-border);
      border-radius: 6px; padding: 8px 10px; font-size: 12px; font-family: 'Inter', sans-serif;
      width: 100%; cursor: pointer; min-height: 44px; -webkit-tap-highlight-color: transparent;
    }
    .eg-select option { background: var(--eg-bg); color: var(--eg-text); }
    .eg-stat-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; }
    .eg-stat-label { color: var(--eg-muted); }
    .eg-stat-value { color: var(--eg-accent2); font-family: 'Rajdhani', sans-serif; font-weight: 600; }
    #echo-mobile-toggle {
      position: fixed; bottom: 20px; right: 20px; width: 44px; height: 44px;
      background: linear-gradient(135deg, #f59e0b, #fbbf24); border: 2px solid #f59e0b66;
      border-radius: 12px; color: #000; font-family: 'Rajdhani', sans-serif;
      font-weight: 700; font-size: 18px; display: flex; align-items: center; justify-content: center;
      z-index: 999998; cursor: pointer; box-shadow: 0 2px 12px #f59e0b88, 0 0 20px #f59e0b33;
      touch-action: none; -webkit-tap-highlight-color: transparent; user-select: none;
      -webkit-user-select: none; transition: transform 0.1s;
    }
    #echo-mobile-toggle:active { transform: scale(0.92); }
  `;
  if (!document.getElementById('echo-gui-style')) document.head.appendChild(style);

  const toggle = (label, id, extra) => `
    <div class="eg-row">
      <span class="eg-label">${label}${extra ? '<small>' + extra + '</small>' : ''}</span>
      <label class="eg-toggle-wrap"><input type="checkbox" id="${id}"><span class="eg-toggle-track"></span></label>
    </div>`;

  const slider = (label, id, min, max, val, unit) => `
    <div class="eg-slider-wrap">
      <div class="eg-slider-header">
        <span class="eg-label">${label}</span>
        <span class="eg-slider-val" id="${id}-val">${val}${unit}</span>
      </div>
      <input class="eg-slider" type="range" id="${id}" min="${min}" max="${max}" value="${val}">
    </div>`;

  this.gui = document.createElement('div');
  this.gui.id = 'echo-gui';
  this.gui.innerHTML = `
    <div id="eg-titlebar">
      <span id="eg-logo">MESSIAH v4</span>
      <span id="eg-state" class="idle">IDLE</span>
      <button id="eg-close">X</button>
    </div>
    <div id="eg-tabs">
      <div class="eg-tab active" data-tab="opening">Open</div>
      <div class="eg-tab" data-tab="expand">Expand</div>
      <div class="eg-tab" data-tab="attack">Attack</div>
      <div class="eg-tab" data-tab="defense">Defense</div>
      <div class="eg-tab" data-tab="advanced">Adv</div>
      <div class="eg-tab" data-tab="visuals">Vis</div>
    </div>
    <div id="eg-content">
      <!-- OPENING TAB -->
      <div class="eg-panel active" id="panel-opening">
        <div class="eg-section">Perfect Opening</div>
        ${toggle('Auto Opening', 'opt-opening-open', 'TerriEngine V6 timing')}
        <div class="eg-info">Tick-perfect expansion with reinforcement attacks</div>
      </div>

      <!-- EXPAND TAB -->
      <div class="eg-panel" id="panel-expand">
        <div class="eg-section">Infinite Expansion</div>
        ${toggle('Auto Expand', 'opt-auto-expand', 'Cycle-timed expansion')}
        ${toggle('Density Adaptive', 'opt-density-expand', 'Auto-calc optimal %')}
        ${slider('Manual Expand %', 'opt-expand-pct', 5, 50, 25, '%')}
        <div class="eg-section">Speed Boost</div>
        ${toggle('Speed Boost', 'opt-speed-boost', 'Self-sustaining acceleration')}
        <div class="eg-section">Multitask</div>
        ${toggle('Attack During Exp', 'opt-attack-during-exp', 'Kill enemies between expands')}
      </div>

      <!-- ATTACK TAB -->
      <div class="eg-panel" id="panel-attack">
        <div class="eg-section">Auto Attack</div>
        ${toggle('Enable Micro', 'opt-micro-enable', '')}
        <div class="eg-section">Attack Mode</div>
        <select class="eg-select" id="opt-attack-mode">
          <option value="smart">Smart (Combined)</option>
          <option value="formula">Formula (Exact Kill)</option>
          <option value="density">Density Based</option>
          <option value="border">Border Weighted</option>
          <option value="speedboost">Speed Boost</option>
          <option value="manual">Manual %</option>
        </select>
        <div class="eg-section">Controls</div>
        ${slider('Attack %', 'opt-attack-percent', 1, 90, 12, '%')}
        ${slider('Interval', 'opt-attack-interval', 100, 2000, 400, 'ms')}
        ${slider('Max Targets', 'opt-max-targets', 1, 5, 3, '')}
        <div class="eg-btn-row">
          <button class="eg-btn" id="micro-start-btn">START</button>
          <button class="eg-btn" id="micro-stop-btn">STOP</button>
        </div>
        <div class="eg-status off" id="micro-status">INACTIVE</div>
        <div class="eg-section">Options</div>
        ${toggle('Multi-Target', 'opt-multi-target', 'Attack multiple enemies')}
        ${toggle('Smart Retreat', 'opt-smart-retreat', 'Cancel attacks when losing')}
        ${toggle('Legit Mode', 'opt-legitmode', 'More human-like')}
      </div>

      <!-- DEFENSE TAB -->
      <div class="eg-panel" id="panel-defense">
        <div class="eg-section">Auto Defense</div>
        ${toggle('Defense Mode', 'opt-auto-defense', 'Auto-hoard when under fire')}
        <div class="eg-section">Boat Attacks</div>
        ${toggle('Auto Boat', 'opt-auto-boat', 'Attack weak coastal enemies')}
        <div class="eg-section">Alliance</div>
        ${toggle('Auto Alliance', 'opt-auto-alliance', 'Smart donate to allies')}
      </div>

      <!-- ADVANCED TAB -->
      <div class="eg-panel" id="panel-advanced">
        <div class="eg-section">Live Stats</div>
        <div id="eg-live-stats">
          <div class="eg-stat-row"><span class="eg-stat-label">Tick</span><span class="eg-stat-value" id="stat-tick">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Cycle</span><span class="eg-stat-value" id="stat-cycle">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Augmentation</span><span class="eg-stat-value" id="stat-aug">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Troops</span><span class="eg-stat-value" id="stat-troops">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Land</span><span class="eg-stat-value" id="stat-land">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Density</span><span class="eg-stat-value" id="stat-density">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Interest Rate</span><span class="eg-stat-value" id="stat-interest">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Borders</span><span class="eg-stat-value" id="stat-borders">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Enemies</span><span class="eg-stat-value" id="stat-enemies">-</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Compactness</span><span class="eg-stat-value" id="stat-compact">-</span></div>
        </div>
        <div class="eg-section">Session Stats</div>
        <div id="eg-session-stats">
          <div class="eg-stat-row"><span class="eg-stat-label">Attacks</span><span class="eg-stat-value" id="stat-attacks">0</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Expansions</span><span class="eg-stat-value" id="stat-expands">0</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Boosts</span><span class="eg-stat-value" id="stat-boosts">0</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Boats</span><span class="eg-stat-value" id="stat-boats">0</span></div>
          <div class="eg-stat-row"><span class="eg-stat-label">Retreats</span><span class="eg-stat-value" id="stat-retreats">0</span></div>
        </div>
      </div>

      <!-- VISUALS TAB -->
      <div class="eg-panel" id="panel-visuals">
        <div class="eg-section">Players</div>
        ${toggle('ESP', 'opt-esp', 'Show player info')}
        <div class="eg-section">World</div>
        ${toggle('Fullbright', 'opt-fullbright', 'Remove fog of war')}
      </div>
    </div>
  `;

  const bindToggle = (id, fn) => {
    const el = this.gui.querySelector('#' + id);
    if (el) el.addEventListener('change', () => fn(el.checked));
  };

  const wireToggles = () => {
    bindToggle('opt-opening-open', (v) => { features.autoOpen = v; });
    bindToggle('opt-auto-expand', (v) => { features.autoExpand = v; });
    bindToggle('opt-density-expand', (v) => { features.useDensityExpand = v; });
    bindToggle('opt-speed-boost', (v) => { features.speedBoost = v; });
    bindToggle('opt-attack-during-exp', (v) => { features.attackDuringExp = v; });
    bindToggle('opt-auto-defense', (v) => { features.autoDefense = v; });
    bindToggle('opt-auto-boat', (v) => { features.autoBoat = v; });
    bindToggle('opt-auto-alliance', (v) => { features.autoAlliance = v; });
    bindToggle('opt-esp', (v) => { features.esp = v; });
    bindToggle('opt-fullbright', (v) => { features.fullbright = v; });
    bindToggle('opt-legitmode', (v) => { features.legitMode = v; });
    bindToggle('opt-smart-retreat', (v) => { features.smartRetreat = v; });
    bindToggle('opt-multi-target', (v) => { features.multiTarget = v; });
    bindToggle('opt-micro-enable', (v) => { v ? startAutoAttack() : stopAutoAttack(); });

    // Attack mode selector
    const modeSelect = this.gui.querySelector('#opt-attack-mode');
    if (modeSelect) modeSelect.addEventListener('change', () => {
      microState.attackMode = modeSelect.value;
      const pctSlider = this.gui.querySelector('#opt-attack-percent');
      if (pctSlider) pctSlider.disabled = modeSelect.value !== 'manual';
    });

    // Expand percent
    const epSlider = this.gui.querySelector('#opt-expand-pct');
    const epVal = this.gui.querySelector('#opt-expand-pct-val');
    if (epSlider) epSlider.addEventListener('input', () => {
      features.expandPercent = parseInt(epSlider.value);
      if (epVal) epVal.textContent = features.expandPercent + '%';
    });

    // Attack percent
    const pSlider = this.gui.querySelector('#opt-attack-percent');
    const pVal = this.gui.querySelector('#opt-attack-percent-val');
    if (pSlider) pSlider.addEventListener('input', () => {
      microState.attackPercent = parseInt(pSlider.value);
      if (pVal) pVal.textContent = microState.attackPercent + '%';
    });

    // Interval
    const iSlider = this.gui.querySelector('#opt-attack-interval');
    const iVal = this.gui.querySelector('#opt-attack-interval-val');
    if (iSlider) iSlider.addEventListener('input', () => {
      microState.intervalMs = parseInt(iSlider.value);
      if (iVal) iVal.textContent = microState.intervalMs + 'ms';
      if (microState.attackInterval) {
        clearInterval(microState.attackInterval);
        microState.attackInterval = setInterval(startMicro, microState.intervalMs);
      }
    });

    // Max targets
    const tSlider = this.gui.querySelector('#opt-max-targets');
    const tVal = this.gui.querySelector('#opt-max-targets-val');
    if (tSlider) tSlider.addEventListener('input', () => {
      microState.maxAttackTargets = parseInt(tSlider.value);
      if (tVal) tVal.textContent = microState.maxAttackTargets;
    });

    const startBtn = this.gui.querySelector('#micro-start-btn');
    const stopBtn = this.gui.querySelector('#micro-stop-btn');
    if (startBtn) startBtn.addEventListener('click', startAutoAttack);
    if (stopBtn) stopBtn.addEventListener('click', stopAutoAttack);
  };

  const bindTabs = () => {
    this.gui.querySelectorAll('.eg-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.gui.querySelectorAll('.eg-tab').forEach(t => t.classList.remove('active'));
        this.gui.querySelectorAll('.eg-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = this.gui.querySelector('#panel-' + tab.dataset.tab);
        if (panel) panel.classList.add('active');
      });
    });
  };

  const bindClose = () => {
    const btn = this.gui.querySelector('#eg-close');
    if (btn) btn.addEventListener('click', () => this.hide());
  };

  const bindDrag = () => {
    const bar = this.gui.querySelector('#eg-titlebar');
    let ox = 0, oy = 0, dragging = false;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.id === 'eg-close') return; dragging = true;
      const r = this.gui.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return; e.preventDefault();
      this.gui.style.left = e.clientX - ox + 'px'; this.gui.style.top = e.clientY - oy + 'px'; this.gui.style.transform = 'none';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    bar.addEventListener('touchstart', (e) => {
      if (e.target.id === 'eg-close') return; const t = e.touches[0];
      const r = this.gui.getBoundingClientRect(); ox = t.clientX - r.left; oy = t.clientY - r.top; dragging = true;
    }, { passive: true });
    bar.addEventListener('touchmove', (e) => {
      if (!dragging) return; e.preventDefault(); const t = e.touches[0];
      let nx = Math.max(0, Math.min(window.innerWidth - this.gui.offsetWidth, t.clientX - ox));
      let ny = Math.max(0, Math.min(window.innerHeight - this.gui.offsetHeight, t.clientY - oy));
      this.gui.style.left = nx + 'px'; this.gui.style.top = ny + 'px'; this.gui.style.transform = 'none';
    }, { passive: false });
    bar.addEventListener('touchend', () => { dragging = false; });
  };

  const bindTouchGuard = () => {
    this.gui.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });
  };

  /** Update live stats every frame */
  this.updateStats = () => {
    const tick = CycleTracker.lastTick;
    const setEl = (id, val) => {
      const el = this.gui.querySelector('#' + id);
      if (el) el.textContent = val;
    };

    // State indicator
    const stateEl = this.gui.querySelector('#eg-state');
    if (stateEl) {
      stateEl.textContent = BotState.state.toUpperCase();
      stateEl.className = BotState.state;
    }

    if (tick < 0 || !EchoAPI.check()) {
      setEl('stat-tick', '-');
      return;
    }

    setEl('stat-tick', tick);
    setEl('stat-cycle', CycleTracker.cycleNumber);
    setEl('stat-aug', CycleTracker.getAugmentationFactor().toFixed(2) + 'x');

    const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n).toString();
    setEl('stat-troops', fmt(DensityAnalyzer.getMyTroops()));
    setEl('stat-land', fmt(DensityAnalyzer.getMyLand()));
    setEl('stat-density', DensityAnalyzer.getMyDensity().toFixed(1));
    setEl('stat-interest', (DensityAnalyzer.getMyEffectiveInterestRate() * 100).toFixed(2) + '%');
    setEl('stat-borders', BorderManager.getMyBorderCount());
    setEl('stat-enemies', BorderManager.getBorderingEnemies().size);
    setEl('stat-compact', (BorderManager.getCompactness() * 100).toFixed(1) + '%');

    // Session stats
    setEl('stat-attacks', microState.totalAttacks);
    setEl('stat-expands', microState.totalExpansions);
    setEl('stat-boosts', microState.totalBoosts);
    setEl('stat-boats', microState.totalBoats);
    setEl('stat-retreats', microState.totalRetreats);
  };

  this.ensureMounted = () => {
    if (!document.body.contains(this.gui)) {
      document.body.appendChild(this.gui);
      wireToggles(); bindTabs(); bindClose(); bindDrag(); bindTouchGuard(); createMobileToggle();
    }
  };
  this.show = () => { this.ensureMounted(); this.gui.style.display = 'block'; };
  this.hide = () => { this.gui.style.display = 'none'; };
  this.toggle = () => { this.gui.style.display === 'block' ? this.hide() : this.show(); };
  this.setMicroStatus = (active) => {
    const el = this.gui.querySelector('#micro-status');
    const sb = this.gui.querySelector('#micro-start-btn');
    if (!el) return;
    el.textContent = active ? 'ACTIVE' : 'INACTIVE';
    el.className = 'eg-status ' + (active ? 'on' : 'off');
    if (sb) sb.classList.toggle('active', active);
  };
}

var echoSettings = new EchoSettings();
echoSettings.show();


/* ================================================================
 *  KEYBINDS
 * ================================================================ */
document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type === 'text')) return;
  const key = e.key;
  if (key === 'o' || key === 'O') echoSettings.toggle();
  if (key === 'q' || key === 'Q') { e.preventDefault(); startAutoAttack(); }
  if (key === 'e' || key === 'E') { e.preventDefault(); stopAutoAttack(); }
  if (key === 'b' || key === 'B') { e.preventDefault(); features.autoBoat = !features.autoBoat; }
  if (key === 'd' || key === 'D') { e.preventDefault(); features.speedBoost = !features.speedBoost; }
});


/* ================================================================
 *  MAIN CLIENT LOOP â€” state-machine driven with all engines
 * ================================================================ */
function clientLoop() {
  const tick = window.gameLoop?.getTick();
  const gameStarted = window.gameManager?.isGameStarted();

  if (!gameStarted) {
    CycleTracker.lastTick = -1;
    OpeningEngine.executedMoves.clear();
    OpeningEngine.openingComplete = false;
    BotState.setMode('idle');
    BorderManager._cachedEnemies = null;
    BorderManager._cacheTick = -1;
    AttackEngine.activeAttacks.clear();
    AttackEngine.lastAttackTick.clear();
    AttackEngine.totalTroopsSent.clear();
    DefenseEngine.isUnderAttack = false;
    DefenseEngine.balanceHistory = [];
    SpeedBoostEngine.boostHistory = [];
    requestAnimationFrame(clientLoop);
    return;
  }

  if (tick == null) { requestAnimationFrame(clientLoop); return; }

  // Update cycle tracker
  CycleTracker.update(tick);

  // Invalidate border cache periodically (every 3 ticks)
  if (tick % 3 === 0) {
    BorderManager._cacheTick = -1;
  }

  // Evaluate bot state (every 5 ticks to reduce overhead)
  if (tick % 5 === 0) {
    BotState.evaluateState();
  }

  // Process engines on tick change
  if (tick !== CycleTracker.lastTick || tick === 0) {
    // 1. Opening engine (tick-perfect moves)
    OpeningEngine.processTick(tick);

    // 2. Expansion engine (cycle-timed, IFS-aware)
    ExpansionEngine.processTick(tick);

    // 3. Attack during expansion (cycle-timed, offset)
    AttackDuringExpansion.processTick(tick);

    // 4. Speed boost engine (IFS-timed)
    SpeedBoostEngine.processTick(tick);

    // 5. Boat engine
    BoatEngine.processTick(tick);

    // 6. Alliance engine
    AllianceEngine.processTick(tick);

    // 7. Defense engine
    if (features.autoDefense) {
      DefenseEngine.update();
    }
  }

  // Update GUI stats (throttled to ~10fps)
  if (tick % 3 === 0) {
    echoSettings.updateStats();
  }

  requestAnimationFrame(clientLoop);
}

requestAnimationFrame(clientLoop);

console.log('%c[MESSIAH v4] Full bot client loaded', 'color: #f59e0b; font-weight: bold; font-size: 14px');
console.log('[MESSIAH v4] Features: Cycle tracking, Border management, Density analysis,');
console.log('[MESSIAH v4]   Smart attack formula, Speed tier awareness, Auto opening,');
console.log('[MESSIAH v4]   Infinite expansion, Attack during expansion, Mountain/Boat support,');
console.log('[MESSIAH v4]   Speed boost, Multi-target attacks, Defense prioritization,');
console.log('[MESSIAH v4]   Dynamic state machine, Boat automation, Alliance management,');
console.log('[MESSIAH v4]   Smart retreat, Terrain awareness, Troop income prediction');
console.log('[MESSIAH v4] Press O to toggle GUI, Q/E to start/stop micro, B=boat, D=boost');
console.log('[MESSIAH v4] Mobile: tap the E button to toggle GUI');
console.log('[MESSIAH v4] Type EchoAPI.debug() to verify game hooks');