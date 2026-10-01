// ==UserScript==
// @name         MeowStreets Extra Info
// @namespace    https://meowstreets.com
// @version      0.15.7
// @description  Crimes page: exact XP and cash per nerve, item drops, the success % breakdown and the best crimes highlighted on every card. Claw Street Ex: logs stock prices and shows if a price looks low or high. Sidebar timers for stocks and your crew chain, a "Script data" checklist, page capture and a Mews event log, all kept on your computer. It also reads (never requests) the JSON the game's own pages fetch from their own API, for exact crime, merit and crew numbers. It sends nothing anywhere.
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
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  // Only ever run on https://meowstreets.com/... pages (crimes, merits, and so on). The @match line already
  // limits this; the check is a second guard, and the scanner repeats it before reading anything.
  const SITE_ORIGIN = 'https://meowstreets.com';
  if (location.origin !== SITE_ORIGIN) return;

  // READ-ONLY by design (MeowStreets ToS: "no bots, scripts or automation that play for you").
  // This script only reads what is already on the page you are looking at and draws numbers next to it.
  // It makes no network requests of its own, clicks nothing and presses nothing. It does read the responses to
  // requests the page itself makes (its own /api/state call) for exact numbers, the same way it reads rendered
  // text -- see api-data-reference.md. Only specific known fields are ever kept; the rest (which includes your
  // email and other players' data) is discarded at once, never saved. Everything it records stays in this
  // browser (Tampermonkey storage) until you press "Export data".

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

  // ─── Reading the game's own /api/state response (still read-only) ─────────
  // The page itself fetches this on most navigations, to load almost its whole state in one go. This only
  // watches the response to that request; it never makes a request of its own. Only the specific fields below
  // are ever kept, in memory for this page view only, never saved to storage or exported: the raw response also
  // carries the account email and other players' data, which this project must never touch. See
  // api-data-reference.md for the full shape of what the response contains.
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  let apiState = null; // { at, crimes: {key: {...}}, meritLines: {name: {...}}, merits, crew, chain } | null

  function extractApiState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
      const out = {
        at: Date.now(), crimes: {}, meritLines: {}, merits: null, crew: null, chain: null, stocks: null, events: [],
        education: null, companion: null, protectedUntil: 0, bountyOnMe: 0, cooldowns: {}, usedUp: [], energy: null, nerve: null, caps: null,
        storeItems: {}, listings: [],
        heists: [], crewJobTiers: [], heistXp: null, activeCrewJob: null, activeHeist: null, myCrewJobs: [], myHeists: [], crewJobRoles: null,
      };
      (raw.crimes || []).forEach((c) => {
        if (!c || !c.name) return;
        out.crimes[norm(c.name)] = {
          chance: c.chance, baseChance: c.baseChance, masteryLevel: c.masteryLevel, masteryBonus: c.masteryBonus,
          heat: c.heat, hot: !!c.hot, bonus: c.bonus, criticalChance: c.criticalChance,
          successes: c.successes, attempts: c.attempts, payMin: c.payMin, payMax: c.payMax,
        };
      });
      if (raw.merits && typeof raw.merits === 'object') {
        out.merits = { available: raw.merits.available, earned: raw.merits.earned, spent: raw.merits.spent };
        (raw.merits.lines || []).forEach((l) => {
          if (l && l.name) out.meritLines[l.name] = { ranks: l.ranks, max: l.max, now: l.now, next: l.next, price: l.price };
        });
      }
      if (raw.crew && typeof raw.crew === 'object') {
        out.crew = {
          name: raw.crew.name || null,
          buffActive: !!raw.crew.buffActive, buffUntil: raw.crew.buff_until || 0,
          chain: raw.crew.chain, chainAt: raw.crew.chain_at, chainEndsAt: raw.crew.chainEndsAt,
          treasury: raw.crew.treasury, respect: raw.crew.respect,
        };
      }
      if (raw.chain && typeof raw.chain === 'object') {
        out.chain = { count: raw.chain.count, multiplier: raw.chain.multiplier, next: raw.chain.next, expiresAt: raw.chain.expiresAt };
      }
      // Only this one field of `player` is ever kept -- that object also carries the account email, so it is
      // never read as a whole.
      if (raw.player && typeof raw.player === 'object') out.protectedUntil = raw.player.protected_until || 0;
      if (Number.isFinite(raw.bountyOnMe)) out.bountyOnMe = raw.bountyOnMe;
      // Every consumable shares a cooldown with others of its own family (only "tuna" for Premium tuna, and
      // "catnip" for Catnip tea, are confirmed so far -- from the user's own data, not guessed).
      out.cooldowns = {};
      (raw.cooldowns || []).forEach((c) => { if (c && c.item) out.cooldowns[c.item] = c.expires || 0; });
      out.usedUp = Array.isArray(raw.usedUp) ? raw.usedUp.slice() : [];
      // Only these two fields of `player` are ever kept here too (see the note on protectedUntil above).
      if (raw.player && typeof raw.player === 'object') { out.energy = raw.player.energy; out.nerve = raw.player.nerve; }
      if (raw.caps && typeof raw.caps === 'object') out.caps = { energy: raw.caps.energy, nerve: raw.caps.nerve };
      // heistQuote.targets is already personalised to the player's own level (band) and skill -- stake, profit,
      // failReturn, chance and energy/nerve cost are the game's own, real numbers for a heist launched right now.
      // "profit" is the average per-cat profit on success, confirmed against the user's own completed heist
      // (stake + profit matched the average of the real per-member payouts exactly).
      // bands[].minLevel is the real minimum player level per heist tier (heistQuote.targets itself is already
      // filtered to what this player can see, so it never says this directly) -- matched by `tier` below.
      const heistMinLevelByTier = {};
      if (raw.heistRules && Array.isArray(raw.heistRules.bands)) {
        raw.heistRules.bands.forEach((b) => { if (b && b.tier != null) heistMinLevelByTier[b.tier] = b.minLevel; });
      }
      if (raw.heistQuote && Array.isArray(raw.heistQuote.targets)) {
        out.heists = raw.heistQuote.targets.map((t) => ({
          name: t.name, short: t.short, badge: t.badge, tier: t.tier, minLevel: heistMinLevelByTier[t.tier] != null ? heistMinLevelByTier[t.tier] : null,
          stake: t.stake, profit: t.profit, failReturn: t.failReturn,
          chance: t.baseChance, maxChance: t.maxChance, bestChance: t.bestChance, duration: t.duration,
          minMembers: t.minMembers, energy: t.energy, nerve: t.nerve, kitCost: t.kitCost,
        }));
      }
      if (Array.isArray(raw.crewJobTiers)) {
        out.crewJobTiers = raw.crewJobTiers.map((t) => ({
          name: t.name, tier: t.tier, nerve: t.nerve, cut: t.cut, take: t.take, respect: t.respect,
          xp: t.xp, xpFail: t.xpFail, chance: t.baseChance, duration: t.duration, stake: t.stake,
          minMembers: t.minMembers, maxMembers: t.maxMembers, level: t.level, roles: Array.isArray(t.roles) ? t.roles.slice() : [],
        }));
      }
      if (raw.heistRules) out.heistXp = { success: raw.heistRules.successXp, fail: raw.heistRules.failureXp };
      // The crew jobs / heists you are actually in right now, not just the reference lists above. A player can
      // be a member of more than one at once (e.g. already running one job while a seat is reserved in a second
      // one still recruiting), so these are arrays, not a single job -- the Discord panel below lets you switch
      // between them. `minLevel` is looked up by matching this instance's own tier/name against the reference
      // list above, since the live job/heist entry itself never states its own level requirement directly.
      // Crew job: `status: "running"` plus `mine: true` is now confirmed real data (checked against 6 live
      // captures of the same in-progress job -- always exactly one match, always the same id `activeJobId`
      // already pointed at), so that is the primary signal; matching by `activeJobId` is kept as a fallback in
      // case a future capture ever shows `mine` not lining up with membership. `status: "planning"` (still
      // recruiting a crew, no end time yet) is included too so the Discord-message feature below has something
      // to work with before the job actually launches; the sidebar pill still only shows once there's an end
      // time (its own check on `endsAt`, unchanged).
      if (Array.isArray(raw.crewJobs)) {
        let mineJobs = raw.crewJobs.filter((x) => x && x.mine && (x.status === 'running' || x.status === 'planning'));
        if (!mineJobs.length && raw.activeJobId != null) {
          const byId = raw.crewJobs.find((x) => x && x.id === raw.activeJobId);
          if (byId) mineJobs = [byId];
        }
        out.myCrewJobs = mineJobs.map((mine) => {
          const name = mine.tierName || mine.name || null;
          const tierDef = (raw.crewJobTiers || []).find((t) => t && t.name === name) || (raw.crewJobTiers || []).find((t) => t && t.tier === mine.tier);
          return {
            id: mine.id, name, tier: mine.tier, minLevel: tierDef ? tierDef.level : null, status: mine.status, endsAt: mine.ends_at || null,
            roles: Array.isArray(mine.roles) ? mine.roles.slice() : [],
            members: (mine.members || []).map((m) => ({ role: m.role, name: m.name, level: m.level, ready: !!m.ready })),
            minMembers: mine.minMembers, maxMembers: mine.maxMembers,
            cut: mine.cut, take: mine.take, respect: mine.respectReward, nerve: mine.nerve, stake: mine.stake,
            chance: mine.chance != null ? mine.chance : mine.previewChance,
          };
        });
        // The soonest-ending running job drives the sidebar pill (unchanged behaviour from when there was only
        // ever one job to consider); a job still only planning has no end time to show there yet.
        const withEnd = out.myCrewJobs.filter((j) => j.endsAt).sort((a, b) => a.endsAt - b.endsAt);
        if (withEnd.length) out.activeCrewJob = { name: withEnd[0].name, endsAt: withEnd[0].endsAt };
      }
      // Role -> {title, stat}, the game's own data (crewJobRoles) -- which stat a seat actually uses, not a guess.
      if (raw.crewJobRoles && typeof raw.crewJobRoles === 'object') {
        out.crewJobRoles = {};
        Object.entries(raw.crewJobRoles).forEach(([k, v]) => { if (v) out.crewJobRoles[k] = { title: v.title || k, stat: v.stat || null }; });
      }
      // Heist: `status: "running"` is now confirmed real data too (seen directly in a live capture, correcting
      // an earlier note here that said it never had been) -- matched against this account's own id, since
      // heists carry no `mine` flag the way crew jobs do. The exact word used while a heist is still recruiting
      // (as opposed to running/completed/cancelled, the three confirmed so far) has never actually been seen,
      // so "anything not finished yet" is matched rather than hardcoding "running" alone -- the same
      // not-yet-decided spirit as crew jobs' own "running" + "planning". `activeHeistId` is kept as a fallback
      // for the one case that can't rely on membership matching at all: a brand new heist with no members yet.
      const myId = raw.player && raw.player.id;
      if (Array.isArray(raw.heists)) {
        let mineHeists = raw.heists.filter((h) => h && h.status !== 'completed' && h.status !== 'cancelled' &&
          Array.isArray(h.members) && h.members.some((m) => m && m.user_id === myId));
        if (!mineHeists.length && raw.activeHeistId != null) {
          const byId = raw.heists.find((x) => x && x.id === raw.activeHeistId);
          if (byId) mineHeists = [byId];
        }
        out.myHeists = mineHeists.map((h) => ({
          id: h.id, name: h.targetName || h.name || null, tier: h.tier, minLevel: heistMinLevelByTier[h.tier] != null ? heistMinLevelByTier[h.tier] : null,
          status: h.status, endsAt: h.ends_at || null, chance: h.chance, stake: h.stake, profit: h.profit, failReturn: h.failReturn,
          minMembers: h.minMembers, maxMembers: h.maxMembers, energy: h.energy, nerve: h.nerve,
          members: (h.members || []).map((m) => ({ role: m.role, name: m.name })),
        }));
        const withEnd = out.myHeists.filter((h) => h.endsAt).sort((a, b) => a.endsAt - b.endsAt);
        if (withEnd.length) out.activeHeist = { name: withEnd[0].name, endsAt: withEnd[0].endsAt };
      }
      if (raw.companion && typeof raw.companion === 'object') {
        const co = raw.companion;
        out.companion = {
          name: co.nick || co.name || null, mealAt: co.mealAt || 0, deadlineAt: co.deadlineAt || 0,
          playAt: co.playAt || 0, groomAt: co.groomAt || 0, errandUntil: co.errandUntil || 0,
          out: !!co.out, hungry: !!co.hungry, overdue: !!co.overdue,
        };
      }
      if (raw.stocks && typeof raw.stocks === 'object') {
        out.stocks = {
          tick: raw.stocks.tick, band: raw.stocks.band,
          // companies[].id is the game's own opaque id, not the short id (nine/nip/...) used in the page's own
          // URLs and everywhere this script already keys stocks by; only history entries carry that short id.
          perkSettle: raw.stocks.perkSettle,
          companies: (raw.stocks.companies || []).map((c) => ({
            name: c.name, price: c.price, nextTick: c.next_tick || c.nextTick || null,
            perkOn: !!c.perkOn, perkStartsAt: c.perkStartsAt || null,
          })),
          history: (raw.stocks.history || []).map((h) => ({ id: h.company, price: h.price, at: h.at })),
        };
      }
      (raw.events || []).forEach((e) => {
        if (e && e.body && e.kind) out.events.push({ body: e.body, kind: e.kind, at: e.created_at });
      });
      if (Array.isArray(raw.courses)) {
        let eduCrimePoints = 0; let coursesTaken = 0; let eduLandsAt = null;
        raw.courses.forEach((c) => {
          if (!c) return;
          if (c.status === 'completed') {
            coursesTaken++;
            // The exact wording the DOM reader already looks for, taken from the course's own real text instead
            // of guessing at page text -- so it stays a general crime-success bonus, not a crime-specific one.
            const m = String(c.perk || '').match(/\+(\d+)\s*points?\s+to\s+every\s+crime.s\s+success\s+chance/i);
            if (m) eduCrimePoints += +m[1];
          } else if (Number.isFinite(c.ends_at)) {
            if (eduLandsAt == null || c.ends_at < eduLandsAt) eduLandsAt = c.ends_at;
          }
        });
        out.education = { eduCrimePoints, coursesTaken, eduLandsAt };
      }
      // Whiskers & Co.'s own buy price and sell-back price for every item, keyed by the game's own item id (the
      // same id that a trading listing's `item` field uses -- confirmed by matching real listings in the user's
      // own data to store items by name: "tuna"/"bandages"/"vetpass" listings line up with Premium tuna/
      // Bandages/Vet discharge note at exactly their store prices; `inventory`'s own item ids confirm the rest,
      // e.g. "jacket"/"baton"/"catnip"/"collar"). Gear (weapons/armor) is added the same way.
      // `sellPrice` (what Whiskers & Co. pays you for it) has only ever been seen on crime-drop collectibles
      // ("Lucky fish bone", "Dockside pearl") -- never on anything with a `price` (buyable tools, consumables,
      // gear), which suggests Whiskers & Co. only buys back loot, not things it also sells you. Left as
      // whatever the game's own data says either way, not assumed.
      out.storeItems = {};
      (raw.items || []).forEach((it) => { if (it && it.id != null) out.storeItems[it.id] = { name: it.name, price: it.price, sellPrice: it.sellPrice }; });
      (raw.gear || []).forEach((g) => { if (g && g.id != null && out.storeItems[g.id] == null) out.storeItems[g.id] = { name: g.name, price: g.price, sellPrice: g.sellPrice }; });
      // Open marketplace listings only -- what you could actually buy right now. `seller` is the same public
      // display name the Trading page itself already shows next to the listing, not private data.
      if (Array.isArray(raw.listings)) {
        out.listings = raw.listings
          .filter((l) => l && l.status === 'open' && l.item && Number.isFinite(l.price))
          .map((l) => ({ item: l.item, quantity: l.quantity, price: l.price, seller: l.seller || null }));
      }
      return out;
    } catch (e) { return null; }
  }

  function onApiStateResponse(json) {
    const ex = extractApiState(json);
    if (ex) { apiState = ex; schedule(); } // nothing in the DOM changed, so redraw by hand to pick up the new numbers
  }

  function installApiWatch() {
    const isStateUrl = (url) => { try { return new URL(url, location.href).pathname === '/api/state'; } catch (e) { return false; } };
    const realFetch = pageWin.fetch;
    if (typeof realFetch === 'function') {
      pageWin.fetch = function (...args) {
        const p = realFetch.apply(this, args);
        p.then((res) => {
          try { if (res && res.url && isStateUrl(res.url)) res.clone().json().then(onApiStateResponse).catch(() => {}); } catch (e) { /* ignore */ }
        }).catch(() => {});
        return p;
      };
    }
    const RealXHR = pageWin.XMLHttpRequest;
    if (RealXHR) {
      const openOrig = RealXHR.prototype.open;
      RealXHR.prototype.open = function (method, url, ...rest) { this.__msxUrl = url; return openOrig.call(this, method, url, ...rest); };
      const sendOrig = RealXHR.prototype.send;
      RealXHR.prototype.send = function (...args) {
        this.addEventListener('loadend', () => {
          try { if (this.__msxUrl && isStateUrl(this.__msxUrl) && this.responseText) onApiStateResponse(JSON.parse(this.responseText)); } catch (e) { /* ignore */ }
        });
        return sendOrig.apply(this, args);
      };
    }
  }
  installApiWatch();


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
    const domSuccess = successM ? parseFloat(successM[1]) / 100 : null;
    const api = apiState && apiState.crimes[norm(name)] || null;
    const success = api ? api.chance / 100 : domSuccess;

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
      masteryLevel, masteryMax, progressCur, progressNeed, unlocked, card, api,
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
      .msx-stock .msx-moves, .msx-stock .msx-range, .msx-stock .msx-perk-status { flex-basis:100%; }
      .msx-stock .msx-perk-status b { color:var(--ms-lime, #b4df87); }
      .msx-stock .msx-moves b { font-weight:700; color:var(--ms-bone, #e7ede1); }
      .msx-stock .msx-moves b.up { color:var(--ms-lime, #b4df87); }
      .msx-stock .msx-moves b.down { color:var(--ms-red, #eb6561); }
      .msx-stock .msx-moves i { font-style:normal; opacity:.7; }
      #msx-invest, #msx-heists, #msx-crewjobs, #msx-mycrewjob, #msx-myheist, #msx-trading { margin:18px 0; padding:12px 16px; border-radius:12px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); color:var(--ms-bone, #e7ede1); font-size:13px; }
      #msx-invest summary { cursor:pointer; font-size:16px; font-weight:700; }
      #msx-heists h2, #msx-crewjobs h2, #msx-mycrewjob h2, #msx-myheist h2, #msx-trading h2 { margin:0; font-size:16px; font-weight:700; }
      #msx-invest h4 { margin:14px 0 6px; font-size:13px; color:var(--ms-lime-light, #d3f0b4); }
      #msx-invest .msx-inv-note, #msx-heists .msx-inv-note, #msx-crewjobs .msx-inv-note, #msx-mycrewjob .msx-inv-note, #msx-myheist .msx-inv-note, #msx-trading .msx-inv-note { margin:8px 0; color:var(--ms-smoke, #8d9289); }
      #msx-mycrewjob .msx-mycrewjob-seats { margin:8px 0; display:flex; flex-direction:column; gap:2px; }
      #msx-mycrewjob .msx-mycrewjob-seats .open { color:var(--ms-gold, #e9c46a); }
      #msx-mycrewjob .msx-jobtabs, #msx-myheist .msx-jobtabs { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
      #msx-mycrewjob .msx-jobtab, #msx-myheist .msx-jobtab { padding:4px 10px; border-radius:999px; cursor:pointer; font-size:12.5px;
        color:var(--ms-smoke, #8d9289); background:rgba(0,0,0,.2); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      #msx-mycrewjob .msx-jobtab.active, #msx-myheist .msx-jobtab.active { color:var(--ms-bone, #e7ede1); border-color:var(--ms-lime, #b4df87); background:rgba(180,223,135,.12); }
      #msx-mycrewjob .msx-jobtab:hover, #msx-myheist .msx-jobtab:hover { border-color:var(--ms-lime, #b4df87); }
      #msx-mycrewjob textarea, #msx-myheist textarea { width:100%; min-height:160px; margin:10px 0; padding:10px 12px; border-radius:8px; resize:vertical;
        color:var(--ms-bone, #e7ede1); background:rgba(0,0,0,.35); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3));
        font-family:inherit; font-size:12.5px; line-height:1.5; white-space:pre-wrap; }
      #msx-mycrewjob button, #msx-myheist button { padding:6px 12px; border-radius:8px; cursor:pointer; color:var(--ms-bone, #e7ede1); font-size:13px;
        background:var(--ms-asphalt, #1c201c); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      #msx-mycrewjob button:hover, #msx-myheist button:hover { border-color:var(--ms-lime, #b4df87); }
      #msx-invest .msx-inv-warn { margin:8px 0; color:var(--ms-gold, #e9c46a); }
      #msx-invest .msx-inv-warn ul { margin:4px 0 0; padding-left:20px; }
      #msx-invest .msx-inv-grid { display:flex; flex-wrap:wrap; gap:10px; margin:8px 0; }
      #msx-invest .msx-inv-party { flex:1 1 200px; display:flex; flex-direction:column; gap:4px; padding:10px 12px; border-radius:10px;
        border:1px solid; background:rgba(0,0,0,.2); }
      #msx-invest .msx-inv-party label { display:flex; flex-direction:column; gap:2px; width:auto; margin:0; padding:0; font-size:12px; color:var(--ms-smoke, #8d9289); }
      #msx-invest .msx-inv-pct { font-size:15px; font-weight:700; }
      #msx-invest .msx-inv-total { display:flex; flex-wrap:wrap; gap:6px 18px; margin:8px 0; }
      #msx-invest .up { color:var(--ms-lime, #b4df87); }
      #msx-invest .down { color:var(--ms-red, #eb6561); }
      #msx-invest small { color:var(--ms-smoke, #8d9289); }
      #msx-invest input[type=text], #msx-invest select { width:auto; min-width:0; max-width:100%; padding:5px 8px; border-radius:8px; color:inherit;
        background:rgba(0,0,0,.35); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); font-size:13px; }
      #msx-invest .msx-inv-hold { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
      #msx-invest .msx-inv-hold input { width:110px; }
      #msx-invest .msx-inv-add { display:flex; flex-wrap:wrap; gap:6px; }
      #msx-invest .msx-inv-add input { width:110px; }
      #msx-invest .msx-inv-buttons { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 2px; }
      #msx-invest button { padding:5px 12px; border-radius:8px; cursor:pointer; color:var(--ms-bone, #e7ede1); font-size:13px;
        background:var(--ms-asphalt, #1c201c); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      #msx-invest button:hover { border-color:var(--ms-lime, #b4df87); }
      #msx-invest .msx-inv-go { border-color:var(--ms-lime, #b4df87); }
      #msx-invest .msx-inv-table, #msx-heists .msx-inv-table, #msx-crewjobs .msx-inv-table, #msx-trading .msx-inv-table { border-collapse:collapse; margin:10px 0; display:block; overflow-x:auto; }
      #msx-invest .msx-inv-table th, #msx-invest .msx-inv-table td,
      #msx-heists .msx-inv-table th, #msx-heists .msx-inv-table td,
      #msx-crewjobs .msx-inv-table th, #msx-crewjobs .msx-inv-table td,
      #msx-trading .msx-inv-table th, #msx-trading .msx-inv-table td { padding:3px 12px 3px 0; text-align:left; white-space:nowrap; }
      #msx-heists small, #msx-crewjobs small, #msx-trading small { color:var(--ms-smoke, #8d9289); }
      #msx-trading .msx-unk { color:var(--ms-smoke, #8d9289); font-style:italic; }
      .msx-consumable { flex-wrap:wrap; row-gap:4px; }
      .msx-consumable .msx-item { display:inline-flex; align-items:center; gap:4px; }
      .msx-consumable .msx-item:not(:last-child) { margin-right:14px; }
      .msx-item-icon { width:30px; height:30px; flex:none; }
      #msx-invest .msx-inv-chart { width:100%; max-width:480px; height:auto; color:var(--ms-bone, #e7ede1); }
      #msx-invest .msx-inv-legend { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:12px; }
      #msx-invest .msx-inv-legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; }
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
      #msx-account { margin:18px 0; padding:16px 18px; border-radius:12px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); color:var(--ms-bone, #e7ede1); font-size:13px; line-height:1.5; }
      #msx-account h2 { margin:0 0 2px; font-size:17px; }
      #msx-account h3 { margin:16px 0 6px; font-size:13px; color:var(--ms-lime-light, #d3f0b4); }
      #msx-account p { margin:4px 0; }
      #msx-account .msx-acc-sub { color:var(--ms-smoke, #8d9289); }
      #msx-account .msx-acc-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:10px 0 4px; }
      #msx-account input[type=text] { min-width:200px; padding:6px 10px; border-radius:8px; color:inherit; background:rgba(0,0,0,.35);
        border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      #msx-account button { padding:6px 12px; border-radius:8px; cursor:pointer; color:var(--ms-bone, #e7ede1);
        background:var(--ms-asphalt, #1c201c); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      #msx-account button:hover:not(:disabled) { border-color:var(--ms-lime, #b4df87); }
      #msx-account button:disabled { opacity:.45; cursor:not-allowed; }
      #msx-account [hidden] { display:none; }
      #msx-account .msx-acc-buttons { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; }
      #msx-account .msx-acc-check { display:flex; flex-direction:row; justify-content:flex-start; gap:10px; align-items:flex-start;
        width:auto; max-width:100%; margin:6px 0; padding:0; text-align:left; cursor:pointer; }
      #msx-account .msx-acc-check input[type=checkbox] { flex:0 0 auto; width:16px; height:16px; min-width:0; margin:2px 0 0; padding:0;
        appearance:auto; -webkit-appearance:checkbox; accent-color:var(--ms-lime, #b4df87); }
      #msx-account .msx-acc-status { font-weight:600; }
      #msx-account .msx-acc-status.ok { color:var(--ms-lime, #b4df87); }
      #msx-account .msx-acc-status.warn { color:var(--ms-gold, #e9c46a); }
      #msx-account .msx-acc-status.note { color:var(--ms-smoke, #8d9289); font-weight:400; }
      .msx-ticker { display:flex; align-items:center; gap:6px; margin:0 0 8px; padding:5px 10px; border-radius:8px;
        background:rgba(0,0,0,.28); border:1px solid var(--ms-line, rgba(231,237,225,.15));
        color:var(--ms-bone, #e7ede1); font-size:12px; font-variant-numeric:tabular-nums; }
      .msx-ticker .ms-icon { color:var(--ms-lime, #b4df87); flex:none; }
      .msx-ticker.soon { border-color:var(--ms-gold, #e9c46a); }
      .msx-ticker.soon .ms-icon { color:var(--ms-gold, #e9c46a); }
      .msx-ticker.stale { border-color:var(--ms-red, #eb6561); color:var(--ms-red, #eb6561); }
      .msx-ticker.stale .ms-icon { color:var(--ms-red, #eb6561); }
      .msx-crewjob-inline { margin-left:2px; padding-left:8px; border-left:1px dashed var(--ms-line-strong, rgba(231,237,225,.3)); }
      .msx-crewjob-inline.soon { color:var(--ms-gold, #e9c46a); }
      #msx-tools { position:fixed; right:0; top:50%; transform:translateY(-50%); z-index:9999; display:flex; flex-direction:row; align-items:center; }
      #msx-tools .msx-tools-body { display:none; flex-direction:column; gap:6px; padding:8px; border-radius:10px 0 0 10px;
        background:var(--ms-asphalt, #1c201c); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); border-right:0; }
      #msx-tools.open .msx-tools-body { display:flex; }
      #msx-tools button { padding:6px 10px; border-radius:8px; border:1px solid var(--ms-line-strong, rgba(231,237,225,.3));
        background:var(--ms-asphalt, #1c201c); color:var(--ms-bone, #e7ede1); font-size:12px; cursor:pointer; opacity:.75; white-space:nowrap; }
      #msx-tools button:hover { opacity:1; }
      #msx-tools .msx-tools-toggle { width:22px; padding:10px 0; border-radius:8px 0 0 8px; border-right:0; font-size:11px; line-height:1;
        writing-mode:vertical-rl; letter-spacing:.05em; }
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
    const body = document.createElement('div');
    body.className = 'msx-tools-body';
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'msx-tools-toggle'; toggle.textContent = 'MSX'; toggle.title = 'Show or hide the MeowStreets Extra Info tools';
    toggle.addEventListener('click', () => box.classList.toggle('open'));
    box.appendChild(body); box.appendChild(toggle);
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      b.addEventListener('click', fn);
      body.appendChild(b);
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

  function oddsHtmlFromApi(c) {
    const a = c.api;
    const heatPts = Math.floor((a.heat || 0) / 4);
    const fmt = (v) => (v < 0 ? '−' : '+') + Math.abs(v);
    const bits = [`${a.baseChance} base`];
    if (a.masteryBonus) bits.push(`${fmt(a.masteryBonus)} mastery`);
    if (a.bonus) bits.push(`<span title="Merits, education, crew and perks, added together by the game itself">${fmt(a.bonus)} bonus</span>`);
    if (heatPts) bits.push(`${fmt(-heatPts)} heat`);
    const sum = a.baseChance + (a.masteryBonus || 0) + (a.bonus || 0) - heatPts;
    const capped = a.chance === 95 && sum > 95;
    const end = capped ? `= ${sum} → capped at 95%` : `= ${a.chance}%`;
    const crew = apiState && apiState.crew;
    const crewNote = crew && crew.buffActive && crew.buffUntil > Date.now()
      ? ` The crew +5% window ends in ${Math.max(1, Math.round((crew.buffUntil - Date.now()) / 60000))} min (${new Date(crew.buffUntil).toUTCString().slice(17, 22)} UTC).` : '';
    const critNote = a.criticalChance != null ? ` Clean-job chance: ${a.criticalChance}%.` : '';
    const title = ('Exact numbers from the game\'s own data: base success + mastery bonus + bonus (merits, education, crew and perks, already combined by the game) − 1 per 4 heat, capped at 95%.' + crewNote + critNote).replace(/"/g, '&quot;');
    return `<div class="msx-odds" title="${title}">Odds (exact): ${bits.join(' ')} ${end}</div>`;
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
      const oddsBlock = c.api ? oddsHtmlFromApi(c) : oddsHtml(c, data.heat[c.district], loadDb().mods || {});
      box.innerHTML = (parts.join('') || '<small>No data yet</small>') + oddsBlock + dropsHtml(c);
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
  const NEXT_MOVE_KEY = 'ms_next_stock_move';
  let nextMoveAnchor = Number(GM_getValue(NEXT_MOVE_KEY, 0)) || 0;
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

  // The game's own /api/state response carries a short rolling price history (history[].id is the same short id
  // used in the page's own URLs, so it lines up directly with how stocks are already keyed here), and the exact
  // next-tick time per company. This only ever adds periods the DOM-based reader above did not already have; it
  // never overwrites a period that is already stored.
  function logStocksFromApi() {
    if (!apiState || !apiState.stocks) return;
    const db = loadDb();
    const now = new Date().toISOString();
    let changed = false;
    (apiState.stocks.history || []).forEach((h) => {
      if (!h.id || !Number.isFinite(h.price) || !Number.isFinite(h.at)) return;
      const period = Math.round(h.at / PERIOD_MS);
      const rec = db.stocks[h.id] || (db.stocks[h.id] = { name: h.id, obs: [] });
      if (rec.obs.some((o) => periodOf(o) === period)) return;
      rec.obs.push({ t: now, p: period, price: h.price, delta: 0, src: 'api' });
      rec.obs.sort((a, b) => (periodOf(a) ?? 0) - (periodOf(b) ?? 0));
      if (rec.obs.length > MAX_STOCK_TICKS) rec.obs.shift();
      changed = true;
    });
    // The next-tick time is exact here, but companies[] only gives the game's own opaque id, not the short id
    // used everywhere else -- match it to a known stock by name instead (name is stable and already recorded).
    (apiState.stocks.companies || []).forEach((c) => {
      if (!c.name || !c.nextTick) return;
      const known = Object.values(db.stocks).find((rec) => rec.name && norm(rec.name) === norm(c.name));
      if (known && Number.isFinite(c.nextTick) && Math.abs(c.nextTick - nextMoveAnchor) > 2000) {
        nextMoveAnchor = c.nextTick;
        try { GM_setValue(NEXT_MOVE_KEY, c.nextTick); } catch (e) { /* ignore */ }
      }
    });
    if (changed) { db.updated = now; saveDb(db); }
  }

  // ─── Settings (kept on this computer, edited on the Account page) ─────────
  const SETTINGS_KEY = 'ms_settings_v1';
  const DEFAULT_SETTINGS = { capture: true, events: true };
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(GM_getValue(SETTINGS_KEY, 'null'));
    if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) { /* use the defaults */ }
  function saveSettings() {
    try { GM_setValue(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function stockStats(id, currentPrice) {
    const obs = (loadDb().stocks[id]?.obs) || [];
    // One price per price-period: keep the latest reading in each period.
    const bySlot = new Map();
    obs.forEach((o) => { const k = periodOf(o); if (k != null) bySlot.set(k, o.price); });
    const entries = [...bySlot.entries()].sort((a, b) => a[0] - b[0]);
    const prices = entries.map((e) => e[1]);
    // Each move between two neighbouring 15-minute periods: +1 up, -1 down, 0 unchanged. A gap (a period the script
    // never saw) is skipped, because the price change across a gap is more than one move.
    const moves = [];
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][0] - entries[i - 1][0] === 1) moves.push(Math.sign(prices[i] - prices[i - 1]));
    }
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
    return { prices, n, min, max, avg, pct, pos, trend, verdict, moves, mw: windowsOf(moves) };
  }

  const ordinal = (n) => { const r = n % 100; const sfx = r >= 11 && r <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'); return n + sfx; };
  const VERDICT_LABEL = { low: 'Looks LOW', high: 'Looks HIGH', mid: 'Mid-range', flat: 'Flat so far', learn: 'Learning' };

  const MOVE_WINDOWS = [10, 25, 50];
  function windowsOf(moves) {
    const out = {};
    MOVE_WINDOWS.forEach((w) => {
      const last = moves.slice(-w);
      const up = last.filter((m) => m > 0).length, down = last.filter((m) => m < 0).length;
      out[w] = { up, down, flat: last.length - up - down, seen: last.length };
    });
    return out;
  }
  function movesHtml(windows) {
    return MOVE_WINDOWS.map((w) => {
      const c = windows[w];
      if (!c.seen) return `Last ${w}: no moves yet`;
      const seen = c.seen < w ? ` <i>(${c.seen} seen)</i>` : '';
      return `Last ${w}: <b class="up">${c.up}↑</b> <b class="down">${c.down}↓</b> <b>${c.flat}=</b>${seen}`;
    }).join(' · ');
  }

  // Perk on/off timing: only known from the game's own data (there is nothing like it on the page itself).
  // Matched to a stock purely by name, the same way the next-tick time is.
  function perkTimingHtml(name) {
    const c = apiState && apiState.stocks && apiState.stocks.companies.find((x) => norm(x.name) === norm(name));
    if (!c) return '';
    const settle = apiState.stocks.perkSettle;
    if (c.perkOn) return '<small class="msx-perk-status" title="This stock\'s perk is switched on right now.">Perk: <b>on</b></small>';
    if (c.perkStartsAt && settle) {
      const remain = c.perkStartsAt + settle - Date.now();
      if (remain > 0) return `<small class="msx-perk-status" title="Perks take a day to settle in once you hold enough shares.">Perk settles in ${Math.max(1, Math.round(remain / 3600000))}h</small>`;
    }
    return '';
  }

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
      const perkCost = s.perkShares ? ` · perk ≈ ${fmtMoney(s.perkShares * s.price)}` : '';
      box.innerHTML =
        `<span class="msx-tag stk ${st.verdict}" title="% of range: how far up between the lowest and highest price recorded (0% = lowest seen, 100% = highest seen). pct: the share of recorded price periods that were lower. HIGH or LOW shows when either is within 20% of an end.">${label}</span>` +
        `<span class="msx-trend" title="Average of the last 3 price moves vs the 3 before">${st.n >= 6 ? arrow : ''}</span>` +
        `<small class="msx-moves" title="How many of the last 10 and last 25 price moves went up (↑), down (↓) or stayed the same (=). Only counts moves the script saw one after another, so a gap in the record is skipped.">${movesHtml(st.mw)}</small>` +
        `<small class="msx-range" title="Lowest / highest price this script has recorded, over ${st.n} price moves (avg $${st.avg.toFixed(1)})">` +
        `Lowest seen <b>$${st.min}</b> · Highest seen <b>$${st.max}</b> · Avg $${st.avg.toFixed(0)}${perkCost}</small>` +
        perkTimingHtml(s.name);
      host.appendChild(box);
    });
  }

  // ─── Stock tick countdown (sidebar, every page) ───────────────────────────
  // The game only shows the next-move time on the Claw Street Ex page. We remember it there and,
  // because prices move every 15 minutes, project it forward on every other page.
  const TICK_PERIOD_MS = 15 * 60 * 1000;

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
      setTitle(txt.parentNode, `Time until your crew chain dies. Last synced from the Crew page ${Math.floor(ageMs / 60000)} min ago` +
        (stale ? ' (stale: open the Crew page to refresh; other crew members may have extended it)' : '.'));
      const remain = chainState.expires - Date.now();
      if (remain <= 0) {
        out = 'Crew chain: check Crew page';
      } else {
        const s = Math.ceil(remain / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        const clock = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
        out = `Crew chain${chainState.count != null ? ' ×' + chainState.count : ''} ${clock}`;
        soon = remain <= 15 * 60 * 1000;
      }
      if (remain <= 0) stale = true;
    }
    if (txt.textContent !== out) txt.textContent = out;
    txt.parentNode.classList.toggle('soon', soon && !stale);
    txt.parentNode.classList.toggle('stale', stale);
  }

  // Countdown text, "h:mm:ss" or "m:ss", shared by the pills below.
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  // A wall-clock time ("3:42 PM"), for tooltips below: unlike a countdown, it doesn't change every second, so it
  // never fights with the browser's own hover tooltip (which otherwise flickers each time the title attribute
  // it's reading is touched, even when set to the exact same text).
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Every pill below is redrawn once a second (for the live countdowns in their visible text), but a browser's
  // native tooltip flickers if the element's `title` is written to at all while it's showing, even to an
  // identical value -- so every title assignment on a per-second timer goes through here instead of `el.title =`.
  function setTitle(el, text) { if (el.title !== text) el.title = text; }

  // ─── Your crew job right now (sidebar, every page) ─────────────────────────
  // Only known once the game's own data gives it an end time -- a job still recruiting members has none yet, so
  // it stays hidden until it actually launches. Lives inside the crew chain's own box (same shield icon, same
  // pill) rather than a separate one of its own, set off from the chain text by a dashed divider.
  function updateCrewJobPill() {
    const job = apiState && apiState.activeCrewJob;
    const chainEl = document.querySelector('.msx-chain');
    let seg = chainEl ? chainEl.querySelector('.msx-crewjob-inline') : null;
    if (!job || !job.endsAt || !chainEl) { if (seg) seg.remove(); return; }
    if (!seg) {
      seg = document.createElement('span');
      seg.className = 'msx-crewjob-inline';
      chainEl.appendChild(seg);
    }
    const remain = job.endsAt - Date.now();
    const text = remain > 0 ? fmtClock(remain) : 'done';
    setTitle(seg, `${job.name || 'Crew job'}: ${remain > 0 ? `finishes at ${fmtTime(job.endsAt)}` : 'ready to collect'}`);
    seg.classList.toggle('soon', remain <= 0);
    const html = `Crew Job: ${text}`;
    if (seg.innerHTML !== html) seg.innerHTML = html;
  }

  // A plain heist-mask icon for the heist pill below -- drawn in the same flat style as the item/cat icons (not
  // the game's own art) so it needs no request either.
  const HEIST_ICON = '<svg viewBox="0 0 48 48" class="msx-item-icon" aria-hidden="true"><path d="M4 20c4-6 12-9 20-9s16 3 20 9c-3 7-10 12-20 12S7 27 4 20Z" fill="#182316"/><ellipse cx="15" cy="19" rx="5" ry="4" fill="#E7EDE1"/><ellipse cx="33" cy="19" rx="5" ry="4" fill="#E7EDE1"/><circle cx="15" cy="19" r="2" fill="#182316"/><circle cx="33" cy="19" r="2" fill="#182316"/><path d="M2 18 8 20M46 18 40 20" stroke="#182316" stroke-width="2.4" stroke-linecap="round"/></svg>';

  // ─── Your heist right now (sidebar, every page) ────────────────────────────
  // Same idea as the crew job pill: only shown once it is actually underway (has an end time), not while still
  // recruiting a clowder.
  function updateHeistPill() {
    const h = apiState && apiState.activeHeist;
    let el = document.querySelector('.msx-heist');
    if (!h || !h.endsAt) { if (el) el.remove(); return; }
    if (!el) {
      const anchor = document.querySelector('.msx-chain') || document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
      if (!anchor || !anchor.parentNode) return;
      el = document.createElement('div');
      el.className = 'msx-ticker msx-heist';
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    const remain = h.endsAt - Date.now();
    const text = remain > 0 ? fmtClock(remain) : 'done';
    setTitle(el, `${h.name || 'Heist'}: ${remain > 0 ? `results at ${fmtTime(h.endsAt)}` : 'results are in'}`);
    el.classList.toggle('soon', remain <= 0);
    const html = `${HEIST_ICON}${text}`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // A small pill that only appears while it has something to say, built and removed on the fly (unlike the
  // stock/chain pills, there is nothing on any page to fall back to while this has no data, so it simply is not
  // shown then). `compute` returns null (hide) or { text, level: 'ok' | 'warn' | 'bad' }.
  function ensureStatusPill(className, title, compute) {
    const status = compute();
    let el = document.querySelector('.' + className);
    if (!status) { if (el) el.remove(); return; }
    if (!el) {
      const anchor = document.querySelector('.msx-chain') || document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
      if (!anchor || !anchor.parentNode) return;
      el = document.createElement('div');
      el.className = 'msx-ticker ' + className;
      el.innerHTML = `<span class="${className}-text"></span>`;
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    setTitle(el, title);
    el.classList.toggle('soon', status.level === 'warn');
    el.classList.toggle('stale', status.level === 'bad');
    const txt = el.querySelector('.' + className + '-text');
    if (txt.textContent !== status.text) txt.textContent = status.text;
  }

  // ─── Companion reminders (sidebar, every page) ─────────────────────────────
  // Only ever known from the game's own data (see api-data-reference.md); there is nothing like it in the page
  // text. Shows the soonest of feeding, grooming or an errand's return, or a warning once it is overdue.

  // A plain cat-face icon for the companion pill below -- drawn in the same flat style as the item icons further
  // down (not the game's own mascot art) so it needs no request either.
  const CAT_ICON = '<svg viewBox="0 0 48 48" class="msx-item-icon" aria-hidden="true"><path d="M10 20L16 6L22 20Z" fill="#8A8F86"/><path d="M38 20L32 6L26 20Z" fill="#8A8F86"/><path d="M12 18L16 10L19 18Z" fill="#182316" opacity=".35"/><path d="M36 18L32 10L29 18Z" fill="#182316" opacity=".35"/><ellipse cx="24" cy="27" rx="16" ry="14" fill="#8A8F86"/><ellipse cx="17" cy="26" rx="2.6" ry="3.4" fill="#182316"/><ellipse cx="31" cy="26" rx="2.6" ry="3.4" fill="#182316"/><path d="M24 31l-2.4 2.4h4.8Z" fill="#D9534F"/><path d="M24 33.4v2M24 35.4q-3 2-6 1.4M24 35.4q3 2 6 1.4" fill="none" stroke="#182316" stroke-width="1" stroke-linecap="round"/><path d="M6 24h8M6 29h7M34 24h8M35 29h7" stroke="#E7EDE1" stroke-width="1.1" stroke-linecap="round"/></svg>';

  function updateCompanionPill() {
    const co = apiState && apiState.companion;
    let el = document.querySelector('.msx-companion');
    if (!co) { if (el) el.remove(); return; }
    const now = Date.now();
    const name = co.name || 'Companion';
    let text, level, detail;
    if (co.overdue) { text = 'overdue'; level = 'bad'; detail = `${name}: care overdue`; }
    else if (co.out && co.errandUntil > now) { text = `out ${fmtClock(co.errandUntil - now)}`; level = 'ok'; detail = `${name}: out, back at ${fmtTime(co.errandUntil)}`; }
    else if (co.hungry) { text = 'hungry'; level = 'warn'; detail = `${name}: hungry now`; }
    else {
      // mealAt/groomAt are two different, unrelated timers -- always say which one this is, so the pill never
      // shows a bare number that looks identical to the errand countdown above once the errand has ended.
      const candidates = [{ at: co.mealAt, label: 'meal' }, { at: co.groomAt, label: 'groom' }].filter((c) => c.at > now);
      candidates.sort((a, b) => a.at - b.at);
      const next = candidates[0];
      if (!next) { text = 'due'; level = 'warn'; detail = `${name}: due now`; }
      else {
        const soon = next.at - now <= 15 * 60 * 1000;
        text = `${next.label} ${fmtClock(next.at - now)}`; level = soon ? 'warn' : 'ok';
        detail = `${name}: next ${next.label} at ${fmtTime(next.at)}`;
      }
    }
    if (!el) {
      const anchor = document.querySelector('.msx-chain') || document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
      if (!anchor || !anchor.parentNode) return;
      el = document.createElement('div');
      el.className = 'msx-ticker msx-companion';
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    setTitle(el, detail);
    el.classList.toggle('soon', level === 'warn');
    el.classList.toggle('stale', level === 'bad');
    const html = `${CAT_ICON}${text}`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ─── PvP status (sidebar, every page) ──────────────────────────────────────
  // Mug protection and a bounty on you, both only known from the game's own data. Hidden while neither applies.
  function updatePvpPill() {
    ensureStatusPill('msx-pvp', 'Mug protection and any bounty on you, from the game’s own data', () => {
      if (!apiState) return null;
      const now = Date.now();
      const bits = [];
      if (apiState.protectedUntil > now) bits.push(`Protected ${fmtClock(apiState.protectedUntil - now)}`);
      if (apiState.bountyOnMe > 0) bits.push(`Bounty on you: ${fmtMoney(apiState.bountyOnMe)}`);
      if (!bits.length) return null;
      return { text: bits.join(' · '), level: apiState.bountyOnMe > 0 ? 'warn' : 'ok' };
    });
  }

  // ─── Can I use a Premium tuna / Catnip tea right now? (sidebar, every page) ─
  // Every consumable shares a cooldown with the rest of its own family. Only these two families are confirmed
  // from real data so far; add more here once another item's family key has been seen the same way. Icons are
  // the game's own item art (from a screenshot of the page's own DOM, image src "/brand/items/<name>.svg"),
  // copied in once rather than fetched -- that keeps this script's "no requests at all" claim exactly true,
  // instead of adding a new kind of request just to show a picture.
  const ITEM_ICONS = {
    tuna: '<svg viewBox="0 0 48 48" class="msx-item-icon" aria-hidden="true"><ellipse cx="29" cy="11" rx="12" ry="4.2" transform="rotate(-22 29 11)" fill="#8A8F86"/><rect x="10" y="18" width="28" height="20" rx="2" fill="#8A8F86"/><rect x="10" y="26" width="28" height="6" fill="#D9534F"/><path d="M14 29h20" stroke="#E7EDE1" stroke-width="1.4" stroke-linecap="round"/><ellipse cx="24" cy="18" rx="14" ry="4.6" fill="#E7EDE1"/><path d="M15 17.5l4 1M22 16l3 1.5M29 18l4-1M18 20l3-.5" stroke="#8A8F86" stroke-width="1.1" stroke-linecap="round"/><ellipse cx="24" cy="18" rx="14" ry="4.6" fill="none" stroke="#8A8F86" stroke-width="1.4"/><rect x="33" y="5" width="5" height="2.4" rx="1.2" transform="rotate(-22 35.5 6.2)" fill="#E7EDE1"/></svg>',
    catnip: '<svg viewBox="0 0 48 48" class="msx-item-icon" aria-hidden="true"><ellipse cx="23" cy="39" rx="17" ry="4.2" fill="#E7EDE1"/><ellipse cx="23" cy="38.4" rx="9" ry="2" fill="#8A8F86" opacity=".5"/><path d="M12 20h22v9c0 5-4 8-9 8h-4c-5 0-9-3-9-8Z" fill="#5B605A"/><path d="M34 23c6 0 7 3 6 6s-4 4-7 4" fill="none" stroke="#5B605A" stroke-width="3.2" stroke-linecap="round"/><ellipse cx="23" cy="20" rx="11" ry="3.2" fill="#182316"/><ellipse cx="23" cy="20" rx="6.5" ry="1.6" fill="#E9C46A" opacity=".65"/><path d="M19 14c-2-3 2-4 0-8M26 14c-2-3 2-4 0-8" fill="none" stroke="#8A8F86" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };
  const CONSUMABLE_FAMILIES = [
    { label: 'Premium tuna', family: 'tuna', resource: 'energy' },
    { label: 'Catnip tea', family: 'catnip', resource: 'nerve' },
  ];
  function updateConsumablesPill() {
    if (!apiState) { document.querySelector('.msx-consumable')?.remove(); return; }
    const now = Date.now();
    let anyCapped = false;
    const bits = CONSUMABLE_FAMILIES.map((f) => {
      const expires = apiState.cooldowns[f.family];
      const capped = apiState.usedUp.includes(f.family);
      const full = apiState.caps && apiState.caps[f.resource] != null && apiState[f.resource] >= apiState.caps[f.resource];
      let text;
      if (capped) { anyCapped = true; text = 'capped'; }
      else if (expires && expires > now) text = fmtClock(expires - now);
      else text = full ? `${f.resource} full` : 'ready';
      return `<span class="msx-item" title="${f.label}">${ITEM_ICONS[f.family] || ''}${text}</span>`;
    });
    let el = document.querySelector('.msx-consumable');
    if (!el) {
      const anchor = document.querySelector('.msx-chain') || document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
      if (!anchor || !anchor.parentNode) return;
      el = document.createElement('div');
      el.className = 'msx-ticker msx-consumable';
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    setTitle(el, 'Whether Premium tuna and Catnip tea are off cooldown, from the game’s own data');
    el.classList.toggle('soon', anyCapped);
    const html = bits.join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  setInterval(() => { updateTicker(); updateChainPill(); updateCrewJobPill(); updateHeistPill(); updateCompanionPill(); updatePvpPill(); updateConsumablesPill(); }, 1000);

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
    clone.querySelectorAll('.msx-info, .msx-stock, .msx-heat, .msx-ticker, #msx-invest, #msx-heists, #msx-crewjobs, #msx-mycrewjob, #msx-myheist, #msx-trading, script, style').forEach((n) => n.remove());
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

    // The game's own /api/state response, when seen: the real merit ranks (the Merits page redesign stopped
    // showing them as readable text) and the real crew +5% window, no card-math guessing needed.
    if (apiState && apiState.at !== mods.apiAt) {
      if (Object.keys(apiState.meritLines).length) {
        mods.merits = {};
        Object.entries(apiState.meritLines).forEach(([lineName, l]) => { mods.merits[lineName] = l.ranks; });
        found = true; touch('merits');
      }
      if (apiState.crew) {
        const pct = mods.crewPctSeen || 5;
        mods.crewBonus = { pct, until: apiState.crew.buffActive ? apiState.crew.buffUntil : 0 };
        if (apiState.crew.buffActive) mods.crewPctSeen = pct;
        found = true; touch('crew');
      }
      if (apiState.education) {
        mods.eduCrimePoints = apiState.education.eduCrimePoints;
        mods.coursesTaken = apiState.education.coursesTaken;
        mods.eduLandsAt = apiState.education.eduLandsAt;
        found = true; touch('education');
      }
      mods.apiAt = apiState.at;
    }

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
    if (!settings.capture) return;
    if (currentPath() !== path) return; // you have moved on
    const main = document.querySelector('.main-content') || document.querySelector('main');
    if (!main) return;
    lastCaptureAt = Date.now();
    lastCaptureLen = main.textContent.length;
    scanPage(false, true).catch(() => {});
  }

  function noteView() {
    if (!settings.capture) return; // switched off on the Account page
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
    // A specific gym move ("You put 48 clean hooks into the heavy bag. +9.81 strength, -60 energy, -30 happiness.")
    // instead of the generic "Trained STAT at GYM." wording; same numbers, so keep it in the same 'train' kind.
    if ((m = text.match(/^(.+?)\.\s*\+([\d.]+)\s*(\w+),\s*.(\d+)\s*energy,\s*.(\d+)\s*happiness/i))) {
      return { kind: 'train', stat: m[3].toLowerCase(), desc: m[1], gain: +m[2], energy: +m[4], happinessCost: +m[5] };
    }
    if ((m = text.match(/^Award unlocked: (.+?)\./i))) return { kind: 'award', award: m[1] };
    if ((m = text.match(/^(?:Deposited|Withdrew) \$([\d,]+)/i))) return { kind: 'bank', amount: moneyOf(m[1]), direction: /^Deposited/i.test(text) ? 'in' : 'out' };
    // The bigger crew heists ("the cold store", "Oceans 11") say "launched with N% success chance"; the plain crew
    // heists (Fish market skim) say "launched with N% chance". Both count as a launch.
    if ((m = text.match(/^(.+?) launched with (\d+)%(?: success)? chance/i))) return { kind: 'heist', sub: 'launched', job: m[1], chancePct: +m[2] };
    if ((m = text.match(/^Moved into (.+?) for \$([\d,]+)\. Happiness cap is now (\d+)/i))) return { kind: 'home', home: m[1], cost: moneyOf(m[2]), happinessCap: +m[3] };

    // ── PvP: fights, muggings, bounties, jail ──
    if ((m = text.match(/^(.+?) won a fight against you and is deciding what to do\.?/i))) return { kind: 'pvp', sub: 'lost_pending', who: m[1] };
    if ((m = text.match(/^(.+?) left you at the vet\.?/i))) return { kind: 'pvp', sub: 'lost_vet', who: m[1] };
    if ((m = text.match(/^(.+?) beat you but chose to walk away\.?/i))) return { kind: 'pvp', sub: 'lost_spared', who: m[1] };
    if ((m = text.match(/^(.+?) fought you off \((\d+)% odds\)\.?/i))) return { kind: 'pvp', sub: 'mug_failed', who: m[1], oddsPct: +m[2] };
    if ((m = text.match(/^You mugged (.+?) for \$([\d,]+) and collected \$([\d,]+) in bounties \((\d+)% odds\)\.(?: \+(\d+) XP\.)?/i))) {
      return { kind: 'pvp', sub: 'mugged_bounty', who: m[1], cash: moneyOf(m[2]), bounty: moneyOf(m[3]), oddsPct: +m[4], xp: m[5] ? +m[5] : 0 };
    }
    if ((m = text.match(/^You mugged (.+?) for \$([\d,]+)\.?$/i))) return { kind: 'pvp', sub: 'mugged', who: m[1], cash: moneyOf(m[2]) };
    if ((m = text.match(/^(.+?) mugged you for \$([\d,]+)\.?/i))) return { kind: 'pvp', sub: 'was_mugged', who: m[1], cash: moneyOf(m[2]) };
    if ((m = text.match(/^You beat (.+?) in (\d+) exchanges, with (\d+) health left\.(?: \+(\d+) XP\.)?/i))) {
      return { kind: 'pvp', sub: 'won', who: m[1], exchanges: +m[2], healthLeft: +m[3], xp: m[4] ? +m[4] : 0 };
    }
    if ((m = text.match(/^(.+?) put a \$([\d,]+) bounty on you\.?/i))) return { kind: 'pvp', sub: 'bounty_on_you', who: m[1], amount: moneyOf(m[2]) };
    if ((m = text.match(/^(.+?) collected your \$([\d,]+) bounty on (.+?)\.?$/i))) return { kind: 'pvp', sub: 'bounty_collected', who: m[1], amount: moneyOf(m[2]), target: m[3] };
    if ((m = text.match(/^Posted a \$([\d,]+) bounty on (.+?)\. \$([\d,]+) fee paid\.?/i))) return { kind: 'pvp', sub: 'bounty_posted', amount: moneyOf(m[1]), target: m[2], fee: moneyOf(m[3]) };
    if ((m = text.match(/^(.+?) sprang you from the cells\.?/i))) return { kind: 'pvp', sub: 'sprung', who: m[1] };

    // ── Companion ──
    if ((m = text.match(/^(.+?) drops one (.+?) at your feet\.?/i))) return { kind: 'companion', sub: 'gift', item: m[2] };
    if ((m = text.match(/^(.+?) sits still for the brush\./i))) return { kind: 'companion', sub: 'brushed' };
    if ((m = text.match(/^(.+?) heads out\. Back in ([^;]+);/i))) return { kind: 'companion', sub: 'errand', back: m[2] };
    if ((m = text.match(/^You brushed (.+?).s cat until it shone\.(?: \+(\d+) nerve\.)?/i))) return { kind: 'companion', sub: 'brushed_other', who: m[1], nerve: m[2] ? +m[2] : 0 };

    // ── Crew: membership, treasury, crew jobs ──
    if ((m = text.match(/^(.+?) joined the crew\.?/i))) return { kind: 'crew', sub: 'joined', who: m[1] };
    if ((m = text.match(/^(.+?) paid you \$([\d,]+) from the (.+?) treasury\.?/i))) return { kind: 'crew', sub: 'treasury_paid', who: m[1], amount: moneyOf(m[2]), treasury: m[3] };
    if ((m = text.match(/^(.+?) planned \(#(\d+)\) and your seat cost (\d+) nerve\./i))) return { kind: 'crew', sub: 'job_planned', job: m[1], id: +m[2], nerve: +m[3] };
    if ((m = text.match(/^(.+?) came off: \$([\d,]+) to the treasury and (\d+) respect\.?/i))) return { kind: 'crew', sub: 'job_done', job: m[1], amount: moneyOf(m[2]), respect: +m[3] };
    if ((m = text.match(/^Joined the (.+?) as (.+?) for (\d+) nerve\./i))) return { kind: 'crew', sub: 'job_joined', job: m[1], role: m[2], nerve: +m[3] };
    if ((m = text.match(/^You are off the job\.?$/i))) return { kind: 'crew', sub: 'left_job' };

    // ── Bigger crew heists (a stake, a kit, recruiting a "clowder") ──
    if ((m = text.match(/^Created (.+?) . the cold store, tier (\d+)\. Your \$([\d,]+) stake, \$([\d,]+) for the kit, (\d+) energy and (\d+) nerve/i))) {
      return { kind: 'heist', sub: 'created', job: m[1], tier: +m[2], stake: moneyOf(m[3]), kit: moneyOf(m[4]), energy: +m[5], nerve: +m[6] };
    }
    if ((m = text.match(/^Joined the clowder on (.+?)\. Your \$([\d,]+) stake, (\d+) energy and (\d+) nerve/i))) {
      return { kind: 'heist', sub: 'joined', job: m[1], stake: moneyOf(m[2]), energy: +m[3], nerve: +m[4] };
    }
    if ((m = text.match(/^Heist underway: (\d+)% chance\. Results and payouts arrive in ([^.]+)\.?/i))) return { kind: 'heist', sub: 'underway', chancePct: +m[1], arrives: m[2] };
    if ((m = text.match(/^(.+?) succeeded\. Your share was \$([\d,]+) . your \$([\d,]+) stake plus \$([\d,]+) of the \$([\d,]+) pool . and (\d+) XP\.?/i))) {
      return { kind: 'heist', sub: 'succeeded', job: m[1], share: moneyOf(m[2]), stake: moneyOf(m[3]), poolShare: moneyOf(m[4]), pool: moneyOf(m[5]), xp: +m[6] };
    }
    if ((m = text.match(/^(.+?) failed\. \$([\d,]+) of your \$([\d,]+) stake was returned and (\d+) XP\.?/i))) {
      return { kind: 'heist', sub: 'failed', job: m[1], returned: moneyOf(m[2]), stake: moneyOf(m[3]), xp: +m[4] };
    }
    if ((m = text.match(/^(.+?): Recruitment expired\. Your \$([\d,]+) stake, (\d+) energy and (\d+) nerve were returned\.?/i))) {
      return { kind: 'heist', sub: 'expired', job: m[1], stake: moneyOf(m[2]), energy: +m[3], nerve: +m[4] };
    }
    if ((m = text.match(/^Ready for the heist\.?$/i))) return { kind: 'heist', sub: 'ready' };

    // ── Jobs (shifts and wages) ──
    if ((m = text.match(/^Started a (.+?) shift as (.+?)\. \$([\d,]+) in wages are ready at ([\d:]+) UTC\.?/i))) {
      return { kind: 'job', sub: 'started', job: m[1], role: m[2], wages: moneyOf(m[3]), readyAt: m[4] };
    }
    if ((m = text.match(/^Collected \$([\d,]+) in wages(?:, (\d+) XP| and (\d+) XP)?(?:.*?(\d+) job points?)?(?: for (\d+) hours?)?\./i))) {
      return { kind: 'job', sub: 'wages', cash: moneyOf(m[1]), xp: (m[2] || m[3]) ? +(m[2] || m[3]) : 0, jobPoints: m[4] ? +m[4] : 0, hours: m[5] ? +m[5] : null };
    }

    // ── Contracts / one-off tasks: "<name>: earned $X and Y XP." ──
    if ((m = text.match(/^(.+?): earned \$([\d,]+) and (\d+) XP\.?$/i))) return { kind: 'task', task: m[1], cash: moneyOf(m[2]), xp: +m[3] };

    // ── Trading (player exchange) ──
    if ((m = text.match(/^Listed (\d+) . (.+?) at \$([\d,]+) each\. \$([\d,]+) listing fee paid\.?/i))) {
      return { kind: 'listing', sub: 'listed', qty: +m[1], item: m[2], price: moneyOf(m[3]), fee: moneyOf(m[4]) };
    }
    if ((m = text.match(/^Listing cancelled\./i))) return { kind: 'listing', sub: 'cancelled' };
    if ((m = text.match(/^(.+?) bought your listing #(\d+)\. You received \$([\d,]+)\.?/i))) return { kind: 'listing', sub: 'sold', who: m[1], id: +m[2], cash: moneyOf(m[3]) };
    if ((m = text.match(/^Bought (\d+) . (.+?) for \$([\d,]+) plus a \$([\d,]+) exchange tax\.?/i))) {
      return { kind: 'item', sub: 'bought', qty: +m[1], item: m[2], price: moneyOf(m[3]), tax: moneyOf(m[4]) };
    }
    if ((m = text.match(/^Bought (.+?)\.?$/i))) return { kind: 'item', sub: 'bought', qty: 1, item: m[1] };

    // ── Joining a gym / other institution for a flat fee ──
    if ((m = text.match(/^Joined the (.+?) for \$([\d,]+)\. You now train there\.?/i))) return { kind: 'join', place: m[1], cost: moneyOf(m[2]) };

    return { kind: 'other' };
  }

  function readEvents() {
    if (!settings.events || currentPath() !== '/mews') return;
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

  // The game's own /api/state response carries a rolling list of Mews lines, each already tagged with the game's
  // own category name (`kind`). Unlike the DOM reading above, this is not limited to the Mews page: the game
  // fetches this response on most navigations, so it can add lines this script never had a chance to read from
  // the page, and it can tag a line this script's own wording-matching did not recognise ("other") with the real
  // category, without guessing. It never replaces the rich fields the wording-matching already pulls out.
  function readEventsFromApi() {
    if (!settings.events || !apiState || !apiState.events.length) return;
    const store = loadEvents();
    let added = 0, enriched = 0;
    apiState.events.forEach((e) => {
      if (!e.body || !Number.isFinite(e.at)) return;
      const t = new Date(e.at).toISOString();
      const text = String(e.body).replace(/\s*\[(?:view|spend)\]\s*$/i, '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 400) return;
      const key = t + '|' + text;
      if (eventKeys.has(key)) {
        const existing = store.events.find((ev) => ev.t === t && ev.text === text);
        if (existing && existing.apiKind !== e.kind) { existing.apiKind = e.kind; enriched++; }
        return;
      }
      eventKeys.add(key);
      store.events.push({ t, text, ...parseEvent(text), apiKind: e.kind });
      added++;
    });
    if (!added && !enriched) return;
    store.events.sort((a, b) => a.t.localeCompare(b.t));
    while (store.events.length > MAX_EVENTS) store.events.shift();
    try { GM_setValue(EVENTS_KEY, JSON.stringify(store)); } catch (e2) { /* ignore */ }
  }

  // ─── Investment Tracker (Claw Street Ex page) ─────────────────────────────
  // Up to three parties (for example "Me" and "Crew") pool money in one fund. Each party owns a percentage of the fund:
  // adding money to a party buys it fund units at the fund's current value, so profit already made stays with the money
  // that was there. Every stock buy and sell in the Mews log after you press Start is replayed against the fund, so the
  // profit is split by those percentages. Holdings are valued at what was paid for them until they are sold; the
  // unrealised gain at today's price is shown separately. The tracker only reads the Mews log the script has saved.
  const INVEST_KEY = 'ms_invest_v1';
  const PARTY_COUNT = 3;
  const PARTY_COLORS = ['#b4df87', '#e9c46a', '#7fb7e9'];
  let invest = null;
  let investOpenParty = -1; // which party's "Invest" or "Withdraw" box is open
  let investOpenMode = 'in';
  let investConfirmReset = false;
  let investSig = '';
  let lastStocksForInvest = [];

  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money0 = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
  const signed0 = (n) => (n > 0 ? '+' : '') + money0(n);
  const pct1 = (n) => (n * 100).toFixed(1) + '%';

  function loadInvest() {
    if (invest) return invest;
    let saved = null;
    try { saved = JSON.parse(GM_getValue(INVEST_KEY, 'null')); } catch (e) { saved = null; }
    invest = { v: 1, active: false, startedAt: null, names: ['Me', 'Crew', ''], cash: [0, 0, 0], holds: [], invests: [] };
    if (saved && typeof saved === 'object') {
      Object.keys(invest).forEach((k) => { if (saved[k] != null) invest[k] = saved[k]; });
    }
    return invest;
  }
  function saveInvest() {
    try { GM_setValue(INVEST_KEY, JSON.stringify(invest)); } catch (e) { /* ignore */ }
  }
  const partyUsed = (st, i) => String(st.names[i] || '').trim() !== '';

  // Replays the opening position, the money added since, and every stock trade in the Mews log after Start.
  function computeInvest(st, events) {
    const fund = { cash: 0, hold: {}, units: [0, 0, 0], put: [0, 0, 0] };
    const nav = () => {
      const units = fund.units.reduce((a, b) => a + b, 0);
      const value = fund.cash + Object.values(fund.hold).reduce((a, h) => a + h.cost, 0);
      return units > 0 && value > 0 ? value / units : 1;
    };
    for (let i = 0; i < PARTY_COUNT; i++) {
      if (!partyUsed(st, i)) continue;
      const c = Math.max(0, Number(st.cash[i]) || 0);
      fund.cash += c; fund.units[i] += c; fund.put[i] += c;
    }
    (st.holds || []).forEach((h) => {
      const qty = Math.max(0, Number(h.qty) || 0), cost = qty * Math.max(0, Number(h.avg) || 0);
      if (!qty || !partyUsed(st, h.p)) return;
      const rec = fund.hold[h.stock] || (fund.hold[h.stock] = { qty: 0, cost: 0 });
      rec.qty += qty; rec.cost += cost; fund.units[h.p] += cost; fund.put[h.p] += cost;
    });

    const startMs = Date.parse(st.startedAt) || 0;
    const stockNames = new Set(Object.values(loadDb().stocks).map((s) => String(s.name).toLowerCase()));
    Object.keys(fund.hold).forEach((k) => stockNames.add(k.toLowerCase()));
    const steps = [];
    (st.invests || []).forEach((v) => steps.push({ ms: Date.parse(v.t), kind: 'invest', v }));
    events.forEach((e) => {
      if (e.kind !== 'trade') return;
      const ms = Date.parse(e.t);
      if (!(ms >= startMs)) return;
      if (stockNames.size && !stockNames.has(String(e.item).toLowerCase())) return;
      steps.push({ ms, kind: 'trade', e });
    });
    steps.sort((a, b) => a.ms - b.ms);

    const series = []; // profit per party after each sale
    const snap = (ms) => {
      const units = fund.units.reduce((a, b) => a + b, 0);
      const value = fund.cash + Object.values(fund.hold).reduce((a, h) => a + h.cost, 0);
      series.push({ ms, profit: fund.units.map((u, i) => (units > 0 ? (u / units) * value : 0) - fund.put[i]) });
    };
    let ignoredSells = 0, trades = 0;
    // Buys bigger than the cash the fund had at that moment. Money added with Invest while that stock is still held
    // (between the buy and the sale of that stock) covers the shortfall, oldest first. Once the stock is sold, the
    // buy's shortfall can no longer be covered, because the profit has already been split without that money.
    const over = [];
    steps.forEach((s) => {
      if (s.kind === 'invest') {
        let amt = Number(s.v.amount) || 0;
        if (!amt || !partyUsed(st, s.v.p)) return;
        const n = nav();
        if (amt < 0) {
          // A withdrawal: only cash can be paid out, and never more than the party's share of the fund is worth.
          amt = -Math.min(-amt, Math.max(0, fund.cash), fund.units[s.v.p] * n);
          if (!amt) return;
        }
        fund.units[s.v.p] += amt / n; fund.put[s.v.p] += amt; fund.cash += amt;
        let left = amt > 0 ? amt : 0;
        over.forEach((o) => {
          if (o.closed || o.remaining <= 0 || left <= 0) return;
          const take = Math.min(left, o.remaining);
          o.remaining -= take; left -= take;
        });
        return;
      }
      const e = s.e;
      trades++;
      if (e.side === 'bought') {
        if (e.total > fund.cash + 0.5) over.push({ t: e.t, item: e.item, qty: e.qty, total: e.total, had: Math.max(0, fund.cash), remaining: e.total - Math.max(0, fund.cash), closed: false });
        const rec = fund.hold[e.item] || (fund.hold[e.item] = { qty: 0, cost: 0 });
        rec.qty += e.qty; rec.cost += e.total; fund.cash -= e.total;
      } else {
        over.forEach((o) => { if (o.item === e.item) o.closed = true; });
        const rec = fund.hold[e.item];
        const q = Math.min(e.qty, rec ? rec.qty : 0);
        if (q < e.qty) ignoredSells++;
        if (q <= 0) return;
        const proceeds = e.total * (q / e.qty);
        rec.cost -= (rec.cost / rec.qty) * q; rec.qty -= q; fund.cash += proceeds;
        if (rec.qty <= 0) delete fund.hold[e.item];
        snap(s.ms);
      }
    });

    const overBuys = over.filter((o) => o.remaining > 0.5);
    const units = fund.units.reduce((a, b) => a + b, 0);
    const heldCost = Object.values(fund.hold).reduce((a, h) => a + h.cost, 0);
    const value = fund.cash + heldCost;
    return { fund, units, value, heldCost, series, ignoredSells, trades, overBuys };
  }

  function investChartSvg(st, res) {
    const pts = res.series;
    if (!pts.length) return '<p class="msx-inv-note">The profit chart appears after the first sale.</p>';
    const t0 = Date.parse(st.startedAt) || pts[0].ms, t1 = Math.max(pts[pts.length - 1].ms, t0 + 1);
    const all = [0].concat(...pts.map((p) => p.profit));
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi - lo < 1) { hi += 1; lo -= 1; }
    const W = 320, H = 110, PAD = 6;
    const X = (ms) => PAD + ((ms - t0) / (t1 - t0)) * (W - 2 * PAD);
    const Y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="msx-inv-chart" role="img" aria-label="Profit over time per party">` +
      `<line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="currentColor" stroke-opacity=".3" stroke-dasharray="3 3"/>`;
    for (let i = 0; i < PARTY_COUNT; i++) {
      if (!partyUsed(st, i)) continue;
      const path = [[t0, 0]].concat(pts.map((p) => [p.ms, p.profit[i]])).map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
      svg += `<polyline points="${path}" fill="none" stroke="${PARTY_COLORS[i]}" stroke-width="2"/>`;
    }
    return svg + '</svg>';
  }

  function investSetupHtml(st) {
    const stockOpts = Object.values(loadDb().stocks).map((s) => s.name).sort();
    let h = '<p class="msx-inv-note">Set who is in the fund and what each party has right now. Leave a party\'s name empty to skip it. After you press Start, every stock buy and sell in your Mews log is added to the right parties by their share of the fund.</p><div class="msx-inv-grid">';
    for (let i = 0; i < PARTY_COUNT; i++) {
      h += `<div class="msx-inv-party" style="border-color:${PARTY_COLORS[i]}"><b>Party ${i + 1}</b>` +
        `<label>Name <input type="text" data-inv="name" data-i="${i}" value="${escHtml(st.names[i] || '')}" placeholder="unused"></label>` +
        `<label>Cash $ <input type="text" inputmode="numeric" data-inv="cash" data-i="${i}" value="${st.cash[i] || ''}" placeholder="0"></label></div>`;
    }
    h += '</div><h4>Stocks held right now</h4>';
    st.holds.forEach((x, k) => {
      h += `<div class="msx-inv-hold"><select data-inv="hp" data-k="${k}">` +
        [0, 1, 2].filter((i) => partyUsed(st, i)).map((i) => `<option value="${i}"${i === x.p ? ' selected' : ''}>${escHtml(st.names[i])}</option>`).join('') + '</select>' +
        `<select data-inv="hs" data-k="${k}">` + stockOpts.map((n) => `<option${n === x.stock ? ' selected' : ''}>${escHtml(n)}</option>`).join('') + '</select>' +
        `<input type="text" inputmode="numeric" data-inv="hq" data-k="${k}" value="${x.qty || ''}" placeholder="shares">` +
        `<input type="text" inputmode="decimal" data-inv="ha" data-k="${k}" value="${x.avg || ''}" placeholder="avg price $">` +
        `<button type="button" data-inv="hdel" data-k="${k}">Remove</button></div>`;
    });
    h += '<div class="msx-inv-buttons"><button type="button" data-inv="hadd">Add a holding</button><button type="button" data-inv="start" class="msx-inv-go">Start tracking</button></div>';
    return h;
  }

  function investRunHtml(st, res, prices) {
    const used = [0, 1, 2].filter((i) => partyUsed(st, i));
    let unreal = 0, unrealKnown = true;
    Object.keys(res.fund.hold).forEach((name) => {
      const h = res.fund.hold[name], p = prices[name.toLowerCase()];
      if (p == null) { unrealKnown = false; return; }
      unreal += h.qty * p - h.cost;
    });
    const share = (i) => (res.units > 0 ? res.fund.units[i] / res.units : 0);
    const realised = (i) => share(i) * res.value - res.fund.put[i];
    const totalReal = used.reduce((a, i) => a + realised(i), 0);
    let h = `<p class="msx-inv-note">Tracking since ${escHtml(new Date(st.startedAt).toLocaleString())} · ${res.trades} stock trades read from your Mews log.</p>`;
    h += `<div class="msx-inv-total"><span>Fund value <b>${money0(res.value)}</b> <small>(cash ${money0(res.fund.cash)} + shares at cost ${money0(res.heldCost)})</small></span>` +
      `<span>Profit taken <b class="${totalReal >= 0 ? 'up' : 'down'}">${signed0(totalReal)}</b></span>` +
      `<span>Unrealised <b class="${unreal >= 0 ? 'up' : 'down'}">${unrealKnown ? signed0(unreal) : 'needs prices'}</b></span></div>`;
    if (res.fund.cash < 0) h += `<p class="msx-inv-warn">Your buys are ${money0(-res.fund.cash)} more than the money put into the fund. Add money with Invest, or the split will be off.</p>`;
    if (res.overBuys.length) {
      h += `<div class="msx-inv-warn">${res.overBuys.length} buy(s) were bigger than the money the fund had at the time. Add the missing money with Invest for the party that paid it while you still hold the stock (before you sell it), or the split will be off:<ul>` +
        res.overBuys.slice(-5).map((b) => `<li>${escHtml(new Date(b.t).toLocaleString())}: bought ${Math.round(b.qty).toLocaleString()} × ${escHtml(b.item)} for ${money0(b.total)}, the fund had ${money0(b.had)}: <b>${money0(b.remaining)} short</b>${b.remaining < b.total - b.had - 0.5 ? ' (partly covered)' : ''}</li>`).join('') +
        (res.overBuys.length > 5 ? `<li>and ${res.overBuys.length - 5} earlier</li>` : '') + '</ul></div>';
    }
    if (res.ignoredSells) h += `<p class="msx-inv-warn">${res.ignoredSells} sale(s) were of shares the fund never bought (bought before you pressed Start), so they were skipped or trimmed.</p>`;
    if (!settings.events) h += '<p class="msx-inv-warn">"Log my Mews events" is off on the Account page, so trades are not being read.</p>';
    h += '<div class="msx-inv-grid">';
    used.forEach((i) => {
      const un = unrealKnown ? share(i) * unreal : null;
      h += `<div class="msx-inv-party" style="border-color:${PARTY_COLORS[i]}"><b>${escHtml(st.names[i])}</b><span class="msx-inv-pct">${pct1(share(i))} of the fund</span>` +
        `<span title="Money added with Invest, minus money taken out with Withdraw">Money in ${money0(res.fund.put[i])}</span><span>Worth ${money0(share(i) * res.value)}</span>` +
        `<span>Profit <b class="${realised(i) >= 0 ? 'up' : 'down'}">${signed0(realised(i))}</b>${un == null ? '' : ` <small>(${signed0(un)} unrealised)</small>`}</span>`;
      if (investOpenParty === i) {
        const out = investOpenMode === 'out';
        h += `<div class="msx-inv-add"><input type="text" inputmode="numeric" data-inv="amt" data-i="${i}" placeholder="${out ? 'amount to take out $' : 'amount $'}"><button type="button" data-inv="invok" data-i="${i}">${out ? 'Withdraw' : 'Add'}</button><button type="button" data-inv="invno">Cancel</button></div>`;
      } else {
        h += `<div class="msx-inv-add"><button type="button" data-inv="invopen" data-i="${i}">Invest</button><button type="button" data-inv="outopen" data-i="${i}">Withdraw</button></div>`;
      }
      h += '</div>';
    });
    h += '</div>';
    const names = Object.keys(res.fund.hold);
    if (names.length) {
      h += '<table class="msx-inv-table"><thead><tr><th>Shares held</th><th>Total</th>' + used.map((i) => `<th>${escHtml(st.names[i])}</th>`).join('') + '<th>Avg cost</th></tr></thead><tbody>';
      names.forEach((n) => {
        const r = res.fund.hold[n];
        h += `<tr><td>${escHtml(n)}</td><td>${Math.round(r.qty).toLocaleString()}</td>` + used.map((i) => `<td>${(r.qty * share(i)).toFixed(1)}</td>`).join('') + `<td>$${(r.cost / r.qty).toFixed(1)}</td></tr>`;
      });
      h += '</tbody></table>';
    }
    h += '<h4>Profit taken over time</h4>' + investChartSvg(st, res) +
      '<div class="msx-inv-legend">' + used.map((i) => `<span><i style="background:${PARTY_COLORS[i]}"></i>${escHtml(st.names[i])}</span>`).join('') + '</div>';
    h += `<div class="msx-inv-buttons"><button type="button" data-inv="reset">${investConfirmReset ? 'Click again to erase the tracker and start over' : 'Reset tracker'}</button></div>`;
    return h;
  }

  function renderInvest(panel, stocks, force) {
    const st = loadInvest();
    const prices = {};
    (stocks || []).forEach((s) => { prices[String(s.name).toLowerCase()] = s.price; });
    const ev = loadEvents().events;
    const sig = JSON.stringify(st) + '|' + ev.length + '|' + (ev.length ? ev[ev.length - 1].t : '') + '|' + (st.active ? JSON.stringify(prices) : '') + '|' + investOpenParty + investOpenMode + '|' + investConfirmReset;
    if (!force && sig === investSig) return;
    if (!force && panel.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
    investSig = sig;
    panel.querySelector('.msx-inv-body').innerHTML = st.active ? investRunHtml(st, computeInvest(st, ev), prices) : investSetupHtml(st);
  }

  function investClick(e, panel) {
    const el = e.target.closest('[data-inv]');
    if (!el) return;
    const st = loadInvest();
    const act = el.dataset.inv, i = Number(el.dataset.i), k = Number(el.dataset.k);
    if (act === 'hadd') {
      const first = [0, 1, 2].find((x) => partyUsed(st, x));
      const stock = Object.values(loadDb().stocks).map((s) => s.name).sort()[0];
      if (first == null || !stock) { toast('Name a party first, and open the stock page once so the stocks are known.'); return; }
      st.holds.push({ p: first, stock, qty: 0, avg: 0 });
    } else if (act === 'hdel') {
      st.holds.splice(k, 1);
    } else if (act === 'start') {
      if (![0, 1, 2].some((x) => partyUsed(st, x))) { toast('Give at least one party a name first.'); return; }
      st.holds = st.holds.filter((x) => Number(x.qty) > 0 && partyUsed(st, x.p));
      st.active = true; st.startedAt = new Date().toISOString(); st.invests = [];
    } else if (act === 'invopen' || act === 'outopen') {
      investOpenParty = i; investOpenMode = act === 'outopen' ? 'out' : 'in';
      saveInvest(); renderInvest(panel, null, true);
      panel.querySelector('[data-inv="amt"]')?.focus();
      return;
    } else if (act === 'invno') {
      investOpenParty = -1;
    } else if (act === 'invok') {
      const raw = panel.querySelector('[data-inv="amt"]')?.value || '';
      const amount = moneyOf(raw.replace(/[$\s]/g, ''));
      if (!(amount > 0)) { toast('Type an amount above 0.'); return; }
      let signedAmount = amount;
      if (investOpenMode === 'out') {
        const res = computeInvest(st, loadEvents().events);
        const worth = res.units > 0 ? (res.fund.units[i] / res.units) * res.value : 0;
        if (amount > worth + 0.5) { toast('That is more than ' + (st.names[i] || 'this party') + ' has in the fund (' + money0(worth) + ').'); return; }
        if (amount > res.fund.cash + 0.5) { toast('Only ' + money0(res.fund.cash) + ' of the fund is cash right now; the rest is in shares. Sell first.'); return; }
        signedAmount = -amount;
      }
      st.invests.push({ t: new Date().toISOString(), p: i, amount: signedAmount });
      investOpenParty = -1;
    } else if (act === 'reset') {
      if (!investConfirmReset) { investConfirmReset = true; renderInvest(panel, null, true); return; }
      investConfirmReset = false; investOpenParty = -1;
      st.active = false; st.startedAt = null; st.invests = [];
    } else { return; }
    saveInvest();
    renderInvest(panel, lastStocksForInvest, true);
  }

  function investChange(e) {
    const el = e.target.closest('[data-inv]');
    if (!el) return;
    const st = loadInvest();
    const act = el.dataset.inv, i = Number(el.dataset.i), k = Number(el.dataset.k);
    if (act === 'name') st.names[i] = el.value.trim();
    else if (act === 'cash') st.cash[i] = moneyOf(el.value.replace(/[$\s]/g, '')) || 0;
    else if (act === 'hp') st.holds[k].p = Number(el.value);
    else if (act === 'hs') st.holds[k].stock = el.value;
    else if (act === 'hq') st.holds[k].qty = moneyOf(el.value) || 0;
    else if (act === 'ha') st.holds[k].avg = moneyOf(el.value.replace(/[$\s]/g, '')) || 0;
    else return;
    saveInvest();
    if (act === 'name') renderInvest(el.closest('#msx-invest'), lastStocksForInvest, true); // party lists in the holdings rows follow the names
  }

  function ensureInvestPanel(stocks) {
    lastStocksForInvest = stocks;
    let panel = document.getElementById('msx-invest');
    if (!panel) {
      const table = document.querySelector('.watch-table');
      if (!table) return;
      panel = document.createElement('details');
      panel.id = 'msx-invest';
      panel.innerHTML = '<summary>Investment Tracker</summary><div class="msx-inv-body"></div>';
      panel.addEventListener('click', (e) => investClick(e, panel));
      panel.addEventListener('change', investChange);
      table.insertAdjacentElement('afterend', panel);
      investSig = '';
    }
    renderInvest(panel, stocks, false);
  }

  // ─── Heists and crew jobs: XP/energy, XP/nerve, $/energy, $/nerve ─────────
  // Built entirely from the game's own data (see api-data-reference.md); neither page has any other reading on
  // it. Heists: nerve is the same (10) for every heist type, so energy is the axis that actually tells them
  // apart; the $ figure is an exact expected value, not a guess -- the split rule (half the profit pool shared
  // evenly, half by role skill) was confirmed from the game's own handbook, and "profit" in the data already
  // is the average per-cat share, checked against the user's own completed heist. Crew jobs: nerve is the only
  // resource that varies, and the payout ("cut") is a flat amount per member regardless of role, confirmed
  // against the user's own completed crew job.
  function fmtDuration(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), mm = m % 60;
    return h + 'h' + (mm ? ` ${mm}m` : '');
  }

  // ─── Copy your crew job to Discord (Crew page) ─────────────────────────────
  // Builds a plain-text message from the crew job you are actually in right now (recruiting or already
  // launched): which seats are filled, which are open and what stat each open seat wants (crewJobRoles, the
  // game's own data, not a guess), and the payout. A button copies it to the clipboard for you to paste --
  // nothing is ever sent anywhere by this script itself; pasting it into Discord is still something you do.
  function copyToClipboard(text) {
    try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; } } catch (e) { /* fall through */ }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through */ }
    return false;
  }

  function buildCrewJobMessage(job, crewName) {
    const roles = apiState && apiState.crewJobRoles;
    const title = job.name || 'Crew job';
    const filled = job.members || [];
    const seatsTotal = job.maxMembers || filled.length;
    const openCount = Math.max(0, seatsTotal - filled.length);
    const roleTitle = (key) => (roles && roles[key] && roles[key].title) || key || 'Unknown role';
    const lines = [];
    lines.push(`🐾 **${crewName ? crewName + ' — ' : ''}${title}**${job.tier ? ` (tier ${job.tier})` : ''}`);
    if (job.minLevel != null) lines.push(`🔒 Level ${job.minLevel}+`);
    if (job.status === 'planning') {
      lines.push(`Recruiting — ${filled.length}/${seatsTotal} seats filled${job.minMembers ? `, ${job.minMembers} minimum to launch` : ''}`);
    } else {
      const remain = job.endsAt ? job.endsAt - Date.now() : null;
      lines.push(remain != null && remain > 0 ? `🚀 Underway — done in ${fmtClock(remain)}` : '🚀 Underway');
    }
    if (filled.length) {
      lines.push('', '✅ Filled:');
      filled.forEach((m) => lines.push(`• ${roleTitle(m.role)} — ${m.name || 'someone'}${m.level != null ? ` (Lv ${m.level})` : ''}`));
    }
    if (job.status === 'planning' && openCount > 0) {
      const filledRoles = new Set(filled.map((m) => m.role));
      const openRoles = (job.roles || []).filter((r) => !filledRoles.has(r));
      lines.push('', '🟡 Open:');
      if (openRoles.length) {
        openRoles.forEach((rk) => {
          const stat = roles && roles[rk] && roles[rk].stat;
          lines.push(`• ${roleTitle(rk)}${stat ? ` — needs ${stat}` : ''}`);
        });
      } else {
        lines.push(`• ${openCount} seat${openCount === 1 ? '' : 's'} open`);
      }
    }
    const payoutBits = [];
    if (job.cut != null) payoutBits.push(`💰 ${money0(job.cut)} each`);
    if (job.take != null) payoutBits.push(`treasury ${money0(job.take)}`);
    if (job.respect != null) payoutBits.push(`+${job.respect} respect`);
    const oddsBits = [];
    if (job.chance != null) oddsBits.push(`🎲 ${job.chance}% chance`);
    if (job.nerve != null) oddsBits.push(`${job.nerve} nerve`);
    if (job.stake) oddsBits.push(`${money0(job.stake)} stake`);
    if (payoutBits.length || oddsBits.length) lines.push('');
    if (payoutBits.length) lines.push(payoutBits.join(' · '));
    if (oddsBits.length) lines.push(oddsBits.join(' · '));
    return lines.join('\n');
  }

  // Same idea as the crew job message, but for a heist you're actually in. Heists carry no role->stat lookup
  // the way crew jobs do (checked -- there's no `heistRoles` anywhere in the game's own data), so an open seat
  // just says how many are left, not what it wants.
  function buildHeistMessage(heist, crewName) {
    const title = heist.name || 'Heist';
    const filled = heist.members || [];
    const seatsTotal = heist.maxMembers || filled.length;
    const openCount = Math.max(0, seatsTotal - filled.length);
    const lines = [];
    lines.push(`🐾 **${crewName ? crewName + ' — ' : ''}${title}**${heist.tier ? ` (tier ${heist.tier})` : ''}`);
    if (heist.minLevel != null) lines.push(`🔒 Level ${heist.minLevel}+`);
    if (heist.status !== 'running') {
      lines.push(`Recruiting — ${filled.length}/${seatsTotal} in the clowder${heist.minMembers ? `, ${heist.minMembers} minimum to launch` : ''}`);
    } else {
      const remain = heist.endsAt ? heist.endsAt - Date.now() : null;
      lines.push(remain != null && remain > 0 ? `🚀 Underway — done in ${fmtClock(remain)}` : '🚀 Underway');
    }
    if (filled.length) {
      lines.push('', '✅ In the clowder:');
      filled.forEach((m) => lines.push(`• ${m.role || 'someone'}${m.name ? ` — ${m.name}` : ''}`));
    }
    if (heist.status !== 'running' && openCount > 0) lines.push('', `🟡 ${openCount} seat${openCount === 1 ? '' : 's'} open`);
    const payoutBits = [];
    if (heist.stake != null) payoutBits.push(`💰 ${money0(heist.stake)} stake`);
    if (heist.profit != null) payoutBits.push(`+${money0(heist.profit)} profit each`);
    if (heist.failReturn != null) payoutBits.push(`${money0(heist.failReturn)} back on a bust`);
    const oddsBits = [];
    if (heist.chance != null) oddsBits.push(`🎲 ${heist.chance}% chance`);
    if (heist.energy != null) oddsBits.push(`${heist.energy} energy`);
    if (heist.nerve != null) oddsBits.push(`${heist.nerve} nerve`);
    if (payoutBits.length || oddsBits.length) lines.push('');
    if (payoutBits.length) lines.push(payoutBits.join(' · '));
    if (oddsBits.length) lines.push(oddsBits.join(' · '));
    return lines.join('\n');
  }

  // Shared by the crew job and heist "Copy for Discord" panels: when there's more than one you're in at once
  // (e.g. one already underway while a seat is reserved in a second, still-recruiting one), a row of tabs lets
  // you switch which one's message is shown -- the panel never has to guess which one you meant to post.
  // The click handler reads `panel.__msxJobs` fresh every time rather than closing over it, so a tab clicked
  // after the underlying data has moved on (a new member joined, the chance changed, ...) never posts stale text.
  function ensureJobMessagesPanel(panelId, pathMatch, anchorId, heading, note, jobs, buildMessage, crewName) {
    if (location.pathname.replace(/\/+$/, '') !== pathMatch) { document.getElementById(panelId)?.remove(); return; }
    if (!jobs || !jobs.length) { document.getElementById(panelId)?.remove(); return; }
    const host = document.querySelector('.main-content') || document.querySelector('main');
    if (!host) return;
    let panel = document.getElementById(panelId);
    const renderSelected = () => {
      const js = panel.__msxJobs || [];
      if (!js.length) return;
      let selected = panel.dataset.selectedId;
      if (!js.some((j) => String(j.id) === selected)) selected = String(js[0].id);
      panel.dataset.selectedId = selected;
      panel.querySelectorAll('.msx-jobtab').forEach((btn) => btn.classList.toggle('active', btn.dataset.id === selected));
      const job = js.find((j) => String(j.id) === selected) || js[0];
      const msg = panel.__msxBuildMessage(job, panel.__msxCrewName);
      const ta = panel.querySelector('textarea');
      if (ta.value !== msg) ta.value = msg;
    };
    if (!panel) {
      panel = document.createElement('section');
      panel.id = panelId;
      panel.innerHTML = `<h2>${heading}</h2><p class="msx-inv-note">${note}</p><div class="msx-jobtabs"></div><textarea readonly></textarea><button type="button" class="msx-copybtn">📋 Copy for Discord</button>`;
      panel.querySelector('.msx-copybtn').addEventListener('click', () => {
        const ta = panel.querySelector('textarea');
        const ok = copyToClipboard(ta.value);
        if (!ok) { ta.focus(); ta.select(); }
        toast(ok ? 'Copied — paste it in Discord.' : 'Couldn’t copy automatically — the text is selected, press Ctrl+C.');
      });
      panel.querySelector('.msx-jobtabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.msx-jobtab');
        if (!btn) return;
        panel.dataset.selectedId = btn.dataset.id;
        renderSelected();
      });
      const anchor = document.getElementById(anchorId);
      if (anchor) host.insertBefore(panel, anchor); else host.appendChild(panel);
    }
    panel.__msxJobs = jobs;
    panel.__msxBuildMessage = buildMessage;
    panel.__msxCrewName = crewName;
    // The heading and note both depend on how many jobs there are right now (singular/plural, the "click a
    // tab" hint) -- a second one can start recruiting after the panel already exists, so these are kept live
    // rather than only ever set at creation.
    const h2 = panel.querySelector('h2');
    if (h2 && h2.textContent !== heading) h2.textContent = heading;
    const noteEl = panel.querySelector('.msx-inv-note');
    if (noteEl && noteEl.innerHTML !== note) noteEl.innerHTML = note;
    const tabsEl = panel.querySelector('.msx-jobtabs');
    let selected = panel.dataset.selectedId;
    if (!jobs.some((j) => String(j.id) === selected)) selected = String(jobs[0].id);
    panel.dataset.selectedId = selected;
    const tabsHtml = jobs.length > 1
      ? jobs.map((j) => `<button type="button" class="msx-jobtab${String(j.id) === selected ? ' active' : ''}" data-id="${escHtml(String(j.id))}">${escHtml(j.name || 'Job')}</button>`).join('')
      : '';
    if (tabsEl.innerHTML !== tabsHtml) tabsEl.innerHTML = tabsHtml;
    renderSelected();
  }

  function ensureMyCrewJobPanel() {
    const jobs = (apiState && apiState.myCrewJobs) || [];
    ensureJobMessagesPanel('msx-mycrewjob', '/crew', 'msx-crewjobs', 'Your crew job' + (jobs.length > 1 ? 's' : ''),
      'Ready to post in Discord: who has a seat, which seats are still open (and what stat they want), and the payout.' +
      (jobs.length > 1 ? ' Click a job\'s name above to switch which one\'s message is shown.' : ''),
      jobs, buildCrewJobMessage, apiState && apiState.crew && apiState.crew.name);
  }

  function ensureMyHeistPanel() {
    const jobs = (apiState && apiState.myHeists) || [];
    ensureJobMessagesPanel('msx-myheist', '/heists', 'msx-heists', 'Your heist' + (jobs.length > 1 ? 's' : ''),
      'Ready to post in Discord: who\'s in the clowder, how many seats are open, and the payout.' +
      (jobs.length > 1 ? ' Click a heist\'s name above to switch which one\'s message is shown.' : ''),
      jobs, buildHeistMessage, apiState && apiState.crew && apiState.crew.name);
  }

  function ensureHeistsPanel() {
    if (location.pathname.replace(/\/+$/, '') !== '/heists') { document.getElementById('msx-heists')?.remove(); return; }
    const host = document.querySelector('.main-content') || document.querySelector('main');
    if (!host) return;
    let panel = document.getElementById('msx-heists');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'msx-heists';
      panel.innerHTML = '<h2>Heist XP/energy and $/energy</h2><div class="msx-calc-body"></div>';
      host.appendChild(panel);
    }
    const body = panel.querySelector('.msx-calc-body');
    const heists = apiState?.heists || [];
    if (!heists.length) { body.innerHTML = '<p class="msx-inv-note">Waiting for the game’s own heist data (open this page once it has loaded).</p>'; return; }
    const xp = apiState.heistXp || { success: 20, fail: 5 };
    let h = '<p class="msx-inv-note">Nerve costs the same (10) for every heist, so energy is what actually tells them apart. The $ figure is an exact expected value: chance × profit − (1 − chance) × what a bust costs you, using your own real chance for each job.</p>';
    h += '<table class="msx-inv-table"><thead><tr><th>Heist</th><th>Chance</th><th>Energy</th><th>Stake</th><th>Profit / cat</th><th>Bust returns</th><th>XP/energy</th><th>$/energy</th><th>Run</th></tr></thead><tbody>';
    heists.forEach((t) => {
      const c = t.chance / 100;
      const dollarEv = c * t.profit + (1 - c) * (t.failReturn - t.stake);
      const xpEv = c * xp.success + (1 - c) * xp.fail;
      h += `<tr><td>${escHtml(t.name)}<br><small>${escHtml(t.short || '')}</small></td><td>${t.chance}%</td><td>${t.energy}</td>` +
        `<td>${money0(t.stake)}</td><td>${money0(t.profit)}</td><td>${money0(t.failReturn)}</td>` +
        `<td>${(xpEv / t.energy).toFixed(2)}</td><td>${signed0(dollarEv / t.energy)}</td><td>${fmtDuration(t.duration)}</td></tr>`;
    });
    h += '</tbody></table><p class="msx-inv-note">Also costs 10 nerve per cat either way. A kit (10% of the stake) is not included here.</p>';
    body.innerHTML = h;
  }

  function ensureCrewJobsPanel() {
    if (location.pathname.replace(/\/+$/, '') !== '/crew') { document.getElementById('msx-crewjobs')?.remove(); return; }
    const host = document.querySelector('.main-content') || document.querySelector('main');
    if (!host) return;
    let panel = document.getElementById('msx-crewjobs');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'msx-crewjobs';
      panel.innerHTML = '<h2>Crew job XP/nerve and $/nerve</h2><div class="msx-calc-body"></div>';
      host.appendChild(panel);
    }
    const body = panel.querySelector('.msx-calc-body');
    const tiers = apiState?.crewJobTiers || [];
    if (!tiers.length) { body.innerHTML = '<p class="msx-inv-note">Waiting for the game’s own crew job data (open this page once it has loaded).</p>'; return; }
    let h = '<p class="msx-inv-note">The $ you personally get ("cut") is fixed per member, the same for every role. This assumes a bust pays nothing personally, only the crew’s treasury ("take") and respect are separate from your own cut.</p>';
    h += '<table class="msx-inv-table"><thead><tr><th>Job</th><th>Chance</th><th>Nerve</th><th>Your cut</th><th>To treasury</th><th>Respect</th><th>XP/nerve</th><th>$/nerve</th><th>Run</th></tr></thead><tbody>';
    tiers.forEach((t) => {
      const c = t.chance / 100;
      const xpEv = c * t.xp + (1 - c) * t.xpFail;
      const dollarEv = c * t.cut;
      h += `<tr><td>${escHtml(t.name)}<br><small>tier ${t.tier} · level ${t.level}+</small></td><td>${t.chance}%</td><td>${t.nerve}</td>` +
        `<td>${money0(t.cut)}</td><td>${money0(t.take)}</td><td>${t.respect}</td>` +
        `<td>${(xpEv / t.nerve).toFixed(2)}</td><td>${signed0(dollarEv / t.nerve)}</td><td>${fmtDuration(t.duration)}</td></tr>`;
    });
    h += '</tbody></table>';
    body.innerHTML = h;
  }

  function ensureTradingPanel() {
    // Confirmed on the live site (2026-09-30): the Trading page really is at /trading.
    if (location.pathname.replace(/\/+$/, '') !== '/trading') { document.getElementById('msx-trading')?.remove(); return; }
    const host = document.querySelector('.main-content') || document.querySelector('main');
    if (!host) return;
    let panel = document.getElementById('msx-trading');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'msx-trading';
      panel.innerHTML = '<h2>Listed vs Whiskers & Co. price</h2><div class="msx-calc-body"></div>';
      // At the top of the page (user request), not appended after everything else on it.
      host.insertBefore(panel, host.firstChild);
    }
    const body = panel.querySelector('.msx-calc-body');
    const listings = apiState?.listings || [];
    const store = apiState?.storeItems || {};
    if (!listings.length) { body.innerHTML = '<p class="msx-inv-note">No open listings read yet (open this page once it has loaded).</p>'; return; }
    // Cheapest open listing per item, since that is the one worth comparing against the store.
    const cheapest = new Map();
    const counts = new Map();
    listings.forEach((l) => {
      counts.set(l.item, (counts.get(l.item) || 0) + 1);
      const cur = cheapest.get(l.item);
      if (!cur || l.price < cur.price) cheapest.set(l.item, l);
    });
    // The Trading page's own text states the buyer's tax exactly: "A buyer pays a 2% tax on top of the price."
    // Rounding is up, not nearest -- confirmed against the user's own real trades (a $100 buy taxed exactly $2,
    // a $105 buy taxed $3, which is only 2% rounded up, not down or to the nearest dollar).
    const TRADE_TAX_RATE = 0.02;
    const taxOn = (price) => Math.ceil(price * TRADE_TAX_RATE);
    const rows = [...cheapest.entries()].map(([id, l]) => {
      const s = store[id];
      const total = l.price + taxOn(l.price);
      const buyPrice = s ? s.price : null;
      const sellPrice = s ? s.sellPrice : null;
      // Positive = free money (buy the listing, sell it straight back to Whiskers & Co. for more than it cost).
      const sellProfit = sellPrice != null ? sellPrice - total : null;
      // Negative = cheaper than the store; positive = the store is the better buy.
      const buyDiff = buyPrice != null ? total - buyPrice : null;
      return { name: s ? s.name : id, buyPrice, sellPrice, listedPrice: l.price, total, seller: l.seller, count: counts.get(id), sellProfit, buyDiff };
    }).sort((a, b) => {
      // Best opportunity first, whichever kind it is: the biggest sell-back profit, or failing that the
      // biggest discount off the store's buy price. Items with neither sit at the bottom.
      const opportunity = (r) => Math.max(r.sellProfit != null ? r.sellProfit : -Infinity, r.buyDiff != null ? -r.buyDiff : -Infinity);
      return opportunity(b) - opportunity(a);
    });
    let h = '<p class="msx-inv-note">The cheapest currently-open listing for each item. "With tax" is what buying ' +
      'it would actually cost: the listed price plus the Trading page\'s own stated 2% buyer\'s tax (rounded up), ' +
      'the same total it shows you when you click to buy. "Vs store" checks that total against Whiskers & Co.\'s ' +
      'own buy price; "Sells back for" is what Whiskers & Co. pays you for it if you already own one or buy this ' +
      'listing -- when that\'s more than the listing\'s total cost, buying it and selling it straight back is ' +
      'instant profit, flagged below. Not every item has a store buy price (crime drops, for example) or a ' +
      'confirmed sell-back price (only seen so far on crime-drop collectibles, never on anything Whiskers & Co. ' +
      'also sells) -- those show a dash rather than a guess.</p>';
    h += '<table class="msx-inv-table"><thead><tr><th>Item</th><th>Listed</th><th>With tax</th><th>Whiskers buy price</th>' +
      '<th>Vs store</th><th>Sells back for</th><th>Resell profit</th><th>Open listings</th></tr></thead><tbody>';
    rows.forEach((r) => {
      let vs = '<span class="msx-unk">no store price</span>';
      if (r.buyPrice != null) {
        vs = r.buyDiff < 0 ? `<b>${signed0(r.buyDiff)} cheaper</b>` : r.buyDiff > 0 ? `${signed0(r.buyDiff)} pricier -- buy from the store instead` : 'same as the store';
      }
      let profit = '—';
      if (r.sellProfit != null) {
        profit = r.sellProfit > 0 ? `<b>${signed0(r.sellProfit)} profit -- buy &amp; sell back</b>` : signed0(r.sellProfit);
      }
      h += `<tr><td>${escHtml(r.name)}</td><td>${money0(r.listedPrice)}${r.seller ? ` <small>(${escHtml(r.seller)})</small>` : ''}</td>` +
        `<td>${money0(r.total)}</td><td>${r.buyPrice != null ? money0(r.buyPrice) : '—'}</td><td>${vs}</td>` +
        `<td>${r.sellPrice != null ? money0(r.sellPrice) : '—'}</td><td>${profit}</td><td>${r.count}</td></tr>`;
    });
    h += '</tbody></table>';
    body.innerHTML = h;
  }

  // ─── Account page panel ───────────────────────────────────────────────────
  // Settings for the script, added at the bottom of the Account page. The script never reads that page.
  function ensureAccountPanel() {
    const existing = document.getElementById('msx-account');
    if (currentPath() !== '/account') { if (existing) existing.remove(); return; }
    if (existing) { updateAccountPanel(); return; }
    const host = document.querySelector('.main-content') || document.querySelector('main');
    if (!host) return;
    const box = document.createElement('section');
    box.id = 'msx-account';
    box.innerHTML =
      '<h2>MeowStreets Extra Info</h2>' +
      '<p class="msx-acc-sub">Settings for the userscript. It also reads (never requests) the JSON the game\'s own pages fetch from their own API, for exact crime, merit and crew numbers; only specific known fields are kept, never your email or other players\' data. Everything it records stays on this computer; it sends nothing anywhere.</p>' +
      '<h3>Recording</h3>' +
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-capture"> Save each page I view (kept on this computer; never account, payment or other players\' pages, never chat)</label>' +
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-events"> Log my Mews events (crime results, trades, training)</label>' +
      '<h3>Your data</h3>' +
      '<p>Everything the script has logged (crime readings, stock prices, Mews events, page captures) can be saved to a file on your computer.</p>' +
      '<div class="msx-acc-buttons"><button type="button" id="msx-acc-export">Export data</button></div>';
    host.appendChild(box);

    box.querySelector('#msx-acc-export').addEventListener('click', exportDb);
    box.querySelector('#msx-acc-capture').addEventListener('change', (e) => { settings.capture = e.target.checked; saveSettings(); });
    box.querySelector('#msx-acc-events').addEventListener('change', (e) => { settings.events = e.target.checked; saveSettings(); });
    updateAccountPanel();
  }

  function updateAccountPanel() {
    const box = document.getElementById('msx-account');
    if (!box) return;
    const cap = box.querySelector('#msx-acc-capture');
    const ev = box.querySelector('#msx-acc-events');
    if (cap.checked !== settings.capture) cap.checked = settings.capture;
    if (ev.checked !== settings.events) ev.checked = settings.events;
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
      ensureAccountPanel();
      noteView();
      readModifiers();
      logStocksFromApi();
      readEvents();
      readEventsFromApi();
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
      updateCrewJobPill();
      updateHeistPill();
      updateCompanionPill();
      updatePvpPill();
      updateConsumablesPill();
      ensureMyCrewJobPanel();
      ensureMyHeistPanel();
      ensureHeistsPanel();
      ensureCrewJobsPanel();
      ensureTradingPanel();
      if (isStockPage() && document.querySelector('.watch-table')) {
        const stocks = readStocks();
        logStocks(stocks);
        drawStocks(stocks);
        ensureInvestPanel(stocks);
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
        const own = (m) => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('.msx-ticker, .msx-legend, #msx-toast, #msx-tools, #msx-invest, #msx-heists, #msx-crewjobs, #msx-mycrewjob, #msx-myheist, #msx-trading');
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
    GM_addValueChangeListener(SETTINGS_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(newValue) }; } catch (e) { return; }
      updateAccountPanel();
      updateLegend();
    });
    GM_addValueChangeListener(INVEST_KEY, (name, oldValue, newValue, remote) => {
      if (remote) { invest = null; investSig = ''; }
    });
    GM_addValueChangeListener(EVENTS_KEY, (name, oldValue, newValue, remote) => {
      if (remote) { eventsCache = null; eventKeys = null; }
    });
    GM_addValueChangeListener(NEXT_MOVE_KEY, (name, oldValue, newValue, remote) => {
      if (remote) nextMoveAnchor = Number(newValue) || 0;
    });
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('MeowStreets: export data', exportDb);
    GM_registerMenuCommand('MeowStreets: scan this page', () => { scanPage(true).catch(() => {}); });
  }

  schedule();
  observe();
})();
