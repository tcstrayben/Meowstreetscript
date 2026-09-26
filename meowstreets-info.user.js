// ==UserScript==
// @name         MeowStreets Extra Info
// @namespace    https://meowstreets.com
// @version      0.11.1
// @description  Crimes page: exact XP and cash per nerve, item drops and the best crimes highlighted on every card. Claw Street Ex: logs stock prices and shows if a price looks low or high. Sidebar timers for stocks and your crew chain. A page scanner and data export for working out how the game's numbers are made.
// @author       Strayben
// @homepageURL  https://github.com/tcstrayben/Meowstreetscript
// @supportURL   https://github.com/tcstrayben/Meowstreetscript/issues
// @updateURL    https://raw.githubusercontent.com/tcstrayben/Meowstreetscript/main/meowstreets-info.user.js
// @downloadURL  https://raw.githubusercontent.com/tcstrayben/Meowstreetscript/main/meowstreets-info.user.js
// @match        https://meowstreets.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_info
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // Only ever run on https://meowstreets.com/... pages (crimes, merits, and so on). The @match line already
  // limits this; the check is a second guard, and the scanner repeats it before reading anything.
  const SITE_ORIGIN = 'https://meowstreets.com';
  if (location.origin !== SITE_ORIGIN) return;

  // READ-ONLY by design (MeowStreets ToS: "no bots, scripts or automation that play for you").
  // This script only reads what is already on the page and draws numbers next to it.
  // It sends nothing to MeowStreets, clicks nothing and presses nothing. The only other thing it can do is talk to
  // GitHub, and only when you press one of the two stock buttons on the Claw Street Ex page (see "Shared stock history").

  // ─── Config ───────────────────────────────────────────────────────────────
  const REFRESH_DEBOUNCE_MS = 250; // wait for the React page to settle before redrawing
  const MAX_OBSERVATIONS_PER_CRIME = 300; // cap on stored history so the stored data stays small
  const DB_KEY = 'ms_db_v1';

  // Exact per-crime figures from the game's crime pages (see crimes.csv). Keys are normalised crime names.
  // xp = XP for a successful attempt, nerve = nerve cost, base = base success % (before level/mastery/heat).
  const DROPS = {
    alleys: { common: 'Lucky fish bone', rare: 'The Alleys glass eye' },
    dockside: { common: 'Dockside pearl', rare: 'Black tide pearl' },
    quarter: { common: 'Antique collar', rare: 'Old Quarter signet' },
  };
  const CRIMES = {
    // The Alleys
    dumpsterdiving: { xp: 6, nerve: 3, base: 92, drops: DROPS.alleys },
    pickpocketatourist: { xp: 9, nerve: 4, base: 82, drops: DROPS.alleys },
    fenceastolenbicycle: { xp: 14, nerve: 6, base: 72, drops: DROPS.alleys },
    runacatnipstall: { xp: 20, nerve: 8, base: 66, drops: DROPS.alleys },
    // Dockside
    fishmarketheist: { xp: 12, nerve: 6, base: 78, drops: DROPS.dockside },
    smuggletinnedtuna: { xp: 18, nerve: 8, base: 70, drops: DROPS.dockside },
    cratejacking: { xp: 26, nerve: 10, base: 64, drops: DROPS.dockside },
    harbourmasterssafe: { xp: 36, nerve: 12, base: 58, drops: DROPS.dockside },
    // Old Quarter
    rooftopburglary: { xp: 22, nerve: 10, base: 62, drops: DROPS.quarter },
    gallerynight: { xp: 32, nerve: 12, base: 58, drops: DROPS.quarter },
    jewellerswindow: { xp: 44, nerve: 14, base: 54, drops: DROPS.quarter },
    thecathedralclockjob: { xp: 60, nerve: 16, base: 50, drops: DROPS.quarter },
  };
  // Exact XP per nerve, using the nerve cost shown on the card (falls back to the table).
  const xpnOf = (c) => {
    const t = CRIMES[c.key];
    return t ? t.xp / (c.nerve || t.nerve) : null;
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const num = (s) => parseFloat(String(s).replace(/,/g, ''));
  const fmtMoney = (n) => '$' + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1));
  const isCrimesPage = () => location.pathname.replace(/\/+$/, '') === '/crimes';

  // ─── Reading the page ─────────────────────────────────────────────────────
  function readPlayerLevel() {
    const el = document.querySelector('.sidebar .profile small');
    const m = el && el.textContent.match(/Level\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function readChain() {
    const el = document.querySelector('.chain');
    if (!el) return { count: null, bonusPct: 0 };
    const t = el.textContent;
    const c = t.match(/Chain\s*[×x]\s*(\d+)/i);
    const b = t.match(/\+(\d+)%/);
    return { count: c ? parseInt(c[1], 10) : null, bonusPct: b ? parseInt(b[1], 10) : 0 };
  }

  function readCard(card, districtName, playerLevel) {
    const name = card.querySelector('.rung-name strong')?.textContent.trim();
    if (!name) return null;

    const lvlEl = card.querySelector('.rung-level b');
    const level = lvlEl ? parseInt(lvlEl.textContent, 10) : null;

    const cashText = card.querySelector('.rung-stats .cash')?.textContent || '';
    const cashM = cashText.match(/\$([\d,]+)\s*[–-]\s*\$([\d,]+)/);
    const cashMin = cashM ? num(cashM[1]) : null;
    const cashMax = cashM ? num(cashM[2]) : null;

    // Read the nerve cost from its own span: the stats' combined text runs "$77" into "3 nerve".
    let nerve = null;
    card.querySelectorAll('.rung-stats > span').forEach((sp) => {
      const m = sp.textContent.trim().match(/^(\d+)\s*nerve$/i);
      if (m) nerve = parseInt(m[1], 10);
    });

    const oddsText = card.querySelector('.odds strong')?.textContent || '';
    const successM = oddsText.match(/([\d.]+)\s*%/);
    const success = successM ? parseFloat(successM[1]) / 100 : null;

    const mastText = card.querySelector('.rung-mastery')?.textContent || '';
    const mastM = mastText.match(/Mastery\s+(\d+)\s*\/\s*(\d+)/i);
    const masteryLevel = mastM ? parseInt(mastM[1], 10) : null;
    const masteryMax = mastM ? parseInt(mastM[2], 10) : null;

    const bar = card.querySelector('.rung-mastery [role="progressbar"]');
    const vt = bar?.getAttribute('aria-valuetext') || '';
    const vtM = vt.match(/Level\s+(\d+)\s+of\s+(\d+),\s*([\d,]+)\s+of\s+([\d,]+)\s+successes/i);
    const progressCur = vtM ? num(vtM[3]) : null;
    const progressNeed = vtM ? num(vtM[4]) : null;

    const lockedByState = card.getAttribute('data-state') === 'locked';
    const lockedByLevel = playerLevel != null && level != null && level > playerLevel;
    const unlocked = !lockedByState && !lockedByLevel;

    return {
      key: norm(name), name, district: districtName, level, nerve, cashMin, cashMax, success,
      masteryLevel, masteryMax, progressCur, progressNeed, unlocked, card,
    };
  }

  function readAll() {
    const playerLevel = readPlayerLevel();
    const chain = readChain();
    const crimes = [];
    const heat = {};
    const heatHeads = {};
    document.querySelectorAll('.ladders .ladder').forEach((ladder) => {
      const head = ladder.querySelector('.ladder-head');
      const headText = head ? head.textContent : '';
      const districtName = (head?.querySelector('h1,h2,h3,strong')?.textContent || headText.replace(/\d+\s*\/\s*\d+\s*heat/i, '')).trim();
      const heatM = headText.match(/(\d+)\s*\/\s*(\d+)\s*heat/i);
      if (heatM) { heat[districtName] = parseInt(heatM[1], 10); heatHeads[districtName] = head; }
      ladder.querySelectorAll('article.rung').forEach((card) => {
        const c = readCard(card, districtName, playerLevel);
        if (c) crimes.push(c);
      });
    });
    return { playerLevel, chain, crimes, heat, heatHeads };
  }

  // ─── Maths ────────────────────────────────────────────────────────────────
  // Expected XP/nerve = (XP / nerve) x success x (1 + 0.5 x clean chance); clean chance = 5% + 1% per mastery level.
  // Above 80 heat a district pays half the XP and turns no clean job at all.
  const HOT_HEAT = 80;
  function score(c, chain, heat) {
    const hot = heat != null && heat > HOT_HEAT;
    const cleanChance = hot ? 0 : 0.05 + 0.01 * (c.masteryLevel || 0);
    const cleanMult = 1 + 0.5 * cleanChance;
    const xpn = xpnOf(c);
    const out = { xpn, hot, xpPerNerve: null, cashLow: null, cashHigh: null, cashEV: null };
    if (c.success == null) return out;
    if (xpn != null) out.xpPerNerve = xpn * c.success * cleanMult * (hot ? 0.5 : 1);
    if (c.nerve && c.cashMin != null) {
      out.cashLow = c.cashMin / c.nerve;
      out.cashHigh = c.cashMax / c.nerve;
      const avg = (c.cashMin + c.cashMax) / 2;
      out.cashEV = (avg * c.success * cleanMult * (1 + chain.bonusPct / 100)) / c.nerve;
    }
    return out;
  }

  // ─── Database (stored via GM_setValue, exported to a file on demand) ─────
  // The db is parsed once and kept in memory: the page ticks every second, so re-parsing a growing
  // price history that often would be wasteful. It is re-read when the tab becomes visible again,
  // so two open tabs don't overwrite each other's data.
  let dbCache = null;
  function loadDb() {
    if (dbCache) return dbCache;
    let db = null;
    try {
      const raw = GM_getValue(DB_KEY, null);
      if (raw) db = JSON.parse(raw);
    } catch (e) { /* fall through to a fresh db */ }
    if (!db) db = { version: 1, crimes: {}, masteryThresholds: {}, heatLog: [], playerLevels: [] };
    if (!db.stocks) db.stocks = {};
    dbCache = db;
    return db;
  }
  function saveDb(db) {
    try { GM_setValue(DB_KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }
  // Other MeowStreets tabs share this storage. Each tab keeps its own copy in memory, so a tab that saves would wipe out
  // what another tab just recorded. Two things prevent that: saves from other tabs are pulled in as they happen (see the
  // listeners near the end), and a tab that is being hidden saves what it has.
  document.addEventListener('visibilitychange', () => { if (document.hidden && dbCache) saveDb(dbCache); });

  function logObservations(data) {
    const db = loadDb();
    const now = new Date().toISOString();
    let changed = false;

    if (data.playerLevel != null && !db.playerLevels.some((p) => p.level === data.playerLevel)) {
      db.playerLevels.push({ level: data.playerLevel, firstSeen: now });
      changed = true;
    }

    data.crimes.forEach((c) => {
      const rec = db.crimes[c.key] || (db.crimes[c.key] = { name: c.name, district: c.district, unlockLevel: c.level, observations: [] });
      rec.name = c.name; rec.district = c.district; if (c.level != null) rec.unlockLevel = c.level;
      if (c.nerve != null) rec.nerve = c.nerve;
      if (c.cashMin != null) { rec.cashMin = c.cashMin; rec.cashMax = c.cashMax; }
      const tbl = CRIMES[c.key];
      if (tbl) { rec.xp = tbl.xp; rec.baseSuccess = tbl.base; rec.drops = tbl.drops; }

      if (!c.unlocked || c.success == null) return;

      if (c.masteryLevel != null && c.progressNeed != null) {
        const t = db.masteryThresholds[c.key] || (db.masteryThresholds[c.key] = {});
        if (t[c.masteryLevel] !== c.progressNeed) { t[c.masteryLevel] = c.progressNeed; changed = true; }
      }

      const last = rec.observations[rec.observations.length - 1];
      const ss = db.mods?.merits?.['Street sense'] ?? null;
      const edu = db.mods?.eduCrimePoints ?? null;
      const crew = crewPoints(db.mods);
      const perk = db.mods?.crewPerkCrime ?? null;
      const crewInf = db.mods?.crewInferred?.active ?? null;
      const sameAsLast = last && last.success === c.success && last.masteryLevel === c.masteryLevel &&
        last.progressCur === c.progressCur && last.playerLevel === data.playerLevel &&
        last.heat === (data.heat[c.district] ?? null) && (last.ss ?? null) === ss && (last.edu ?? null) === edu &&
        (last.crew ?? null) === crew && (last.perk ?? null) === perk && (last.crewInf ?? null) === crewInf; // ?? null: readings saved by older versions lack these fields
      if (!sameAsLast) {
        rec.observations.push({
          t: now, playerLevel: data.playerLevel, success: c.success,
          masteryLevel: c.masteryLevel, progressCur: c.progressCur, progressNeed: c.progressNeed,
          heat: data.heat[c.district] ?? null, chainBonusPct: data.chain.bonusPct, chain: data.chain.count,
          ss, edu, crew, perk, crewInf, // Street sense ranks, education points, crew chain bonus points and crew perk, as last seen on those pages
          // What the card shows minus base, mastery and heat. It was a steady +12 at level 4; this is how we find where it comes from.
          // Readings at the 95% cap say nothing about the bonus, so they are left blank.
          bonus: tbl && data.heat[c.district] != null && Math.round(c.success * 100) < 95
            ? Math.round(c.success * 100) - tbl.base - (c.masteryLevel || 0) + Math.floor(data.heat[c.district] / 4)
            : null,
        });
        if (rec.observations.length > MAX_OBSERVATIONS_PER_CRIME) rec.observations.shift();
        changed = true;
      }
    });

    if (changed) { db.updated = now; saveDb(db); }
  }

  function exportDb() {
    const db = loadDb();
    const json = JSON.stringify({ ...db, events: loadEvents().events }, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const name = 'meowstreets-data-' + new Date().toISOString().slice(0, 10) + '.json';
    try {
      GM_download({ url, name, saveAs: true, onload: () => URL.revokeObjectURL(url) });
    } catch (e) {
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
    }
  }

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const STYLE_ID = 'msx-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .msx-info { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; margin-top:6px;
        padding:6px 8px; border-radius:8px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); font-size:12px; line-height:1.3; }
      .msx-info .msx-xp { color:var(--ms-lime-light, #d3f0b4); font-weight:600; }
      .msx-info .msx-cash { color:var(--ms-gold, #e9c46a); font-weight:600; }
      .msx-info small { color:var(--ms-smoke, #8d9289); font-size:11px; }
      .msx-odds { flex-basis:100%; color:var(--ms-smoke, #8d9289); font-size:11px; }
      .msx-odds .msx-unk { color:var(--ms-gold, #e9c46a); }
      .msx-drops { flex-basis:100%; color:var(--ms-smoke, #8d9289); font-size:11px; }
      .msx-drops b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      .msx-tag { padding:1px 7px; border-radius:999px; font-size:11px; font-weight:700; }
      .msx-tag.xp { background:var(--ms-lime, #b4df87); color:var(--ms-ink, #182316); }
      .msx-tag.cash { background:var(--ms-gold, #e9c46a); color:var(--ms-ink, #182316); }
      article.rung[data-msx-best~="xp"] { box-shadow: inset 0 0 0 2px var(--ms-lime, #b4df87); }
      article.rung[data-msx-best~="cash"] { box-shadow: inset 0 0 0 2px var(--ms-gold, #e9c46a); }
      article.rung[data-msx-best~="xp"][data-msx-best~="cash"] {
        box-shadow: inset 0 0 0 2px var(--ms-lime, #b4df87), inset 0 0 0 4px var(--ms-gold, #e9c46a); }
      .msx-stock { display:flex; flex-wrap:wrap; gap:4px 8px; align-items:center; margin-top:4px; font-weight:400; }
      .msx-stock small { color:var(--ms-smoke, #8d9289); font-size:11px; }
      .msx-stock .msx-range b { color:var(--ms-bone, #e7ede1); }
      .msx-stock .msx-trend { font-size:13px; }
      .msx-tag.stk.low { background:var(--ms-lime, #b4df87); color:var(--ms-ink, #182316); }
      .msx-tag.stk.high { background:var(--ms-red, #eb6561); color:var(--ms-ink, #182316); }
      .msx-tag.stk.mid, .msx-tag.stk.flat { background:var(--ms-slate, #2e342d); color:var(--ms-bone, #e7ede1); }
      .msx-tag.stk.learn { background:transparent; color:var(--ms-smoke, #8d9289); border:1px dashed var(--ms-smoke, #8d9289); }
      .msx-tag.hot { background:var(--ms-red, #eb6561); color:var(--ms-ink, #182316); }
      .msx-heat { margin-left:8px; font-size:11px; color:var(--ms-smoke, #8d9289); white-space:nowrap; }
      .msx-legend { margin:0 0 8px; padding:5px 10px; border-radius:8px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); font-size:12px; color:var(--ms-bone, #e7ede1); }
      .msx-legend summary { cursor:pointer; display:flex; align-items:center; gap:6px; list-style:none; }
      .msx-legend summary::-webkit-details-marker { display:none; }
      .msx-legend .msx-dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--ms-lime, #b4df87); }
      .msx-legend.warn { border-color:var(--ms-gold, #e9c46a); }
      .msx-legend.bad { border-color:var(--ms-red, #eb6561); }
      .msx-legend.warn > summary .msx-dot, .msx-legend-row.warn .msx-dot { background:var(--ms-gold, #e9c46a); }
      .msx-legend.bad > summary .msx-dot, .msx-legend-row.bad .msx-dot { background:var(--ms-red, #eb6561); }
      .msx-legend-list { margin-top:6px; display:grid; gap:4px; }
      .msx-legend-row { display:grid; grid-template-columns:8px 1fr; gap:0 6px; align-items:baseline; font-size:11px; }
      .msx-legend-row .msx-dot { width:6px; height:6px; border-radius:50%; background:var(--ms-lime, #b4df87); }
      .msx-legend-row a { color:var(--ms-bone, #e7ede1); font-weight:600; text-decoration:underline; }
      .msx-legend-row span { grid-column:2; color:var(--ms-smoke, #8d9289); }
      .msx-legend-row.warn span { color:var(--ms-gold, #e9c46a); }
      .msx-legend-row.bad span { color:var(--ms-red, #eb6561); }
      .msx-legend-key { margin:6px 0 0; font-size:10.5px; color:var(--ms-smoke, #8d9289); line-height:1.35; }
      .msx-legend-key .ok { color:var(--ms-lime, #b4df87); } .msx-legend-key .warn { color:var(--ms-gold, #e9c46a); } .msx-legend-key .bad { color:var(--ms-red, #eb6561); }
      .msx-ticker { display:flex; align-items:center; gap:6px; margin:0 0 8px; padding:5px 10px; border-radius:8px;
        background:rgba(0,0,0,.28); border:1px solid var(--ms-line, rgba(231,237,225,.15));
        color:var(--ms-bone, #e7ede1); font-size:12px; font-variant-numeric:tabular-nums; }
      .msx-ticker .ms-icon { color:var(--ms-lime, #b4df87); flex:none; }
      .msx-ticker.soon { border-color:var(--ms-gold, #e9c46a); }
      .msx-ticker.soon .ms-icon { color:var(--ms-gold, #e9c46a); }
      .msx-ticker.stale { border-color:var(--ms-red, #eb6561); color:var(--ms-red, #eb6561); }
      .msx-ticker.stale .ms-icon { color:var(--ms-red, #eb6561); }
      #msx-tools { position:fixed; right:12px; bottom:calc(12px + env(safe-area-inset-bottom, 0px)); z-index:9999; display:flex; gap:6px; }
      #msx-tools button { padding:6px 10px; border-radius:8px; border:1px solid var(--ms-line-strong, rgba(231,237,225,.3));
        background:var(--ms-asphalt, #1c201c); color:var(--ms-bone, #e7ede1); font-size:12px; cursor:pointer; opacity:.75; }
      #msx-tools button:hover { opacity:1; }
      #msx-toast { position:fixed; right:12px; bottom:calc(56px + env(safe-area-inset-bottom, 0px)); z-index:9999; max-width:min(360px, calc(100vw - 24px));
        padding:10px 12px; border-radius:10px; background:var(--ms-asphalt, #1c201c); color:var(--ms-bone, #e7ede1);
        border:1px solid var(--ms-lime, #b4df87); font-size:12px; line-height:1.4; opacity:0; pointer-events:none; transition:opacity .2s; }
      #msx-toast.show { opacity:1; }
    `;
    document.head.appendChild(s);
  }

  function ensureExportButton() {
    if (document.getElementById('msx-tools')) return;
    const box = document.createElement('div');
    box.id = 'msx-tools';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      b.addEventListener('click', fn);
      box.appendChild(b);
    };
    mk('Scan page', 'Read-only: record what this page stores or shows (storage names, endpoints, progress bars, timers, page text)', () => { scanPage(true).catch((e) => toast('Scan failed: ' + e)); });
    mk('Export data', 'Save the logged MeowStreets data to a .json file', exportDb);
    document.body.appendChild(box);
  }

  function clearDrawn() {
    document.querySelectorAll('.msx-info, .msx-heat').forEach((n) => n.remove());
    document.querySelectorAll('article.rung[data-msx-best]').forEach((n) => n.removeAttribute('data-msx-best'));
  }

  // Crew chain bonus in points right now: null if the Crew page was never read, 0 once its window has ended.
  function crewPoints(mods) {
    const cb = mods && mods.crewBonus;
    if (!cb) return null;
    return cb.until > Date.now() ? cb.pct : 0;
  }

  // Where each point of a crime's success % comes from:
  // base + mastery + Street sense + education + crew chain bonus + crew perk + (unknown other) - floor(heat / 4), max 95.
  // The crew bonus is worked out from the card itself when everything else is known: if the shown % is exactly 5
  // above the rest, the crew +5% window is on; if it is exactly equal, it is off. That works from the Crimes page alone.
  let crewVotes = []; // per draw: what each card said about the crew bonus (true / false)
  function oddsBreakdown(c, heat, mods) {
    const t = CRIMES[c.key];
    if (!t || c.success == null || heat == null) return null;
    const shown = Math.round(c.success * 100);
    const items = [
      { label: 'base', v: t.base },
      { label: 'mastery', v: c.masteryLevel || 0 },
      { label: 'merits', v: mods.merits?.['Street sense'] ?? null, from: 'Merits' },
      { label: 'education', v: mods.eduCrimePoints ?? null, from: 'Education' },
      { label: 'crew chain', v: crewPoints(mods), from: 'Crew', crew: true },
      { label: 'crew perk', v: mods.crewPerkCrime ?? null, from: 'Crew > Perks' },
    ];
    const heatPts = Math.floor(heat / 4);
    const sumOf = (skipCrew) => items.reduce((a, i) => a + (skipCrew && i.crew ? 0 : (i.v || 0)), 0) - heatPts;
    const crewItem = items.find((i) => i.crew);
    const storedCrew = crewItem.v;
    let crewInferred = null;
    if (!items.some((i) => i.v == null && !i.crew) && shown < 95) {
      const pct = mods.crewPctSeen || 5;
      const x = shown - sumOf(true);
      if (x === pct) crewInferred = true; else if (x === 0) crewInferred = false;
      if (crewInferred !== null) {
        const val = crewInferred ? pct : 0;
        crewItem.inferred = storedCrew !== val;
        crewItem.storedValue = storedCrew;
        crewItem.v = val;
      }
    }
    const sum = sumOf(false);
    const unknown = items.filter((i) => i.v == null);
    const capped = shown >= 95 && sum >= 95;
    const other = capped ? 0 : shown - sum; // whatever the known sources don't explain
    return { shown, items, heatPts, sum, unknown, capped, other, crewInferred };
  }

  function oddsHtml(c, heat, mods) {
    const b = oddsBreakdown(c, heat, mods);
    if (!b) return '';
    const fmt = (v) => (v < 0 ? '−' : '+') + Math.abs(v);
    if (b.crewInferred !== null) crewVotes.push(b.crewInferred);
    const bits = b.items.filter((i) => i.v !== 0 || i.label === 'base').map((i) =>
      i.v == null ? `<span class="msx-unk">? ${i.label}</span>` : i.label === 'base' ? `${i.v} base` : `${fmt(i.v)} ${i.label}${i.inferred ? '*' : ''}`);
    if (b.heatPts) bits.push(`${fmt(-b.heatPts)} heat`);
    if (b.other) bits.push(`<span class="msx-unk">${fmt(b.other)} other</span>`);
    const end = b.capped ? `= ${b.sum} → capped at 95%` : `= ${b.shown}%`;
    const cb = mods.crewBonus;
    const crewNote = cb && cb.until > Date.now()
      ? ` The crew +${cb.pct}% window ends in ${Math.max(1, Math.round((cb.until - Date.now()) / 60000))} min (${new Date(cb.until).toUTCString().slice(17, 22)} UTC).` : '';
    const ci = b.items.find((i) => i.crew);
    const inferredNote = ci.inferred ? ` * Worked out from this card: the shown % is ${ci.v ? 'exactly ' + ci.v + ' above' : 'exactly equal to'} everything else, so the crew bonus is ${ci.v ? 'on' : 'off'}` +
      ` (the Crew page data said ${ci.storedValue == null ? 'nothing yet' : ci.storedValue}). Open Crew or the Mews to refresh its end time.` : '';
    const missing = b.unknown.length ? ` Not read yet: open ${[...new Set(b.unknown.map((i) => i.from))].join(', ')} once to fill in.` : '';
    const other = b.other && !b.unknown.length ? ' "other" is something this script does not know about yet, such as a job perk or a stock perk.' : '';
    const title = 'Where the success % comes from: base success + mastery level + Street sense merit ranks + education points + crew chain bonus + crew Inside-line perk - 1 per 4 heat, never above 95%.' + crewNote + inferredNote + missing + other;
    return `<div class="msx-odds" title="${title.replace(/"/g, '&quot;')}">Odds: ${bits.join(' ')} ${end}</div>`;
  }

  function dropsHtml(c) {
    const d = CRIMES[c.key]?.drops;
    if (!d) return '';
    return `<div class="msx-drops" title="Clean jobs drop the common item. About 1 in 100 clean jobs also drops the district rare, which only comes from this source.">` +
      `Clean-job drops: <b>${d.common}</b> · rare (~1%): <b>${d.rare}</b></div>`;
  }

  function draw(data) {
    clearDrawn();
    crewVotes = [];
    const scored = data.crimes.map((c) => ({ c, s: score(c, data.chain, data.heat[c.district]) }));

    // Best among crimes the player can actually use at their level.
    let bestXp = null, bestCash = null;
    scored.forEach((x) => {
      if (!x.c.unlocked) return;
      if (x.s.xpPerNerve != null && (!bestXp || x.s.xpPerNerve > bestXp.s.xpPerNerve)) bestXp = x;
      if (x.s.cashEV != null && (!bestCash || x.s.cashEV > bestCash.s.cashEV)) bestCash = x;
    });

    // Time until each district's heat is back to 0 (it cools 1 point every 5 minutes).
    Object.entries(data.heatHeads).forEach(([district, head]) => {
      const h = data.heat[district];
      const mins = h * 5;
      const txt = h <= 0 ? 'Cool' : `Heat 0 in ~${mins >= 60 ? Math.floor(mins / 60) + 'h ' : ''}${mins % 60}m`;
      const el = document.createElement('span');
      el.className = 'msx-heat';
      el.textContent = txt;
      el.title = 'Heat cools 1 point every 5 minutes (the rules say "while you are away", so it may not cool while you sit on the page).';
      head.appendChild(el);
    });

    scored.forEach((x) => {
      const { c, s } = x;
      const host = c.card.querySelector('.rung-main') || c.card;
      const box = document.createElement('div');
      box.className = 'msx-info';

      if (!c.unlocked) {
        box.innerHTML = `<small>Unlocks at level ${c.level ?? '?'}</small>` +
          (s.xpn != null ? `<small>XP/n ${s.xpn.toFixed(2)} base</small>` : '') + dropsHtml(c);
        host.appendChild(box);
        return;
      }

      const parts = [];
      if (s.xpPerNerve != null) {
        parts.push(`<span class="msx-xp" title="XP ${CRIMES[c.key].xp} / ${c.nerve || CRIMES[c.key].nerve} nerve = ${s.xpn.toFixed(2)} XP per nerve, x your success x clean-bonus">XP/n ${s.xpPerNerve.toFixed(2)}</span>`);
      }
      if (s.cashLow != null) {
        parts.push(`<span class="msx-cash" title="Cash per nerve, min-max">$/n ${fmtMoney(s.cashLow)}–${fmtMoney(s.cashHigh)}</span>`);
      }
      // Heat forecast. Every attempt adds 6 heat to the district and every 4 heat costs 1 point of success.
      // The card's success % already includes today's heat, so add that back to get the zero-heat base.
      const h0 = data.heat[c.district];
      if (h0 != null && c.success != null) {
        if (s.hot) {
          parts.push('<span class="msx-tag hot" title="Above 80 heat this district pays half the XP and turns no clean job. The XP/n above already reflects that.">Heat over 80: ½ XP, no clean</span>');
        } else {
          const n = Math.floor((HOT_HEAT - h0) / 6) + 1; // attempts until heat is above 80
          if (n <= 8) parts.push(`<small title="Attempts until this district's heat goes over 80 (half XP, no clean jobs)">Over 80 heat in ${n} attempt${n === 1 ? '' : 's'}</small>`);
        }
      }
      if (x === bestXp) parts.push('<span class="msx-tag xp">★ Best XP</span>');
      if (x === bestCash) parts.push('<span class="msx-tag cash">★ Best $</span>');
      box.innerHTML = (parts.join('') || '<small>No data yet</small>') + oddsHtml(c, data.heat[c.district], loadDb().mods || {}) + dropsHtml(c);
      host.appendChild(box);

      const best = [];
      if (x === bestXp) best.push('xp');
      if (x === bestCash) best.push('cash');
      if (best.length) c.card.setAttribute('data-msx-best', best.join(' '));
    });

    // Remember what the cards said about the crew bonus (the checklist and the log use it).
    if (crewVotes.length) {
      const db = loadDb();
      if (!db.mods) db.mods = { merits: {} };
      const active = crewVotes.filter(Boolean).length * 2 >= crewVotes.length;
      const ci = db.mods.crewInferred;
      if (!ci || ci.active !== active || Date.now() - ci.at > 300000) {
        const changed = !ci || ci.active !== active;
        db.mods.crewInferred = { active, at: Date.now() };
        if (changed) saveDb(db);
      } else {
        ci.at = Date.now();
      }
    }
  }

  // ─── Claw Street Ex (stocks): log every price move, show low/high vs history ─
  const isStockPage = () => location.pathname.startsWith('/claw-street-ex');
  const MAX_STOCK_TICKS = 3000; // ~31 days of 15-minute moves per company
  const MIN_TICKS_FOR_VERDICT = 24; // ~6 hours of history before it says anything
  const LOW_PCT = 0.2; // bottom 20% of the recorded range counts as "low"
  const HIGH_PCT = 0.8; // top 20% counts as "high"
  const FLAT_RANGE = 0.02; // if the whole recorded range is under 2%, call it flat

  const PERIOD_MS = 15 * 60 * 1000;
  // Period id of a logged reading. Older readings stored a minute-based `slot`; ones that landed exactly on a
  // 15-minute mark came from a fallback clock while the page loaded and are ignored.
  const periodOf = (o) => (o.p != null ? o.p : (o.slot != null && o.slot % 15 !== 0 ? Math.round(o.slot / 15) : null));

  function readStocks() {
    const nextMoveIso = document.querySelector('time[data-countdown]')?.getAttribute('datetime');
    const nextMove = nextMoveIso ? Date.parse(nextMoveIso) : NaN;
    // The price is fixed until the next move, so the next-move time identifies this price period. Moves happen at a
    // steady point in every 15 minutes, so rounding to the nearest 15-minute unit gives the same id all period long.
    // No countdown on the page yet (still loading) means the table may be stale: it can be drawn but is never logged.
    const period = Number.isFinite(nextMove) ? Math.round(nextMove / PERIOD_MS) : null;

    const stocks = [];
    document.querySelectorAll('.watch-table tbody tr').forEach((row) => {
      const link = row.querySelector('th a');
      const priceCell = row.querySelector('td.end');
      if (!link || !priceCell) return;
      const price = num((priceCell.childNodes[0]?.textContent || '').replace('$', ''));
      const dEl = priceCell.querySelector('.delta');
      const dNum = dEl ? parseFloat(dEl.textContent.replace(/[^\d.]/g, '')) : 0;
      const delta = !dEl || dEl.classList.contains('flat') || !dNum ? 0 : dEl.classList.contains('down') ? -dNum : dNum;
      const perkM = (row.querySelector('.watch-perk')?.textContent || '').match(/Perk at ([\d,]+) shares/i);
      if (!Number.isFinite(price)) return;
      stocks.push({
        id: (link.getAttribute('href') || '').split('/').pop(),
        name: link.textContent.trim(),
        perkText: row.querySelector('th small')?.textContent.trim() || '',
        perkShares: perkM ? num(perkM[1]) : null,
        price, delta, period,
        spark: row.querySelector('svg.sparkline polyline')?.getAttribute('points') || null,
        row,
      });
    });
    return stocks;
  }

  function logStocks(stocks) {
    const db = loadDb();
    const now = new Date().toISOString();
    let changed = false;
    stocks.forEach((s) => {
      if (s.period == null) return;
      const rec = db.stocks[s.id] || (db.stocks[s.id] = { name: s.name, obs: [] });
      rec.name = s.name;
      if (s.perkShares != null) rec.perkShares = s.perkShares;
      if (s.perkText) rec.perk = s.perkText;
      const last = rec.obs[rec.obs.length - 1];
      if (last && periodOf(last) === s.period && last.price === s.price) return;
      // The first sighting also keeps the page's own 10-point trend line, which can be used later to backfill.
      if (!rec.obs.length && s.spark) rec.firstSpark = { t: now, points: s.spark };
      rec.obs.push({ t: now, p: s.period, price: s.price, delta: s.delta });
      if (rec.obs.length > MAX_STOCK_TICKS) rec.obs.shift();
      changed = true;
    });
    if (changed) { db.updated = now; saveDb(db); }
  }

  // ─── Shared stock history on GitHub (two buttons on the Claw Street Ex page, nothing automatic) ───
  // Stock prices are the same for every player, so they can be shared without revealing anything about you.
  //  "Load shared history": downloads the community price history from GitHub (one request to raw.githubusercontent.com).
  //  "Contribute stock data": copies your logged prices and opens a GitHub issue page. You paste them and press submit.
  // Neither happens unless you press it. Nothing else you have logged (crimes, merits, cash, chat...) is ever included.
  const GITHUB_REPO = 'tcstrayben/Meowstreetscript'; // the GitHub "user/repo" that holds the script and the shared stock data
  const SHARED_KEY = 'ms_shared_stocks_v1';
  const MAX_SHARE_PERIODS = 1500; // about 15 days of 15-minute prices per stock
  const repoReady = () => !/YOURNAME/.test(GITHUB_REPO);
  let sharedStocks = null; // { fetchedAt, updated, periods, stocks: { id: { period: price } } }
  try { sharedStocks = JSON.parse(GM_getValue(SHARED_KEY, 'null')); } catch (e) { sharedStocks = null; }

  // Accepts only the expected shape and keeps whole-number prices for whole-number periods.
  function parseShared(text) {
    const j = JSON.parse(text);
    if (!j || j.format !== 1 || !j.stocks || typeof j.stocks !== 'object') throw new Error('unexpected file format');
    const stocks = {};
    let periods = 0;
    Object.entries(j.stocks).forEach(([id, st]) => {
      if (!/^[a-z0-9_-]{1,20}$/i.test(id) || !st || typeof st.prices !== 'object' || !st.prices) return;
      const m = {};
      Object.entries(st.prices).forEach(([period, v]) => {
        const k = Number(period);
        const price = Array.isArray(v) ? Number(v[0]) : Number(v);
        if (Number.isInteger(k) && Number.isInteger(price) && price > 0 && price < 10000000) { m[k] = price; periods++; }
      });
      stocks[id] = m;
    });
    return { fetchedAt: Date.now(), updated: typeof j.updated === 'string' ? j.updated.slice(0, 40) : null, periods, stocks };
  }

  function loadSharedStocks() {
    if (!repoReady()) { toast('Set GITHUB_REPO at the top of the script first (see SETUP.md).'); return; }
    if (typeof GM_xmlhttpRequest !== 'function') { toast('Your userscript manager cannot make this request.'); return; }
    toast('Downloading the shared stock history from GitHub...');
    GM_xmlhttpRequest({
      method: 'GET', url: `https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/stocks.json`, timeout: 20000,
      onload: (res) => {
        try {
          if (res.status !== 200) throw new Error('GitHub answered ' + res.status);
          const shared = parseShared(res.responseText);
          sharedStocks = shared;
          GM_setValue(SHARED_KEY, JSON.stringify(shared));
          toast(`Loaded ${shared.periods} shared price periods across ${Object.keys(shared.stocks).length} stocks` + (shared.updated ? ` (updated ${shared.updated.slice(0, 10)}).` : '.'));
          schedule();
        } catch (e) { toast('Could not read the shared history: ' + e.message); }
      },
      onerror: () => toast('Could not reach GitHub.'),
      ontimeout: () => toast('GitHub took too long to answer.'),
    });
  }

  // What would be sent: stock ids, 15-minute period numbers and whole-dollar prices. Nothing else.
  function buildContribution() {
    const db = loadDb();
    const out = { format: 1, script: typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : '', stocks: {} };
    let total = 0;
    Object.entries(db.stocks || {}).forEach(([id, st]) => {
      const byPeriod = new Map();
      (st.obs || []).forEach((o) => { const k = periodOf(o); if (k != null && Number.isInteger(o.price) && o.price > 0) byPeriod.set(k, o.price); });
      const periods = [...byPeriod.keys()].sort((a, b) => a - b).slice(-MAX_SHARE_PERIODS);
      if (!periods.length) return;
      const prices = {};
      periods.forEach((k) => { prices[k] = byPeriod.get(k); });
      out.stocks[id] = { prices };
      total += periods.length;
    });
    return total ? { payload: out, total } : null;
  }

  function contributeStocks() {
    if (!repoReady()) { toast('Set GITHUB_REPO at the top of the script first (see SETUP.md).'); return; }
    const c = buildContribution();
    if (!c) { toast('No stock prices logged yet. Open Claw Street Ex and let it record some first.'); return; }
    const text = JSON.stringify(c.payload);
    let copied = false;
    try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); copied = true; } } catch (e) { /* try the fallback */ }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch (e) { /* ignore */ }
    }
    const body = 'Paste the copied data between the two lines below (Ctrl+V), then press "Submit new issue". It is only stock ids, period numbers and prices, nothing personal.\n\n```json\n\n```\n';
    const url = `https://github.com/${GITHUB_REPO}/issues/new?title=${encodeURIComponent('[stock-data] submission')}&body=${encodeURIComponent(body)}`;
    if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: true }); else window.open(url, '_blank');
    toast(copied
      ? `Copied ${c.total} price periods. In the GitHub tab, paste them between the two lines and press "Submit new issue".`
      : 'Could not copy automatically. Use "Export data" instead, or try again.');
  }

  // The two buttons only exist on the Claw Street Ex pages.
  function syncShareButtons() {
    const box = document.getElementById('msx-tools');
    if (!box) return;
    const have = box.querySelectorAll('button[data-share]').length;
    if (isStockPage() && !have) {
      const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('data-share', '1');
        b.addEventListener('click', fn);
        box.insertBefore(b, box.firstChild);
      };
      mk('Contribute stock data', 'Copies your logged stock prices (only ids, periods and prices) and opens a GitHub page where you paste and submit them', contributeStocks);
      mk('Load shared history', 'Downloads the community stock price history from GitHub (one request, only when you press this)', loadSharedStocks);
    } else if (!isStockPage() && have) {
      box.querySelectorAll('button[data-share]').forEach((b) => b.remove());
    }
  }

  function stockStats(id, currentPrice) {
    const obs = (loadDb().stocks[id]?.obs) || [];
    // One price per price-period: keep the latest reading in each period.
    const bySlot = new Map();
    obs.forEach((o) => { const k = periodOf(o); if (k != null) bySlot.set(k, o.price); });
    // Periods you did not record yourself are filled in from the shared history, if you have loaded it.
    let sharedN = 0;
    const shared = sharedStocks?.stocks?.[id];
    if (shared) Object.keys(shared).forEach((k) => { const period = Number(k); if (!bySlot.has(period)) { bySlot.set(period, shared[k]); sharedN++; } });
    const prices = [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const n = prices.length;
    if (!n) return null;
    const min = Math.min(...prices), max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / n;
    const below = prices.filter((p) => p < currentPrice).length;
    const equal = prices.filter((p) => p === currentPrice).length;
    const pct = (below + equal / 2) / n;
    let trend = 0;
    if (n >= 6) {
      const recent = prices.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const before = prices.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
      trend = recent > before ? 1 : recent < before ? -1 : 0;
    }
    const flat = avg > 0 && (max - min) / avg < FLAT_RANGE;
    // Two views of "how high is it": the percentile counts how many recorded periods were lower (a price that sat at its
    // top for a long time can rank mid even one dollar below it), and the range position is how far up between the lowest
    // and highest price seen. Either one near an end counts.
    const pos = max > min ? (currentPrice - min) / (max - min) : 0.5;
    let verdict = 'learn';
    if (n >= MIN_TICKS_FOR_VERDICT) {
      verdict = flat ? 'flat' : (pct >= HIGH_PCT || pos >= HIGH_PCT) ? 'high' : (pct <= LOW_PCT || pos <= LOW_PCT) ? 'low' : 'mid';
    }
    return { prices, n, sharedN, min, max, avg, pct, pos, trend, verdict };
  }

  const ordinal = (n) => { const r = n % 100; const sfx = r >= 11 && r <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'); return n + sfx; };
  const VERDICT_LABEL = { low: 'Looks LOW', high: 'Looks HIGH', mid: 'Mid-range', flat: 'Flat so far', learn: 'Learning' };

  function drawStocks(stocks) {
    document.querySelectorAll('.msx-stock').forEach((n) => n.remove());
    stocks.forEach((s) => {
      const st = stockStats(s.id, s.price);
      const host = s.row.querySelector('th.watch-name');
      if (!host || !st) return;
      const box = document.createElement('div');
      box.className = 'msx-stock';
      const arrow = st.trend > 0 ? '↗' : st.trend < 0 ? '↘' : '→';
      const label = st.verdict === 'learn'
        ? `Learning ${st.n}/${MIN_TICKS_FOR_VERDICT}`
        : `${VERDICT_LABEL[st.verdict]} · ${Math.round(st.pos * 100)}% of range · ${ordinal(Math.round(st.pct * 100))} pct`;
      const sharedNote = st.sharedN ? ` · ${st.sharedN} of ${st.n} periods from shared history` : '';
      const perkCost = s.perkShares ? ` · perk ≈ ${fmtMoney(s.perkShares * s.price)}` : '';
      box.innerHTML =
        `<span class="msx-tag stk ${st.verdict}" title="% of range: how far up between the lowest and highest price recorded (0% = lowest seen, 100% = highest seen). pct: the share of recorded price periods that were lower. HIGH or LOW shows when either is within 20% of an end.">${label}</span>` +
        `<span class="msx-trend" title="Average of the last 3 price moves vs the 3 before">${st.n >= 6 ? arrow : ''}</span>` +
        `<small class="msx-range" title="Lowest / highest price this script has recorded, over ${st.n} price moves (avg $${st.avg.toFixed(1)})">` +
        `Lowest seen <b>$${st.min}</b> · Highest seen <b>$${st.max}</b> · Avg $${st.avg.toFixed(0)}${sharedNote}${perkCost}</small>`;
      host.appendChild(box);
    });
  }

  // ─── Stock tick countdown (sidebar, every page) ───────────────────────────
  // The game only shows the next-move time on the Claw Street Ex page. We remember it there and,
  // because prices move every 15 minutes, project it forward on every other page.
  const TICK_PERIOD_MS = 15 * 60 * 1000;
  const NEXT_MOVE_KEY = 'ms_next_stock_move';
  let nextMoveAnchor = Number(GM_getValue(NEXT_MOVE_KEY, 0)) || 0;

  function syncNextMove() {
    const iso = document.querySelector('time[data-countdown]')?.getAttribute('datetime');
    const ms = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(ms) && Math.abs(ms - nextMoveAnchor) > 2000) {
      nextMoveAnchor = ms;
      try { GM_setValue(NEXT_MOVE_KEY, ms); } catch (e) { /* ignore */ }
    }
  }

  function ensureTicker() {
    if (document.querySelector('.msx-ticker')) return;
    const vitals = document.querySelector('.sidebar .rail-vitals');
    if (!vitals || !vitals.parentNode) return;
    const el = document.createElement('div');
    el.className = 'msx-ticker';
    el.title = 'Time until the next Claw Street Ex price move (synced from the stock page, then counted forward every 15 minutes)';
    el.innerHTML = '<svg class="ms-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ms-stocks"></use></svg><span class="msx-ticker-text"></span>';
    vitals.parentNode.insertBefore(el, vitals);
    updateTicker();
  }

  function updateTicker() {
    const txt = document.querySelector('.msx-ticker-text');
    if (!txt) return;
    let out;
    let soon = false;
    if (!nextMoveAnchor) {
      out = 'Stocks: open Claw Street Ex once to sync';
    } else {
      const now = Date.now();
      const remain = (((nextMoveAnchor - now) % TICK_PERIOD_MS) + TICK_PERIOD_MS) % TICK_PERIOD_MS;
      const s = Math.ceil(remain / 1000);
      out = `Stocks tick in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      soon = s <= 60;
    }
    if (txt.textContent !== out) txt.textContent = out;
    txt.parentNode.classList.toggle('soon', soon);
  }

  // ─── Crew chain timer (sidebar, every page) ───────────────────────────────
  // The Crew page shows "Chain 294 · Alive for <time datetime=...>". That datetime is the exact moment the
  // crew chain dies. We save it and count down to it on every page. Other crew members' crimes can extend
  // the chain, so it is re-synced whenever the Crew page is open.
  const CHAIN_KEY = 'ms_crew_chain_state';
  const CHAIN_STALE_MS = 20 * 60 * 1000; // the pill turns red if the Crew page hasn't been read for this long
  let chainState = null; // { expires: ms, count }
  try { chainState = JSON.parse(GM_getValue(CHAIN_KEY, 'null')); } catch (e) { chainState = null; }

  function saveChainState() {
    try { GM_setValue(CHAIN_KEY, JSON.stringify(chainState)); } catch (e) { /* ignore */ }
  }

  function syncChain() {
    const chainEl = document.querySelector('.cd-chain');
    if (!chainEl) {
      // The crew hero is there but there is no chain block: the crew has no chain right now.
      if (document.querySelector('.cd-hero') && chainState) { chainState = null; saveChainState(); }
      return;
    }
    const iso = chainEl.querySelector('.cd-chain-window time[datetime]')?.getAttribute('datetime');
    const expires = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(expires)) return;
    const count = parseInt(chainEl.querySelector('.cd-chain-head h3 span')?.textContent.replace(/,/g, ''), 10);
    const c = Number.isFinite(count) ? count : null;
    const now = Date.now();
    const changed = !chainState || Math.abs(expires - chainState.expires) > 2000 || chainState.count !== c;
    // syncedAt is refreshed every time the Crew page is read, but only saved now and then (this runs about once a second).
    if (changed || now - (chainState.savedAt || 0) > 30000) {
      chainState = { expires, count: c, syncedAt: now, savedAt: now };
      saveChainState();
    } else {
      chainState.syncedAt = now;
    }
  }

  function ensureChainPill() {
    if (document.querySelector('.msx-chain')) return;
    const anchor = document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
    if (!anchor || !anchor.parentNode) return;
    const el = document.createElement('div');
    el.className = 'msx-ticker msx-chain';
    el.title = 'Time until your crew chain dies (synced from the Crew page, then counted down; other crew members can extend it)';
    el.innerHTML = '<svg class="ms-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ms-faction"></use></svg><span class="msx-chain-text"></span>';
    // Place it after the stocks pill, before the vitals.
    if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    updateChainPill();
  }

  function updateChainPill() {
    const txt = document.querySelector('.msx-chain-text');
    if (!txt) return;
    let out = 'Crew chain: open Crew to sync';
    let soon = false;
    let stale = true; // red until we have fresh data
    if (chainState) {
      const ageMs = Date.now() - (chainState.syncedAt || 0);
      stale = ageMs > CHAIN_STALE_MS;
      txt.parentNode.title = `Time until your crew chain dies. Last synced from the Crew page ${Math.floor(ageMs / 60000)} min ago` +
        (stale ? ' (stale: open the Crew page to refresh; other crew members may have extended it)' : '.');
      const remain = chainState.expires - Date.now();
      if (remain <= 0) {
        out = 'Crew chain: check Crew page';
      } else {
        const s = Math.ceil(remain / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        const clock = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
        out = `Crew chain${chainState.count != null ? ' ×' + chainState.count : ''} ends in ${clock}`;
        soon = remain <= 15 * 60 * 1000;
      }
      if (remain <= 0) stale = true;
    }
    if (txt.textContent !== out) txt.textContent = out;
    txt.parentNode.classList.toggle('soon', soon && !stale);
    txt.parentNode.classList.toggle('stale', stale);
  }

  setInterval(() => { updateTicker(); updateChainPill(); }, 1000);

  // ─── Page scanner: what does this page store or expose? ───────────────────
  // Read-only. It looks at what the page already has (browser storage names, page globals, endpoints the page
  // has called, progress bars, timers, the page text) and saves a summary per page into the exported data.
  // It calls nothing. It runs by itself once when you open a page (after the page has settled) and again only if the
  // page's content changes a lot (a tab opened, a list finished loading), and whenever you press "Scan page". It never
  // runs on a timer, and it never visits or requests a page for you: it only reads the page you are already looking at.
  // Sensitive-looking values (tokens, cookies, ids) are never saved, only their names. Chat is never read.
  const SCAN_TEXT_CAP = 8000;
  const MAX_SCANNED_PAGES = 40;
  const SENSITIVE = /token|auth|session|jwt|pass|secret|key|cookie|email|csrf|posthog|^ph_|distinct|user|uid/i;
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function scanStorage(st) {
    const out = [];
    try {
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        const v = st.getItem(k) || '';
        out.push({ key: k, length: v.length, value: SENSITIVE.test(k) ? '[not saved: sensitive-looking name]' : v.slice(0, 400) });
      }
    } catch (e) { /* storage blocked */ }
    return out;
  }

  function scanGlobals() {
    const out = [];
    try {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      document.body.appendChild(frame);
      const base = new Set(Object.getOwnPropertyNames(frame.contentWindow));
      frame.remove();
      Object.keys(pageWin).forEach((k) => {
        if (base.has(k) || /^(webkit|on|__ph|posthog)/i.test(k)) return;
        try {
          const v = pageWin[k];
          const t = typeof v;
          let info = t;
          if (v && t === 'object') info = Array.isArray(v) ? `array[${v.length}]` : `object{${Object.keys(v).slice(0, 15).join(', ')}}`;
          else if (t === 'string' || t === 'number' || t === 'boolean') info = SENSITIVE.test(k) ? t : `${t}: ${String(v).slice(0, 80)}`;
          out.push({ name: k, info });
        } catch (e) { out.push({ name: k, info: 'unreadable' }); }
      });
    } catch (e) { /* ignore */ }
    return out.slice(0, 80);
  }

  function scanEndpoints() {
    const map = {};
    try {
      performance.getEntriesByType('resource').forEach((e) => {
        if (!/^(fetch|xmlhttprequest|beacon)$/.test(e.initiatorType)) return;
        try {
          const u = new URL(e.name);
          // Keep the path and the query key names only, never query values.
          const k = u.origin + u.pathname + (u.search ? '?' + [...u.searchParams.keys()].join('&') : '');
          map[k] = (map[k] || 0) + 1;
        } catch (err) { /* bad url */ }
      });
    } catch (e) { /* ignore */ }
    return Object.entries(map).map(([url, count]) => ({ url, count })).slice(0, 60);
  }

  const notChat = (el) => !el.closest('.chat-panel, .chat-messages, .right-column');

  // Page text without our own additions and without the chat column.
  function readMainText(cap) {
    const root = document.querySelector('.main-content') || document.querySelector('main');
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.msx-info, .msx-stock, .msx-heat, .msx-ticker, script, style').forEach((n) => n.remove());
    clone.querySelectorAll('div, p, li, h1, h2, h3, h4, tr, dt, dd, article, section, br').forEach((n) => n.appendChild(document.createTextNode('\n')));
    return clone.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, cap);
  }

  function scanDom() {
    const bars = [];
    document.querySelectorAll('[role="progressbar"]').forEach((b) => {
      if (bars.length < 80) bars.push({ label: b.getAttribute('aria-label') || '', text: b.getAttribute('aria-valuetext') || '', now: b.getAttribute('aria-valuenow') });
    });
    const timers = [...document.querySelectorAll('time[datetime]')].filter(notChat).slice(0, 30).map((t) => ({
      text: t.textContent.trim(), datetime: t.getAttribute('datetime'),
      context: (t.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      countdown: t.hasAttribute('data-countdown'),
    }));
    const headings = [...document.querySelectorAll('main h1, main h2, main h3')].filter(notChat)
      .map((h) => h.textContent.trim().slice(0, 60)).slice(0, 60);
    const pairs = [];
    document.querySelectorAll('main dl > div').forEach((d) => {
      const k = d.querySelector('dt')?.textContent.trim(), v = d.querySelector('dd')?.textContent.trim();
      if (k && pairs.length < 60) pairs.push([k, v]);
    });
    const vitals = [...document.querySelectorAll('.sidebar .rv')].map((rv) => ({
      name: rv.querySelector('.rv-name')?.textContent.trim(),
      value: rv.querySelector('.rv-value')?.textContent.replace(/\s+/g, ' ').trim(),
      note: rv.querySelector('.rv-note')?.textContent.replace(/\s+/g, ' ').trim(),
    }));
    const mainText = readMainText(SCAN_TEXT_CAP);
    const dataScripts = [...document.querySelectorAll('script[type="application/json"], script[id*="data" i], script[id*="state" i]')]
      .map((sc) => ({ id: sc.id || '', type: sc.type || '', length: (sc.textContent || '').length }));
    return { bars, timers, headings, pairs, vitals, mainText, dataScripts };
  }

  async function scanPage(manual, light) {
    if (!location.href.startsWith(SITE_ORIGIN + '/')) return; // only scan https://meowstreets.com/... pages
    const path = location.pathname;
    const dom = scanDom();
    let idb = [];
    try { if (indexedDB.databases) idb = (await indexedDB.databases()).map((d) => d.name); } catch (e) { /* ignore */ }
    const ls = scanStorage(localStorage), ss = scanStorage(sessionStorage);
    const cookieNames = document.cookie ? document.cookie.split(';').map((c) => c.split('=')[0].trim()) : [];
    const globals = light ? [] : scanGlobals(); // the page globals do not change, so the automatic capture skips them
    const endpoints = scanEndpoints();
    const result = {
      path, scannedAt: new Date().toISOString(), auto: !manual,
      summary: {
        localStorageKeys: ls.length, sessionStorageKeys: ss.length, cookies: cookieNames.length, indexedDbDatabases: idb.length,
        pageGlobals: globals.length, endpoints: endpoints.length, progressBars: dom.bars.length, timers: dom.timers.length,
      },
      localStorage: ls, sessionStorage: ss, cookieNames, indexedDbDatabases: idb, pageGlobals: globals, endpoints,
      ...dom,
    };
    const db = loadDb();
    if (!db.pageScans) db.pageScans = {};
    db.pageScans[path] = result;
    const paths = Object.keys(db.pageScans);
    if (paths.length > MAX_SCANNED_PAGES) {
      paths.sort((a, b) => db.pageScans[a].scannedAt.localeCompare(db.pageScans[b].scannedAt));
      paths.slice(0, paths.length - MAX_SCANNED_PAGES).forEach((p) => delete db.pageScans[p]);
    }
    db.updated = result.scannedAt;
    saveDb(db);
    if (manual) {
      const sm = result.summary;
      toast(`Scanned ${path}: ${sm.localStorageKeys + sm.sessionStorageKeys} storage keys, ${sm.cookies} cookies, ${sm.indexedDbDatabases} databases, ` +
        `${sm.pageGlobals} page globals, ${sm.endpoints} endpoints, ${sm.progressBars} bars, ${sm.timers} timers. Saved. Use Export data to get the file.`);
    }
  }

  function toast(msg) {
    let t = document.getElementById('msx-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'msx-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 9000);
  }

  // ─── Modifiers and gym multiplier (read passively from pages you open) ────
  // What changes the success % besides base, mastery and heat? Merits, education, stock perks... We log them as
  // you visit those pages so each crime observation can be lined up with them. Read-only, nothing is sent.
  const MAX_MOD_LOG = 200;
  const MAX_GYM_OBS = 300;

  function readModifiers() {
    const path = location.pathname.replace(/\/+$/, '');
    const db = loadDb();
    if (!db.mods) db.mods = { merits: {} };
    const mods = db.mods;
    let found = false;
    const now = Date.now();
    let touched = false;
    // Remember when each page was last read, for the "Script data" checklist.
    const touch = (key) => { (mods.at || (mods.at = {}))[key] = now; touched = true; };

    if (path === '/merits') {
      const ranks = {};
      document.querySelectorAll('[role="progressbar"]').forEach((b) => {
        const m = (b.getAttribute('aria-valuetext') || '').match(/(\d+)\s+of\s+(\d+)\s+ranks/i);
        const label = b.getAttribute('aria-label');
        if (m && label) ranks[label] = parseInt(m[1], 10);
      });
      if (Object.keys(ranks).length) {
        mods.merits = ranks; found = true; touch('merits');
        const t = readMainText(3000).match(/(\d+)\s+merits? to spend\s*·\s*(\d+)\s+earned\s*·\s*(\d+)\s+spent/i);
        if (t) { mods.meritsToSpend = +t[1]; mods.meritsEarned = +t[2]; mods.meritsSpent = +t[3]; }
      }
    }

    if (path === '/crew') {
      if (document.querySelector('.cd-hero')) touch('crew');
      // The crew chain block carries "+5% crime · <time>": a day of +5 crime success earned at each 250 milestone.
      if (document.querySelector('.cd-chain')) {
        const tag = document.querySelector('.cd-chain .tag.warn');
        const m = tag && tag.textContent.match(/\+(\d+)%\s*crime/i);
        const iso = tag?.querySelector('time[datetime]')?.getAttribute('datetime');
        const until = iso ? Date.parse(iso) : NaN;
        mods.crewBonus = m && Number.isFinite(until) ? { pct: +m[1], until } : { pct: 0, until: 0 };
        if (mods.crewBonus.pct > 0) mods.crewPctSeen = mods.crewBonus.pct;
        found = true; touch('crew');
      }
      // The Perks tab lists "Inside line +1% crime chance" (only rendered while that tab is open).
      const perk = readMainText(8000).match(/Inside line\s*\+(\d+)%\s*crime chance/i);
      if (perk) { mods.crewPerkCrime = +perk[1]; found = true; touch('perks'); }
    }

    if (path === '/mews') {
      // "Crew chain reached 250: +15 respect and a day of +5% crime chance." The window lasts 24 hours from that entry
      // (checked against the Crew page: 06:55 UTC entry, window ended 06:55 UTC the next day).
      const DAY_MS = 24 * 3600 * 1000;
      let best = null;
      document.querySelectorAll('time[datetime]').forEach((tm) => {
        const m = (tm.parentElement?.textContent || '').match(/Crew chain reached\s+[\d,]+:[^.]*?a day of \+(\d+)% crime chance/i);
        const start = Date.parse(tm.getAttribute('datetime'));
        if (m && Number.isFinite(start) && (!best || start > best.start)) best = { start, pct: +m[1] };
      });
      if (best) {
        const until = best.start + DAY_MS;
        if (!mods.crewBonus || !(mods.crewBonus.until >= until)) {
          mods.crewBonus = { pct: best.pct, until, fromMews: true };
          mods.crewPctSeen = best.pct;
        }
        found = true;
      }
    }

    if (path.startsWith('/education')) {
      const text = readMainText(6000);
      const pts = text.match(/Every crime.s success chance\s*\+(\d+)\s*points?/i);
      const taken = text.match(/(\d+)\s+of\s+48\s+taken/i);
      if (pts || taken) {
        mods.eduCrimePoints = pts ? +pts[1] : 0;
        if (taken) mods.coursesTaken = +taken[1];
        found = true; touch('education');
        // When the course in the seat lands (its perk switches on by itself, even while you are away).
        const lands = [...document.querySelectorAll('time[datetime]')]
          .filter((t) => /^\s*Lands\s/.test(t.parentElement?.textContent || ''))
          .map((t) => Date.parse(t.getAttribute('datetime'))).filter(Number.isFinite);
        mods.eduLandsAt = lands.length ? Math.min(...lands) : null;
      }
    }

    if (found) {
      const snap = JSON.stringify([mods.merits, mods.eduCrimePoints, mods.coursesTaken, mods.meritsSpent, mods.crewBonus, mods.crewPerkCrime]);
      if (snap !== mods.lastSnap) {
        mods.lastSnap = snap;
        if (!db.modLog) db.modLog = [];
        db.modLog.push({ t: new Date().toISOString(), playerLevel: readPlayerLevel(), merits: mods.merits,
          eduCrimePoints: mods.eduCrimePoints ?? null, coursesTaken: mods.coursesTaken ?? null,
          meritsSpent: mods.meritsSpent ?? null, meritsEarned: mods.meritsEarned ?? null,
          crewBonus: mods.crewBonus ?? null, crewPerkCrime: mods.crewPerkCrime ?? null });
        if (db.modLog.length > MAX_MOD_LOG) db.modLog.shift();
        mods.updated = new Date().toISOString();
        db.updated = mods.updated;
        saveDb(db);
        touched = false;
      }
    }
    // The page ticks about once a second, so read times are only saved now and then.
    if (touched && now - (mods.atSaved || 0) > 20000) { mods.atSaved = now; saveDb(db); }
  }

  // Mews training lines: "Trained strength at the Alley Gym. +6 strength (5.51 progress), -50 energy, -25 happiness."
  // The number in brackets is the exact gain. Gain per 10 energy / (Grit x Crew gym x gym focus) is the happiness
  // multiplier at that moment, so old sessions tell us about happiness levels we never looked at.
  const MAX_TRAIN_LOG = 500;
  function readTraining() {
    if (location.pathname.replace(/\/+$/, '') !== '/mews') return;
    const db = loadDb();
    if (!db.trainLog) db.trainLog = [];
    const seen = new Set(db.trainLog.map((e) => e.t + '|' + e.stat + '|' + e.gain));
    let added = 0;
    document.querySelectorAll('time[datetime]').forEach((tm) => {
      const m = (tm.parentElement?.textContent || '').match(/Trained\s+(\w+)\s+at\s+(.+?)\.\s*\+(\d+)\s+\w+\s*\(([\d.]+)\s*progress\),\s*[−-](\d+)\s*energy,\s*[−-](\d+)\s*happiness/i);
      const t = tm.getAttribute('datetime');
      if (!m || !t) return;
      const e = { t, stat: m[1].toLowerCase(), gym: m[2], gainWhole: +m[3], gain: +m[4], energy: +m[5], happinessCost: +m[6] };
      e.per10 = +(e.gain / (e.energy / 10)).toFixed(4);
      if (seen.has(e.t + '|' + e.stat + '|' + e.gain)) return;
      db.trainLog.push(e); seen.add(e.t + '|' + e.stat + '|' + e.gain); added++;
    });
    if (added) {
      db.trainLog.sort((a, b) => a.t.localeCompare(b.t));
      while (db.trainLog.length > MAX_TRAIN_LOG) db.trainLog.shift();
      db.updated = new Date().toISOString();
      saveDb(db);
    }
  }

  // Cat Tree: the page states the happiness multiplier itself ("100 of 100 happiness · x1.00 on everything here"),
  // so logging it at different happiness levels gives the real curve without any guessing.
  function readGym() {
    if (location.pathname.replace(/\/+$/, '') !== '/cat-tree') return;
    const text = readMainText(9000);
    const h = text.match(/([\d,]+)\s+of\s+([\d,]+)\s+happiness\s*·\s*×([\d.]+)/i);
    if (!h) return;
    const stations = {};
    const re = /builds\s+(\w+)\s*·\s*×([\d.]+)[\s\S]{0,60}?([\d,]+)\s*\+([\d.]+)\s*a session/gi;
    let m;
    while ((m = re.exec(text))) stations[m[1].toLowerCase()] = { focus: +m[2], value: num(m[3]), gain: +m[4] };
    const spent = text.match(/([\d,]+)\s+energy spent on training/i);
    const energy = text.match(/([\d,]+)\s+of\s+([\d,]+)\s+energy/i);
    const sessions = (text.match(/Every station, this session([^\n]+)/i) || [])[1] || null;
    const gym = (text.match(/TRAINING AT\s*([^\n]+)/i) || [])[1] || null;
    const obs = {
      t: new Date().toISOString(), gym, happiness: num(h[1]), happinessMax: num(h[2]), multiplier: +h[3],
      fitMultiplier: +((num(h[1]) + 100) / 200).toFixed(4), // (happiness + 100) / 200: 1 at 100, 1.25 at 150, 5.5 at 1,000
      energy: energy ? num(energy[1]) : null, energySpentTotal: spent ? num(spent[1]) : null, stations, sessions,
    };
    const db = loadDb();
    if (!db.gymLog) db.gymLog = [];
    const last = db.gymLog[db.gymLog.length - 1];
    const sig = (o) => JSON.stringify([o.gym, o.happiness, o.multiplier, o.energySpentTotal, o.stations]);
    if (last && sig(last) === sig(obs)) return;
    db.gymLog.push(obs);
    if (db.gymLog.length > MAX_GYM_OBS) db.gymLog.shift();
    db.updated = obs.t;
    saveDb(db);
  }

  // ─── "Script data" checklist (top of the sidebar) ─────────────────────────
  // The script only knows what you have opened. This shows which pages it has read recently and which need a visit.
  // Green = up to date, gold = open that page once to refresh, red = never read. The links only navigate when you click.
  const HOUR = 3600000;
  function ago(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 2) return 'just now';
    if (m < 90) return m + ' min ago';
    if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  }

  function dataStatus() {
    const db = loadDb();
    const mods = db.mods || {};
    const at = mods.at || {};
    const now = Date.now();
    const rows = [];
    const add = (name, href, note, state, text) => rows.push({ name, href, note, state, text });
    const seen = (t, maxAge) => (t ? (now - t > maxAge ? 'warn' : 'ok') : 'bad');

    add('Merits', '/merits', '', seen(at.merits, 24 * HOUR), at.merits ? 'read ' + ago(now - at.merits) : 'not read yet');

    let eduState = seen(at.education, 24 * HOUR);
    let eduText = at.education ? 'read ' + ago(now - at.education) : 'not read yet';
    if (at.education && mods.eduLandsAt && now > mods.eduLandsAt) { eduState = 'warn'; eduText = 'a course has landed, open it to update'; }
    add('Education', '/education', '', eduState, eduText);

    // The crew chain dies after 30 minutes without a crime and anyone in the crew can extend it, so Crew goes stale after 20.
    const crewSeen = Math.max(at.crew || 0, chainState?.syncedAt || 0);
    let crewState = seen(crewSeen, CHAIN_STALE_MS);
    let crewText = crewSeen ? 'read ' + ago(now - crewSeen) : 'not read yet';
    if (crewSeen && crewState === 'ok' && mods.crewBonus?.pct > 0 && mods.crewBonus.until < now) { crewState = 'warn'; crewText = 'crew +5% window ended, check for a new one'; }
    add('Crew (chain and +5% bonus)', '/crew', 'every 20 min', crewState, crewText);

    add('Crew > Perks tab', '/crew', 'then click the Perks tab', seen(at.perks, 24 * HOUR), at.perks ? 'read ' + ago(now - at.perks) : 'not read yet');

    let lastStock = 0;
    Object.values(db.stocks || {}).forEach((st) => { const o = st.obs?.[st.obs.length - 1]; if (o) lastStock = Math.max(lastStock, Date.parse(o.t) || 0); });
    add('Claw Street Ex (prices)', '/claw-street-ex', '', seen(lastStock, 2 * HOUR), lastStock ? 'last logged ' + ago(now - lastStock) : 'not read yet');
    return rows;
  }

  function ensureLegend() {
    if (document.querySelector('.msx-legend')) return;
    const anchor = document.querySelector('.sidebar .brand') || document.querySelector('.sidebar .profile');
    if (!anchor || !anchor.parentNode) return;
    const el = document.createElement('details');
    el.className = 'msx-legend';
    el.innerHTML = '<summary><i class="msx-dot"></i><span class="msx-legend-sum"></span></summary>' +
      '<div class="msx-legend-list"></div>' +
      '<p class="msx-legend-key"><b class="ok">Green</b> up to date · <b class="warn">Gold</b> open that page once to refresh · <b class="bad">Red</b> never read. ' +
      'The script only knows what you have opened.</p>';
    anchor.after(el);
    updateLegend();
  }

  function updateLegend() {
    const el = document.querySelector('.msx-legend');
    if (!el) return;
    const rows = dataStatus();
    const bad = rows.filter((r) => r.state === 'bad').length;
    const warn = rows.filter((r) => r.state === 'warn').length;
    const state = bad ? 'bad' : warn ? 'warn' : 'ok';
    const sum = bad ? `Script data: ${bad} page${bad === 1 ? '' : 's'} not read yet` : warn ? `Script data: ${warn} to check` : 'Script data: all up to date';
    const sumEl = el.querySelector('.msx-legend-sum');
    if (sumEl.textContent !== sum) sumEl.textContent = sum;
    el.className = 'msx-legend ' + state;
    const html = rows.map((r) => `<div class="msx-legend-row ${r.state}"><i class="msx-dot"></i><a href="${r.href}">${r.name}</a>` +
      `<span>${r.text}${r.note ? ' · ' + r.note : ''}</span></div>`).join('');
    const list = el.querySelector('.msx-legend-list');
    if (list.innerHTML !== html) list.innerHTML = html;
  }

  setInterval(updateLegend, 30000);

  // ─── Capture on view ──────────────────────────────────────────────────────
  // Whatever a page shows while you are looking at it is saved: once shortly after the page appears (so it has settled),
  // and again only if its content changes a lot (you opened a tab, a list finished loading). One capture per page view,
  // never on a timer. Only the latest capture of each page is kept. Pages that hold account, payment or other cats'
  // details are never captured.
  const CAPTURE_DELAY_MS = 5000;
  const RECAPTURE_MIN_MS = 15000;
  const NEVER_CAPTURE = [/^\/account/, /^\/paw-shop/, /^\/login/, /^\/register/, /^\/reset/, /^\/logout/, /^\/cat\//, /^\/players/, /\/\d+(\/|$)/];
  const currentPath = () => location.pathname.replace(/\/+$/, '') || '/';
  const capturable = (path) => !NEVER_CAPTURE.some((re) => re.test(path));
  let viewPath = null;
  let viewTimer = null;
  let lastCaptureAt = 0;
  let lastCaptureLen = 0;

  function captureNow(path) {
    viewTimer = null;
    if (currentPath() !== path) return; // you have moved on
    const main = document.querySelector('.main-content') || document.querySelector('main');
    if (!main) return;
    lastCaptureAt = Date.now();
    lastCaptureLen = main.textContent.length;
    scanPage(false, true).catch(() => {});
  }

  function noteView() {
    const path = currentPath();
    if (path !== viewPath) { // a new page view
      viewPath = path;
      lastCaptureAt = 0;
      lastCaptureLen = 0;
      if (viewTimer) clearTimeout(viewTimer);
      viewTimer = capturable(path) ? setTimeout(() => captureNow(path), CAPTURE_DELAY_MS) : null;
      return;
    }
    // Same page: capture again only if what it shows has changed a lot since the last capture.
    if (viewTimer || !lastCaptureAt || !capturable(path)) return;
    const main = document.querySelector('.main-content') || document.querySelector('main');
    if (!main) return;
    const len = main.textContent.length;
    if (Math.abs(len - lastCaptureLen) > Math.max(300, lastCaptureLen * 0.15) && Date.now() - lastCaptureAt > RECAPTURE_MIN_MS) {
      viewTimer = setTimeout(() => captureNow(path), 2000);
    }
  }

  // ─── Mews event log ───────────────────────────────────────────────────────
  // The Mews page lists what happened to you, newest first, each with an exact time. Every line is saved once
  // (with the numbers pulled out where the wording is known) so real success rates, jail and near-miss shares,
  // payouts and clean-job drops can be worked out. Kept in its own storage key so the main data stays small.
  const EVENTS_KEY = 'ms_events_v1';
  const MAX_EVENTS = 3000;
  let eventsCache = null;
  let eventKeys = null;

  function loadEvents() {
    if (eventsCache) return eventsCache;
    try { eventsCache = JSON.parse(GM_getValue(EVENTS_KEY, 'null')); } catch (e) { eventsCache = null; }
    if (!eventsCache || !Array.isArray(eventsCache.events)) eventsCache = { v: 1, events: [] };
    eventKeys = new Set(eventsCache.events.map((e) => e.t + '|' + e.text));
    return eventsCache;
  }

  const moneyOf = (v) => Number(String(v).replace(/,/g, ''));

  function parseEvent(text) {
    let m;
    if ((m = text.match(/^(.+?) succeeded\. You earned \$([\d,]+) and (\d+) XP\.(?: Chain ×(\d+)(?: \((\d+)% bonus\))?\.)?/i))) {
      return { kind: 'crime', outcome: 'success', crime: m[1], cash: moneyOf(m[2]), xp: +m[3], chain: m[4] ? +m[4] : null, chainBonusPct: m[5] ? +m[5] : 0 };
    }
    if ((m = text.match(/^(.+?): a clean job! You earned \$([\d,]+), (\d+) XP(?: and found (.+?))?\.(?: Chain ×(\d+)\.)?/i))) {
      return { kind: 'crime', outcome: 'clean', crime: m[1], cash: moneyOf(m[2]), xp: +m[3], found: m[4] || null, chain: m[5] ? +m[5] : null };
    }
    if ((m = text.match(/^(.+?) slipped away at the last second\./i))) return { kind: 'crime', outcome: 'nearmiss', crime: m[1] };
    if ((m = text.match(/^(.+?) failed\. You.re in jail for (\d+) (minute|hour)s?(?: and the arrest cost (\d+) health)?/i))) {
      return { kind: 'crime', outcome: 'jail', crime: m[1], jailMinutes: +m[2] * (m[3].toLowerCase() === 'hour' ? 60 : 1), healthLost: m[4] ? +m[4] : 0 };
    }
    if ((m = text.match(/^(Bought|Sold) ([\d,]+) × (.+?) at \$([\d,]+) = \$([\d,]+)/i))) {
      return { kind: 'trade', side: m[1].toLowerCase(), qty: moneyOf(m[2]), item: m[3], price: moneyOf(m[4]), total: moneyOf(m[5]) };
    }
    if ((m = text.match(/^Trained (\w+) at (.+?)\. \+(\d+) \w+ \(([\d.]+) progress\), .(\d+) energy, .(\d+) happiness/i))) {
      return { kind: 'train', stat: m[1].toLowerCase(), gym: m[2], gain: +m[4], energy: +m[5], happinessCost: +m[6] };
    }
    if ((m = text.match(/^Used (.+?)\. Restored (\d+) (\w+)/i))) return { kind: 'use', item: m[1], restored: +m[2], stat: m[3].toLowerCase() };
    if ((m = text.match(/^Award unlocked: (.+?)\./i))) return { kind: 'award', award: m[1] };
    if ((m = text.match(/^(?:Deposited|Withdrew) \$([\d,]+)/i))) return { kind: 'bank', amount: moneyOf(m[1]), direction: /^Deposited/i.test(text) ? 'in' : 'out' };
    if ((m = text.match(/^(.+?) launched with (\d+)% chance/i))) return { kind: 'heist', job: m[1], chancePct: +m[2] };
    if ((m = text.match(/^Moved into (.+?) for \$([\d,]+)\. Happiness cap is now (\d+)/i))) return { kind: 'home', home: m[1], cost: moneyOf(m[2]), happinessCap: +m[3] };
    return { kind: 'other' };
  }

  function readEvents() {
    if (currentPath() !== '/mews') return;
    const store = loadEvents();
    let added = 0;
    document.querySelectorAll('.main-content time[datetime]').forEach((tm) => {
      const t = tm.getAttribute('datetime');
      let text = (tm.parentElement?.textContent || '').trim();
      const stamp = tm.textContent.trim();
      if (stamp && text.startsWith(stamp)) text = text.slice(stamp.length);
      text = text.replace(/\s*\[(?:view|spend)\]\s*$/i, '').replace(/\s+/g, ' ').trim();
      if (!t || !text || text.length > 400) return;
      const key = t + '|' + text;
      if (eventKeys.has(key)) return;
      eventKeys.add(key);
      store.events.push({ t, text, ...parseEvent(text) });
      added++;
    });
    if (!added) return;
    store.events.sort((a, b) => a.t.localeCompare(b.t));
    while (store.events.length > MAX_EVENTS) store.events.shift();
    try { GM_setValue(EVENTS_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  let observer = null;
  let timer = null;

  function run() {
    timer = null;
    if (observer) observer.disconnect(); // don't react to our own edits
    try {
      injectStyle();
      ensureExportButton();
      syncShareButtons();
      noteView();
      readModifiers();
      readEvents();
      readGym();
      readTraining();
      if (isCrimesPage() && document.querySelector('.ladders article.rung')) {
        const data = readAll();
        draw(data);
        logObservations(data);
      }
      if (isStockPage()) syncNextMove();
      ensureTicker();
      ensureLegend();
      updateLegend();
      syncChain();
      ensureChainPill();
      if (isStockPage() && document.querySelector('.watch-table')) {
        const stocks = readStocks();
        logStocks(stocks);
        drawStocks(stocks);
      }
    } catch (e) {
      console.error('[MeowStreets Extra Info]', e);
    }
    observe();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, REFRESH_DEBOUNCE_MS);
  }

  function observe() {
    // Ignore our own once-a-second ticker updates so they don't trigger a full redraw.
    if (!observer) {
      observer = new MutationObserver((muts) => {
        const own = (m) => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('.msx-ticker, .msx-legend, #msx-toast, #msx-tools');
        if (muts.every(own)) return;
        schedule();
      });
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // Keep this tab in step with the others: when another tab saves something, take it in.
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(DB_KEY, (name, oldValue, newValue, remote) => {
      if (!remote || !dbCache) return;
      try {
        const incoming = JSON.parse(newValue);
        // Keep any read times this tab has that are newer than the ones just saved by the other tab.
        const localAt = dbCache.mods?.at || {};
        if (!incoming.mods) incoming.mods = { merits: {} };
        const at = incoming.mods.at || (incoming.mods.at = {});
        Object.keys(localAt).forEach((k) => { if (!(at[k] >= localAt[k])) at[k] = localAt[k]; });
        if (!incoming.stocks) incoming.stocks = {};
        dbCache = incoming;
      } catch (e) { dbCache = null; }
      updateLegend(); // show the newly saved read times right away
    });
    GM_addValueChangeListener(CHAIN_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      try { chainState = JSON.parse(newValue); } catch (e) { /* ignore */ }
    });
    GM_addValueChangeListener(EVENTS_KEY, (name, oldValue, newValue, remote) => {
      if (remote) { eventsCache = null; eventKeys = null; }
    });
    GM_addValueChangeListener(SHARED_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      try { sharedStocks = JSON.parse(newValue); } catch (e) { /* ignore */ }
    });
    GM_addValueChangeListener(NEXT_MOVE_KEY, (name, oldValue, newValue, remote) => {
      if (remote) nextMoveAnchor = Number(newValue) || 0;
    });
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('MeowStreets: export data', exportDb);
    GM_registerMenuCommand('MeowStreets: load shared stock history', loadSharedStocks);
    GM_registerMenuCommand('MeowStreets: contribute stock data', contributeStocks);
    GM_registerMenuCommand('MeowStreets: scan this page', () => { scanPage(true).catch(() => {}); });
  }

  schedule();
  observe();
})();
