/* ================================================================
 *  ECHO Client v2 â€” Mobile Edition
 *  ----------------------------------------------------------------
 *  Designed to work with the deobfuscated script.js (v2.16.x)
 *  All hooks use the readable variable names: gameManager, playerData,
 *  mapData, protocolHandler, gameLoop, etc.
 *  Mobile: touch drag, floating toggle button, larger tap targets
 * ================================================================ */

/* â”€â”€ API Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
    console.log('%c[ECHO] API Debug', 'color: #a855f7; font-weight: bold');
    console.log('  gameManager:', !!g, g ? { ownId: g.OwnPlayerId, started: g.isGameStarted(), mode: g.gameMode, arraySize: g.arraySize } : null);
    console.log('  playerData:', !!p, p ? { troopsLen: p.playerTroops?.length, landLen: p.landOwned?.length, tilesLen: p.playerTiles?.length } : null);
    console.log('  mapData:', !!m, m ? { offsets: m.neighborOffsets, mapWidth: m.mapWidth } : null);
    console.log('  protocolHandler:', !!window.protocolHandler);
    console.log('  gameLoop:', !!l, l ? { tick: l.getTick() } : null);
    console.log('  ECHO ready:', this.ready);
  }
};

window.EchoAPI = EchoAPI;


/* ================================================================
 *  WINDOW MANAGER
 * ================================================================ */
var WindowManager = {
  currentScreen: null,

  openWindow: function (screenName) {
    if (this.currentScreen && typeof this.currentScreen.hide === 'function') {
      this.currentScreen.hide();
    }
    switch (screenName) {
      case 'echoSettings':
      case 'settings':
        if (typeof echoSettings !== 'undefined') {
          echoSettings.show();
          this.currentScreen = echoSettings;
        } else {
          console.error('[ECHO] echoSettings is not loaded!');
        }
        break;
    }
  },

  closeCurrent: function () {
    if (this.currentScreen && typeof this.currentScreen.hide === 'function') {
      this.currentScreen.hide();
    }
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
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    echoSettings.toggle();
  });
  document.body.appendChild(btn);

  /* Make the toggle button itself draggable via touch */
  let dragging = false, ox = 0, oy = 0;
  let moved = false;

  btn.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const r = btn.getBoundingClientRect();
    ox = t.clientX - r.left;
    oy = t.clientY - r.top;
    dragging = true;
    moved = false;
  }, { passive: true });

  btn.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    moved = true;
    const t = e.touches[0];
    let nx = t.clientX - ox;
    let ny = t.clientY - oy;
    /* Clamp to viewport */
    nx = Math.max(0, Math.min(window.innerWidth - 44, nx));
    ny = Math.max(0, Math.min(window.innerHeight - 44, ny));
    btn.style.left = nx + 'px';
    btn.style.top = ny + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  }, { passive: false });

  btn.addEventListener('touchend', (e) => {
    dragging = false;
    /* If finger didn't move much, treat as tap (toggle handled by click) */
    if (moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}


/* ================================================================
 *  ECHO SETTINGS GUI
 * ================================================================ */
function EchoSettings() {
  if (!document.getElementById('echo-font')) {
    const link = document.createElement('link');
    link.id = 'echo-font';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500&display=swap';
    document.head.appendChild(link);
  }

  const style = document.createElement('style');
  style.id = 'echo-gui-style';
  style.innerHTML = `
    :root {
      --eg-bg:       #0d0b14;
      --eg-surface:  #13101e;
      --eg-border:   #2a1f4a;
      --eg-accent:   #7c3aed;
      --eg-accent2:  #a855f7;
      --eg-text:     #c4b5fd;
      --eg-muted:    #6d5d8a;
      --eg-toggle-off: #2e2040;
    }

    #echo-gui * { box-sizing: border-box; margin: 0; padding: 0; }

    #echo-gui {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 280px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 80px);
      background: var(--eg-bg);
      border: 1px solid var(--eg-border);
      border-radius: 10px;
      color: var(--eg-text);
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      box-shadow: 0 0 0 1px #7c3aed22, 0 8px 32px #0007, inset 0 1px 0 #ffffff08;
      display: none;
      z-index: 999999;
      user-select: none;
      -webkit-user-select: none;
      overflow: hidden;
      touch-action: none;
      -webkit-touch-callout: none;
    }

    #eg-titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--eg-surface);
      border-bottom: 1px solid var(--eg-border);
      cursor: move;
      touch-action: none;
      min-height: 44px;
    }

    #eg-logo {
      font-family: 'Rajdhani', sans-serif;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 2px;
      color: var(--eg-accent2);
      text-shadow: 0 0 12px #a855f766;
      pointer-events: none;
    }

    #eg-close {
      width: 32px;
      height: 32px;
      background: #3b2060;
      border: none;
      border-radius: 6px;
      color: var(--eg-text);
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      transition: background .15s;
      min-width: 44px;
      min-height: 44px;
      -webkit-tap-highlight-color: transparent;
    }
    #eg-close:hover { background: var(--eg-accent); color: #fff; }
    #eg-close:active { background: var(--eg-accent); color: #fff; transform: scale(0.95); }

    #eg-tabs {
      display: flex;
      background: var(--eg-surface);
      border-bottom: 1px solid var(--eg-border);
    }

    .eg-tab {
      flex: 1;
      padding: 10px 0;
      text-align: center;
      font-family: 'Rajdhani', sans-serif;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--eg-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color .15s, border-color .15s;
      -webkit-tap-highlight-color: transparent;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .eg-tab:hover { color: var(--eg-text); }
    .eg-tab:active { color: var(--eg-text); }
    .eg-tab.active {
      color: var(--eg-accent2);
      border-bottom: 2px solid var(--eg-accent);
    }

    #eg-content {
      padding: 10px 14px 14px;
      overflow-y: auto;
      max-height: calc(100vh - 180px);
      -webkit-overflow-scrolling: touch;
    }

    .eg-panel { display: none; }
    .eg-panel.active { display: block; }

    .eg-section {
      font-family: 'Rajdhani', sans-serif;
      font-weight: 700;
      font-size: 10px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--eg-accent);
      margin: 10px 0 6px;
      padding-bottom: 3px;
      border-bottom: 1px solid var(--eg-border);
    }
    .eg-section:first-child { margin-top: 2px; }

    .eg-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      min-height: 44px;
    }

    .eg-label {
      font-size: 13px;
      color: #d8caff;
      font-weight: 400;
    }

    .eg-toggle-wrap {
      position: relative;
      width: 44px;
      height: 26px;
      flex-shrink: 0;
    }
    .eg-toggle-wrap input {
      opacity: 0;
      width: 0; height: 0;
      position: absolute;
    }
    .eg-toggle-track {
      position: absolute;
      inset: 0;
      background: var(--eg-toggle-off);
      border-radius: 26px;
      cursor: pointer;
      transition: background .2s;
      border: 1px solid #3d2d5e;
    }
    .eg-toggle-track::after {
      content: '';
      position: absolute;
      width: 20px;
      height: 20px;
      top: 2px;
      left: 2px;
      background: var(--eg-muted);
      border-radius: 50%;
      transition: transform .2s, background .2s;
    }
    .eg-toggle-wrap input:checked + .eg-toggle-track {
      background: var(--eg-accent);
      border-color: var(--eg-accent);
    }
    .eg-toggle-wrap input:checked + .eg-toggle-track::after {
      transform: translateX(18px);
      background: #fff;
    }

    .eg-slider-wrap {
      display: flex;
      flex-direction: column;
      padding: 6px 0 8px;
      gap: 6px;
    }
    .eg-slider-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .eg-slider-val {
      font-family: 'Rajdhani', sans-serif;
      font-weight: 600;
      font-size: 12px;
      color: var(--eg-accent2);
    }
    .eg-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      border-radius: 4px;
      background: var(--eg-border);
      outline: none;
      cursor: pointer;
    }
    .eg-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--eg-accent2);
      cursor: pointer;
      box-shadow: 0 0 6px #a855f766;
    }
    .eg-slider::-moz-range-thumb {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--eg-accent2);
      cursor: pointer;
      border: none;
    }
    .eg-slider:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .eg-slider:disabled::-webkit-slider-thumb { cursor: not-allowed; }

    .eg-btn-row {
      display: flex;
      gap: 8px;
      padding: 8px 0 4px;
      margin-top: 14px;
    }
    .eg-btn {
      flex: 1;
      padding: 12px 0;
      border: 1px solid var(--eg-border);
      border-radius: 6px;
      background: var(--eg-surface);
      color: var(--eg-text);
      font-family: 'Rajdhani', sans-serif;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 1px;
      text-transform: uppercase;
      cursor: pointer;
      transition: background .15s, border-color .15s, color .15s;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    .eg-btn:hover { background: var(--eg-border); }
    .eg-btn:active { background: var(--eg-border); transform: scale(0.97); }
    .eg-btn.active {
      background: var(--eg-accent);
      border-color: var(--eg-accent);
      color: #fff;
    }

    .eg-status {
      font-family: 'Rajdhani', sans-serif;
      font-size: 11px;
      letter-spacing: 1px;
      text-align: center;
      padding: 4px 0 0;
      color: var(--eg-muted);
    }
    .eg-status.on  { color: #4CAF50; }
    .eg-status.off { color: #f44336; }

    /* Mobile floating toggle button */
    #echo-mobile-toggle {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border: 2px solid #a855f766;
      border-radius: 12px;
      color: #fff;
      font-family: 'Rajdhani', sans-serif;
      font-weight: 700;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999998;
      cursor: pointer;
      box-shadow: 0 2px 12px #7c3aed88, 0 0 20px #a855f733;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
      transition: transform 0.1s;
    }
    #echo-mobile-toggle:active {
      transform: scale(0.92);
    }
  `;
  if (!document.getElementById('echo-gui-style')) {
    document.head.appendChild(style);
  }

  const toggle = (label, id) => `
    <div class="eg-row">
      <span class="eg-label">${label}</span>
      <label class="eg-toggle-wrap">
        <input type="checkbox" id="${id}">
        <span class="eg-toggle-track"></span>
      </label>
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
      <span id="eg-logo">ECHO</span>
      <button id="eg-close">âœ•</button>
    </div>

    <div id="eg-tabs">
      <div class="eg-tab active" data-tab="opening">Opening</div>
      <div class="eg-tab"        data-tab="visuals">Visuals</div>
      <div class="eg-tab"        data-tab="micro">Micro</div>
    </div>

    <div id="eg-content">

      <div class="eg-panel active" id="panel-opening">
        <div class="eg-section">Opening</div>
        ${toggle('Auto Opening', 'opt-opening-open')}
      </div>

      <div class="eg-panel" id="panel-visuals">
        <div class="eg-section">Players</div>
        ${toggle('ESP', 'opt-esp')}
        <div class="eg-section">World</div>
        ${toggle('Fullbright', 'opt-fullbright')}
      </div>

      <div class="eg-panel" id="panel-micro">
        <div class="eg-section">Auto Attack</div>
        ${toggle('Attack Formula', 'opt-attack-formula')}
        ${slider('Attack Percent', 'opt-attack-percent', 1, 30, 12, '%')}
        ${slider('Interval', 'opt-attack-interval', 1, 667, 400, 'ms')}
        <div class="eg-btn-row" style="margin-top: 14px;">
          <button class="eg-btn" id="micro-start-btn">Start (Q)</button>
          <button class="eg-btn" id="micro-stop-btn">Stop (E)</button>
        </div>
        <div class="eg-status off" id="micro-status">INACTIVE</div>
        <div class="eg-section">Legit Attack</div>
        ${toggle('Legit Mode', 'opt-legitmode')}
      </div>

    </div>
  `;

  const bindToggle = (id, fn) => {
    const el = this.gui.querySelector(`#${id}`);
    if (el) el.addEventListener('change', () => fn(el.checked));
  };

  const wireToggles = () => {
    bindToggle('opt-opening-open', onAutoOpenToggle);
    bindToggle('opt-esp', onESPToggle);
    bindToggle('opt-fullbright', onFullbrightToggle);
    bindToggle('opt-legitmode', onLegitModeToggle);

    bindToggle('opt-attack-formula', (enabled) => {
      microState.useFormula = enabled;
      const ps = this.gui.querySelector('#opt-attack-percent');
      if (ps) ps.disabled = enabled;
    });

    const pSlider = this.gui.querySelector('#opt-attack-percent');
    const pVal = this.gui.querySelector('#opt-attack-percent-val');
    if (pSlider)
      pSlider.addEventListener('input', () => {
        microState.attackPercent = parseInt(pSlider.value);
        if (pVal) pVal.textContent = microState.attackPercent + '%';
      });

    const iSlider = this.gui.querySelector('#opt-attack-interval');
    const iVal = this.gui.querySelector('#opt-attack-interval-val');
    if (iSlider)
      iSlider.addEventListener('input', () => {
        microState.intervalMs = parseInt(iSlider.value);
        if (iVal) iVal.textContent = microState.intervalMs + 'ms';
        if (microState.attackInterval !== null) {
          clearInterval(microState.attackInterval);
          microState.attackInterval = setInterval(
            startMicro,
            microState.intervalMs
          );
        }
      });

    const startBtn = this.gui.querySelector('#micro-start-btn');
    const stopBtn = this.gui.querySelector('#micro-stop-btn');
    if (startBtn) startBtn.addEventListener('click', startAutoAttack);
    if (stopBtn) stopBtn.addEventListener('click', stopAutoAttack);
  };

  const bindTabs = () => {
    this.gui.querySelectorAll('.eg-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.gui
          .querySelectorAll('.eg-tab')
          .forEach((t) => t.classList.remove('active'));
        this.gui
          .querySelectorAll('.eg-panel')
          .forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = this.gui.querySelector(`#panel-${tab.dataset.tab}`);
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

    /* Mouse events (PC) */
    bar.addEventListener('mousedown', (e) => {
      if (e.target.id === 'eg-close') return;
      dragging = true;
      const r = this.gui.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      this.gui.style.left = e.clientX - ox + 'px';
      this.gui.style.top = e.clientY - oy + 'px';
      this.gui.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
    });

    /* Touch events (Mobile) */
    bar.addEventListener('touchstart', (e) => {
      if (e.target.id === 'eg-close') return;
      const t = e.touches[0];
      const r = this.gui.getBoundingClientRect();
      ox = t.clientX - r.left;
      oy = t.clientY - r.top;
      dragging = true;
    }, { passive: true });

    bar.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const t = e.touches[0];
      let nx = t.clientX - ox;
      let ny = t.clientY - oy;
      /* Clamp to viewport */
      const gw = this.gui.offsetWidth;
      const gh = this.gui.offsetHeight;
      nx = Math.max(0, Math.min(window.innerWidth - gw, nx));
      ny = Math.max(0, Math.min(window.innerHeight - gh, ny));
      this.gui.style.left = nx + 'px';
      this.gui.style.top = ny + 'px';
      this.gui.style.transform = 'none';
    }, { passive: false });

    bar.addEventListener('touchend', () => {
      dragging = false;
    });
  };

  /* Prevent touch scroll/zoom inside GUI */
  const bindTouchGuard = () => {
    this.gui.addEventListener('touchmove', (e) => {
      e.preventDefault();
    }, { passive: false });
  };

  this.ensureMounted = () => {
    if (!document.body.contains(this.gui)) {
      document.body.appendChild(this.gui);
      wireToggles();
      bindTabs();
      bindClose();
      bindDrag();
      bindTouchGuard();
      createMobileToggle();
    }
  };

  this.show = () => {
    this.ensureMounted();
    this.gui.style.display = 'block';
  };
  this.hide = () => {
    this.gui.style.display = 'none';
  };
  this.toggle = () => {
    this.gui.style.display === 'block' ? this.hide() : this.show();
  };

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
 *  KEYBINDS (PC only â€” mobile uses the floating E button)
 * ================================================================ */
document.addEventListener('keydown', function (e) {
  if (
    e.target.tagName === 'TEXTAREA' ||
    (e.target.tagName === 'INPUT' && e.target.type === 'text')
  )
    return;

  const key = e.key;
  if (key === 'o' || key === 'O') echoSettings.toggle();
  if (key === 'q' || key === 'Q') {
    e.preventDefault();
    startAutoAttack();
  }
  if (key === 'e' || key === 'E') {
    e.preventDefault();
    stopAutoAttack();
  }
});


/* ================================================================
 *  MICRO STATE
 * ================================================================ */
const microState = {
  attackPercent: 12,
  intervalMs: 400,
  useFormula: false,
  attackInterval: null,
  isAttacking: false,
  attackQueue: [],
  lastAttack: new Map(),
  activeTargets: new Set(),
};

const MICRO_MAX_DENSITY = 0.5;
const MICRO_MAX_ATTACKS_PER_CYCLE = 1;
const MICRO_DELAY_BETWEEN_ATTACKS_MS = 1;
const MICRO_MIN_ATTACK_INTERVAL_TARGET = 5000;

const percentToValue = (p) =>
  Math.max(0, Math.min(1023, Math.floor(1024 * (p / 100) + 0.5) - 1));


/* ================================================================
 *  CORE FUNCTIONS  (hooks for deobfuscated script.js)
 * ================================================================ */

function getMyPlayerId() {
  try {
    const id = window.gameManager?.OwnPlayerId;
    return (id != null && id !== -1) ? id : null;
  } catch {
    return null;
  }
}

function getTicks() {
  try {
    return window.gameLoop?.getTick();
  } catch {
    return null;
  }
}

function getGameStarted() {
  try {
    return window.gameManager?.isGameStarted();
  } catch {
    return false;
  }
}

function attackTarget(unitRatio, targetPlayerId) {
  try {
    return window.protocolHandler?.gameCommandSender.attackTargetHandler(
      unitRatio,
      targetPlayerId
    );
  } catch (e) {
    console.error('[ECHO] attackTarget failed:', e);
    return false;
  }
}

function attackTargetSP(ownPlayerId, unitRatio, targetPlayer) {
  try {
    return window.protocolHandler?.localCommandProcessor.attackTargetSp(
      ownPlayerId,
      unitRatio,
      targetPlayer
    );
  } catch (e) {
    console.error('[ECHO] attackTargetSP failed:', e);
    return false;
  }
}

/**
 * Find enemy player IDs that share a border with us.
 */
function findBorderingIds(myCells, allBorders, offsets, totalPlayers, myId) {
  if (!myCells || !allBorders || !offsets) return new Map();

  const cellSet = new Set(myCells);
  const neighbors = new Map();

  for (let i = 0; i < totalPlayers; i++) {
    if (i === myId || !allBorders[i]) continue;
    let shared = 0;
    const enemyTiles = allBorders[i];
    for (let t = 0, len = enemyTiles.length; t < len; t++) {
      const c = enemyTiles[t];
      for (let d = 0; d < offsets.length; d++) {
        if (cellSet.has(c - offsets[d])) {
          shared++;
          break;
        }
      }
    }
    if (shared > 0) neighbors.set(i, shared);
  }
  return neighbors;
}

async function processMicroQueue(myTroops) {
  if (microState.isAttacking || !microState.attackQueue.length) return;
  microState.isAttacking = true;
  let sent = 0;

  while (
    microState.attackQueue.length > 0 &&
    sent < MICRO_MAX_ATTACKS_PER_CYCLE
  ) {
    const enemy = microState.attackQueue.shift();
    if (!enemy) continue;

    const now = Date.now();
    const last = microState.lastAttack.get(enemy.id) || 0;
    if (now - last < MICRO_MIN_ATTACK_INTERVAL_TARGET) continue;

    let percent;
    if (microState.useFormula) {
      const needed = (enemy.troops + enemy.land) * 2.35;
      percent = Math.max(
        1,
        Math.min(100, Math.round((needed / Math.max(1, myTroops)) * 100))
      );
    } else {
      percent = microState.attackPercent;
    }

    attackTarget(percentToValue(percent), enemy.id);
    microState.lastAttack.set(enemy.id, now);
    microState.activeTargets.add(enemy.id);
    sent++;

    if (microState.attackQueue.length && sent < MICRO_MAX_ATTACKS_PER_CYCLE)
      await new Promise((r) => setTimeout(r, MICRO_DELAY_BETWEEN_ATTACKS_MS));
  }

  microState.isAttacking = false;
}

function startMicro() {
  if (!EchoAPI.check()) {
    console.warn('[ECHO] Game API not ready yet');
    return;
  }

  const playerData = window.playerData;
  const mapData = window.mapData;

  const troopData = playerData.playerTroops;
  const landData = playerData.landOwned;
  const borders = playerData.playerTiles;
  const offsets = mapData.neighborOffsets;
  if (!troopData || !landData || !borders || !offsets) return;

  const myId = getMyPlayerId();
  if (myId == null || !borders[myId]) return;

  const myTroops = troopData[myId] || 1;

  // Clean up dead/eliminated targets
  for (const id of [...microState.activeTargets]) {
    if (!landData[id] || landData[id] === 0) {
      microState.activeTargets.delete(id);
      microState.lastAttack.delete(id);
    }
  }

  // Find bordering enemies
  const borderNeighbors = findBorderingIds(
    borders[myId],
    borders,
    offsets,
    window.gameManager.arraySize,
    myId
  );

  // Build candidate list (filter by density)
  const candidates = [];
  for (const [enemyId, shared] of borderNeighbors) {
    const troops = troopData[enemyId];
    const land = landData[enemyId];
    if (troops == null || troops === 0) continue;
    if (land > 0 && troops / land > MICRO_MAX_DENSITY) continue;
    candidates.push({ id: enemyId, troops, land, sharedBorderCount: shared });
  }

  candidates.sort((a, b) => b.sharedBorderCount - a.sharedBorderCount);
  microState.attackQueue = candidates.slice();

  if (microState.attackQueue.length && !microState.isAttacking)
    void processMicroQueue(myTroops);
}

function startAutoAttack() {
  if (microState.attackInterval) return;
  startMicro();
  microState.attackInterval = setInterval(startMicro, microState.intervalMs);
  echoSettings.setMicroStatus(true);
}

function stopAutoAttack() {
  clearInterval(microState.attackInterval);
  microState.attackInterval = null;
  microState.attackQueue = [];
  microState.isAttacking = false;
  echoSettings.setMicroStatus(false);
}


/* ================================================================
 *  FEATURES
 * ================================================================ */
const features = { autoOpen: false };

function onAutoOpenToggle(enabled) {
  features.autoOpen = enabled;
  console.log('[ECHO] Auto Opening:', enabled ? 'ON' : 'OFF');
}
function onESPToggle(enabled) {
  console.log('[ECHO] ESP:', enabled ? 'ON' : 'OFF');
}
function onFullbrightToggle(enabled) {
  console.log('[ECHO] Fullbright:', enabled ? 'ON' : 'OFF');
}
function onLegitModeToggle(enabled) {
  console.log('[ECHO] Legit Mode:', enabled ? 'ON' : 'OFF');
}


/* ================================================================
 *  AUTO OPENING
 * ================================================================ */
function startAutoOpen(ticks) {
  const NEUTRAL_ID = window.gameManager?.arraySize || 512;

  switch (ticks) {
     // Cycle 1: 144L, 799T
    case 60: attackTarget(percentToValue(20.800), 512); break;
    case 81: attackTarget(percentToValue(17.871), 512); break;

    // Cycle 2: 544L , 1045T
    case 151: attackTarget(percentToValue(16.7), 512); break;
    case 165: attackTarget(percentToValue(18.55), 512); break;
    case 172: attackTarget(percentToValue(39.84), 512); break;
    case 186: attackTarget(percentToValue(24.12), 512); break;

    // Cycle 3: 1104L , 1656T
    case 256: attackTarget(percentToValue(0.1), 512); break;
    case 263: attackTarget(percentToValue(22.3633), 512); break;
    case 270: attackTarget(percentToValue(52.54), 512); break;
    case 284: attackTarget(percentToValue(29.98), 512); break;

    // Cycle 4:2244L , 2484T
    case 354: attackTarget(percentToValue(0.01), 512); break;
    case 361: attackTarget(percentToValue(47.07), 512); break;
    case 375: attackTarget(percentToValue(35.84), 512); break;
    case 382: attackTarget(percentToValue(87.4), 512); break;

    // Cycle 5:3784L , 4378T
    case 452: attackTarget(percentToValue(28.61), 512); break;
    case 466: attackTarget(percentToValue(23.73), 512); break;
    case 473: attackTarget(percentToValue(31.64), 512); break;
    case 480: attackTarget(percentToValue(71), 512); break;
  }
}


/* ================================================================
 *  MAIN CLIENT LOOP
 * ================================================================ */
let lastTick = -1;

function clientLoop() {
  const ticks = getTicks();
  const gameStarted = getGameStarted();

  if (!gameStarted) {
    lastTick = -1;
    requestAnimationFrame(clientLoop);
    return;
  }

  if (ticks == null) {
    requestAnimationFrame(clientLoop);
    return;
  }

  if (features.autoOpen && ticks !== lastTick) {
    lastTick = ticks;
    startAutoOpen(ticks);
  }

  requestAnimationFrame(clientLoop);
}

requestAnimationFrame(clientLoop);

console.log('%c[ECHO] Client v2 Mobile loaded', 'color: #a855f7; font-weight: bold');
console.log('[ECHO] Press O to toggle GUI, Q/E to start/stop micro');
console.log('[ECHO] Mobile: tap the E button to toggle GUI');
console.log('[ECHO] Type EchoAPI.debug() to verify game hooks');