// ==UserScript==
// @name         MeowStreets Extra Info
// @namespace    https://meowstreets.com
// @version      0.26.2
// @description  Crimes page: exact XP and cash per nerve, item drops, the success % breakdown and the best crimes highlighted on every card. Claw Street Ex: logs stock prices and shows if a price looks low or high. Sidebar timers for stocks and your crew chain, a "Script data" checklist and a Mews event log, all kept on your computer. It also reads (never requests) the JSON the game's own pages fetch from their own API, for exact crime, merit and crew numbers. It sends nothing anywhere unless you turn on crew sharing (Account page), and then only crew chain, crew job, stock price and earned-feat info, to your crew's own Discord bot (which shares the crew's stock price history and how to get hidden feats back). Sharing is only offered to members of the crew the bot serves.
// @author       Strayben
// @homepageURL  https://github.com/tcstrayben/Meowstreetscript
// @supportURL   https://github.com/tcstrayben/Meowstreetscript/issues
// @updateURL    https://raw.githubusercontent.com/tcstrayben/Meowstreetscript/main/meowstreets-info.user.js
// @downloadURL  https://raw.githubusercontent.com/tcstrayben/Meowstreetscript/main/meowstreets-info.user.js
// @match        https://meowstreets.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      168.138.79.225
// ==/UserScript==

(function () {
  'use strict';

  // Only ever run on https://meowstreets.com/... pages (crimes, merits, and so on). The @match line already
  // limits this; the check is a second guard.
  const SITE_ORIGIN = 'https://meowstreets.com';
  if (location.origin !== SITE_ORIGIN) return;

  // READ-ONLY by design (MeowStreets ToS: "no bots, scripts or automation that play for you").
  // This script only reads what is already on the page you are looking at and draws numbers next to it.
  // It makes no network requests of its own, clicks nothing and presses nothing. It does read the responses to
  // requests the page itself makes (its own /api/state call) for exact numbers, the same way it reads rendered
  // text -- see api-data-reference.md. Only specific known fields are ever kept; the rest (which includes your
  // email and other players' data) is discarded at once, never saved. Everything it records stays in this
  // browser (Tampermonkey storage) and is only used for what the script shows.

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
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isCrimesPage = () => location.pathname.replace(/\/+$/, '') === '/crimes';

  // ─── Reading the game's own /api/state response (still read-only) ─────────
  // The page itself fetches this on most navigations, to load almost its whole state in one go. This only
  // watches the response to that request; it never makes a request of its own. Only the specific fields below
  // are ever kept, in memory for this page view only, never saved to storage or exported: the raw response also
  // carries the account email and other players' data, which this project must never touch. See
  // api-data-reference.md for the full shape of what the response contains.
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  let apiState = null; // { at, crimes: {key: {...}}, meritLines: {name: {...}}, merits, crew, chain } | null
  let tradingRefreshAt = 0; // when the soonest hourly store price on the Trading panel goes out of date

  function extractApiState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
      const out = {
        at: Date.now(), crimes: {}, meritLines: {}, merits: null, crew: null, chain: null, stocks: null, events: [],
        education: null, companion: null, protectedUntil: 0, bountyOnMe: 0, cooldowns: {}, usedUp: [], energy: null, nerve: null, caps: null,
        crimeBonusParts: [], storeItems: {}, listings: [], shopItems: [], marketRate: 1, marketDiscounts: [], weeklyResetAt: 0, crewJobsSeen: false,
        heists: [], crewJobTiers: [], heistXp: null, activeCrewJob: null, activeHeist: null, myCrewJobs: [], myHeists: [], crewJobRoles: null, deposits: [],
      };
      (raw.crimes || []).forEach((c) => {
        if (!c || !c.name) return;
        out.crimes[norm(c.name)] = {
          id: c.id, chance: c.chance, baseChance: c.baseChance, masteryLevel: c.masteryLevel, masteryBonus: c.masteryBonus,
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
          name: raw.crew.name || null, id: raw.crew.id != null ? Number(raw.crew.id) : null,
          buffActive: !!raw.crew.buffActive, buffUntil: raw.crew.buff_until || 0,
          chain: raw.crew.chain, chainAt: raw.crew.chain_at, chainEndsAt: raw.crew.chainEndsAt,
          treasury: raw.crew.treasury, respect: raw.crew.respect,
        };
      }
      // Bank deposits still "open" (0.22.0): only the amount and end time. One past its end time is waiting to be
      // collected on the Feline Bank page ("broken" = taken out early, not counted).
      if (Array.isArray(raw.deposits)) {
        out.deposits = raw.deposits.filter((d) => d && d.status === 'open' && Number.isFinite(d.ends_at))
          .map((d) => ({ amount: Number(d.amount) || 0, endsAt: d.ends_at }));
      }
      if (raw.chain && typeof raw.chain === 'object') {
        out.chain ={ count: raw.chain.count, multiplier: raw.chain.multiplier, next: raw.chain.next, expiresAt: raw.chain.expiresAt };
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
      // 0.17.4 (user request): the Discord-message tabs list EVERY active job in the crew, not only the ones you
      // are in, so a message can be made for any of them -- yours first. `mine` keeps the sidebar pill on your own.
      if (Array.isArray(raw.crewJobs)) {
        out.crewJobsSeen = true; // crew sharing: only a real list may tell the bot that posted jobs are over
        const isMine = (x) => !!x.mine || (raw.activeJobId != null && x.id === raw.activeJobId);
        // Your own job (by `activeJobId`) is kept even if a capture leaves its status out -- the older fallback.
        const activeJobs = raw.crewJobs.filter((x) => x && (x.status === 'running' || x.status === 'planning' || (raw.activeJobId != null && x.id === raw.activeJobId)))
          .sort((a, b) => Number(isMine(b)) - Number(isMine(a)));
        out.myCrewJobs = activeJobs.map((mine) => {
          const name = mine.tierName || mine.name || null;
          const tierDef = (raw.crewJobTiers || []).find((t) => t && t.name === name) || (raw.crewJobTiers || []).find((t) => t && t.tier === mine.tier);
          return {
            id: mine.id, mine: isMine(mine), name, tier: mine.tier, minLevel: tierDef ? tierDef.level : null, status: mine.status, endsAt: mine.ends_at || null,
            roles: Array.isArray(mine.roles) ? mine.roles.slice() : [],
            members: (mine.members || []).map((m) => ({ role: m.role, name: m.name, level: m.level, ready: !!m.ready })),
            minMembers: mine.minMembers, maxMembers: mine.maxMembers,
            cut: mine.cut, take: mine.take, respect: mine.respectReward, nerve: mine.nerve, stake: mine.stake,
            chance: mine.chance != null ? mine.chance : mine.previewChance,
          };
        });
        // The soonest-ending running job drives the sidebar pill (unchanged behaviour from when there was only
        // ever one job to consider); a job still only planning has no end time to show there yet.
        const withEnd = out.myCrewJobs.filter((j) => j.mine && j.endsAt).sort((a, b) => a.endsAt - b.endsAt);
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
            perkOn: !!c.perkOn, perkStartsAt: c.perkStartsAt || null, perkShares: Number.isFinite(c.perkShares) ? c.perkShares : null,
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
      // Every piece of a crime's success "bonus", which the game only hands over already added up (user request,
      // 0.17.7: "we need to see where each % is coming from"). `crimes` limits a piece to those crimes (the game's
      // own crime ids, e.g. "fish"/"rooftop"); null = every crime. The Crew > Perks "Inside line" ranks aren't in
      // this response, so that piece is added when drawing, from the Crew page read.
      out.crimeBonusParts = [];
      const addPart = (label, v, crimes) => { if (Number.isFinite(v) && v) out.crimeBonusParts.push({ label, v, crimes: crimes || null }); };
      const streetSense = ((raw.merits && raw.merits.lines) || []).find((l) => l && l.name === 'Street sense');
      if (streetSense) addPart('Street sense', streetSense.ranks);
      (raw.courses || []).forEach((c) => {
        if (!c || c.status !== 'completed') return;
        // Only a course's success-chance adds: its other `add` mods (heat per crime, say) are left out by checking
        // that it is either tied to named crimes or its perk text talks about success chance.
        (c.mods || []).forEach((m) => {
          if (m && Number.isFinite(m.add) && (Array.isArray(m.crimes) || /success chance/i.test(c.perk || ''))) addPart(c.name, m.add, Array.isArray(m.crimes) ? m.crimes : null);
        });
      });
      ((raw.stocks && raw.stocks.companies) || []).forEach((c) => {
        const m = c && c.perkOn && String(c.perk || '').match(/\+(\d+)\s*points?\s+to\s+every\s+crime/i);
        if (m) addPart(c.name + ' shares', +m[1]);
      });
      (raw.perks || []).forEach((p) => {
        if (!p || !p.owned) return;
        const m = String(p.description || '').match(/\+(\d+)\s*(?:points?\s+)?on\s+(.+?)\.?$/i);
        if (!m) return;
        addPart(p.name, +m[1], /every crime/i.test(m[2]) ? null : [norm(m[2].replace(/['’]s success chance$/i, ''))]);
      });
      if (raw.crew && raw.crew.buffActive) addPart('crew chain', 5);
      // Whiskers & Co.'s own buy price and sell-back price for every item, keyed by the game's own item id (the
      // same id that a trading listing's `item` field uses -- confirmed by matching real listings in the user's
      // own data to store items by name: "tuna"/"bandages"/"vetpass" listings line up with Premium tuna/
      // Bandages/Vet discharge note at exactly their store prices; `inventory`'s own item ids confirm the rest,
      // e.g. "jacket"/"baton"/"catnip"/"collar"). Gear (weapons/armor) is added the same way.
      // Sell-back: crime-drop collectibles ("Lucky fish bone", "Dockside pearl") use `sellPrice`; a game update
      // on 2026-10-01 added genuine sell-back to regular store items too (seen so far on Premium tuna and
      // Catnip tea specifically), under a *different* field name, `sellBack` -- both are checked. That same
      // update also made those two items' own buy `price` swing hourly within a stated `priceRange`, around a
      // `reference_price` (its exact midpoint in both cases seen), until `priceUntil` -- not a static catalog
      // price for everything any more, just read fresh every time, same as before.
      out.storeItems = {};
      // The game's `price` and `priceRange` ALREADY have your store discount taken off (0.22.0 fix, confirmed on the
      // 2026-10-03 capture: with Staff discount, marketRate 0.85, Ball of yarn's price is 77 against a
      // reference_price of 90, Bandages 170 vs 200; Catnip tea's range 340-850 is 400-1,000 x 0.85). So `price` is
      // what you pay. `base`/`baseMin`/`baseMax` are the normal prices, for showing the normal range and for Discord
      // posts. An item counts as discounted when its reference price x marketRate gives the game's price (tools and
      // weapons are not discounted). Undo: the smallest whole price that rounds to the game's figure.
      const rate = raw.modifiers && Number.isFinite(raw.modifiers.marketRate) && raw.modifiers.marketRate > 0 && raw.modifiers.marketRate < 1 ? raw.modifiers.marketRate : 1;
      const undo = (v) => (Number.isFinite(v) ? Math.ceil((v - 0.5) / rate - 1e-9) : null);
      const normal = (it) => {
        const range = Array.isArray(it.priceRange) && it.priceRange.length === 2 ? it.priceRange : null;
        const ref = Number.isFinite(it.reference_price) ? it.reference_price : null;
        const disc = rate < 1 && ref != null && (range ? Math.abs((range[0] + range[1]) / 2 - ref * rate) <= 1 : it.price !== ref && Math.round(ref * rate) === it.price);
        return {
          range, disc,
          base: disc ? (range ? undo(it.price) : ref) : it.price,
          baseMin: range ? (disc ? undo(range[0]) : range[0]) : null,
          baseMax: range ? (disc ? undo(range[1]) : range[1]) : null,
        };
      };
      // min/max/until only exist on items whose price moves hourly.
      (raw.items || []).forEach((it) => {
        if (!it || it.id == null) return;
        const n = normal(it);
        out.storeItems[it.id] = {
          name: it.name, price: it.price, sellPrice: it.sellPrice != null ? it.sellPrice : it.sellBack,
          min: n.range ? n.range[0] : null, max: n.range ? n.range[1] : null, until: it.priceUntil || 0,
          disc: n.disc, base: n.base, baseMin: n.baseMin, baseMax: n.baseMax,
        };
      });
      (raw.gear || []).forEach((g) => { if (g && g.id != null && out.storeItems[g.id] == null) out.storeItems[g.id] = { name: g.name, price: g.price, sellPrice: g.sellPrice != null ? g.sellPrice : g.sellBack }; });
      // For the Whiskers & Co. page itself: every store item's price (what you pay), plus -- for the ones whose
      // price moves hourly (Premium tuna and Catnip tea) -- the game's `priceRange`, `reference_price` and
      // `priceUntil` (on the hour), and the normal (undiscounted) price and range from above.
      out.shopItems = (raw.items || []).filter((it) => it && it.name && Number.isFinite(it.price)).map((it) => {
        const n = normal(it);
        return {
          name: it.name, price: it.price, ref: Number.isFinite(it.reference_price) ? it.reference_price : null,
          min: n.range ? n.range[0] : null, max: n.range ? n.range[1] : null, until: it.priceUntil || 0,
          disc: n.disc, base: n.base, baseMin: n.baseMin, baseMax: n.baseMax,
        };
      });
      // Everything that can make store consumables cheaper. `modifiers.marketRate` is the game's own combined
      // price multiplier (1 = no discount; the 15% Staff discount would make it 0.85). The named sources are
      // found by their own description text ("Market consumables cost 15% less." on a job perk, "... and
      // market consumables cost 5% less" on a course), so a new one written the same way is picked up too.
      if (raw.modifiers && Number.isFinite(raw.modifiers.marketRate)) out.marketRate = raw.modifiers.marketRate;
      if (raw.weekly && Number.isFinite(raw.weekly.resetAt)) out.weeklyResetAt = raw.weekly.resetAt; // for the cat clock's tooltip
      const pctLess = (text) => { const m = String(text || '').match(/market consumables cost (\d+)% less/i); return m ? Number(m[1]) : null; };
      (raw.perks || []).forEach((p) => {
        const pct = p && pctLess(p.description);
        if (pct) out.marketDiscounts.push({ name: p.name, from: (p.job ? p.job.charAt(0).toUpperCase() + p.job.slice(1) + ' ' : '') + 'job perk', pct, owned: !!p.owned });
      });
      (raw.courses || []).forEach((c) => {
        const pct = c && pctLess(c.perk);
        if (pct) out.marketDiscounts.push({ name: c.name, from: 'course', pct, owned: c.status === 'completed' });
      });
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
    if (ex) { apiState = ex; schedule(); shareCrew(); } // nothing in the DOM changed, so redraw by hand to pick up the new numbers
  }

  function installApiWatch() {
    const pathOf = (url) => { try { return new URL(url, location.href).pathname; } catch (e) { return ''; } };
    // /api/state everywhere; /api/merits is what the Merits page itself loads (for the hidden feats, 0.22.0).
    // /api/players is the Players page's own list of every cat (0.25.0, the "No crew" list).
    const HANDLERS = { '/api/state': onApiStateResponse, '/api/merits': onMeritsResponse, '/api/players': onPlayersResponse };
    const realFetch = pageWin.fetch;
    if (typeof realFetch === 'function') {
      pageWin.fetch = function (...args) {
        const p = realFetch.apply(this, args);
        p.then((res) => {
          try { const h = res && res.url && HANDLERS[pathOf(res.url)]; if (h) res.clone().json().then(h).catch(() => {}); } catch (e) { /* ignore */ }
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
          try { const h = this.__msxUrl && HANDLERS[pathOf(this.__msxUrl)]; if (h && this.responseText) h(JSON.parse(this.responseText)); } catch (e) { /* ignore */ }
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
  // At 80 heat and up a district pays half the XP and turns no clean job at all. The game's text says "above 80",
  // but the user saw a district still hot at exactly 80 (2026-10-02), so 80 counts; the game's own `hot` flag wins
  // whenever its data has been seen.
  const HOT_HEAT = 80;
  function score(c, chain, heat) {
    const hot = (c.api && c.api.hot) || (heat != null && heat >= HOT_HEAT);
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
    if (!db.shopPrices) db.shopPrices = {};
    delete db.pageScans; // page capture was removed in 0.18.0; drop any old captures from storage
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
      .msx-odds summary { display:inline-block; cursor:pointer; list-style:none; user-select:none; }
      .msx-odds summary::-webkit-details-marker { display:none; }
      .msx-odds summary::before { content:'▸ '; }
      .msx-odds[open] summary::before { content:'▾ '; }
      .msx-odds summary { color:#9ecbff; font-weight:600; }
      .msx-odds summary:hover { color:#cfe5ff; text-decoration:underline; }
      .msx-heatlock { flex-basis:100%; display:flex; align-items:center; flex-wrap:wrap; gap:6px; color:var(--ms-smoke, #8d9289); font-size:11.5px; }
      .msx-heatlock.locked { color:var(--ms-red, #eb6561); font-weight:600; }
      .msx-heatlock button { padding:2px 8px; border-radius:6px; cursor:pointer; font-size:11px; font-family:inherit; font-weight:600; width:auto; min-height:0;
        color:var(--ms-bone, #e7ede1); background:rgba(0,0,0,.25); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      .msx-heatlock button:hover { border-color:var(--ms-lime, #b4df87); }
      button.msx-heat-locked { opacity:.4; cursor:not-allowed !important; }
      .msx-odds .msx-odds-body { margin-top:2px; }
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
      a.xr-screen.msx-low { outline:2px solid var(--ms-lime, #b4df87); outline-offset:-2px; }
      a.xr-screen.msx-high { outline:2px solid var(--ms-red, #eb6561); outline-offset:-2px; }
      a.xr-screen .msx-price-low { color:var(--ms-lime, #b4df87) !important; }
      a.xr-screen .msx-price-high { color:var(--ms-red, #eb6561) !important; }
      a.xr-screen .msx-price-mid { color:#fff !important; }
      .msx-stock.msx-stock-card { flex-basis:100%; width:100%; margin:0; padding-top:6px; border-top:1px dashed var(--ms-line, rgba(231,237,225,.15)); }
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
      #msx-nocrew { margin:0 0 12px; padding:8px 14px; border-radius:12px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); color:var(--ms-bone, #e7ede1); font-size:13px; }
      #msx-nocrew summary { cursor:pointer; font-weight:700; }
      #msx-nocrew small, #msx-nocrew .msx-nc-note { color:var(--ms-smoke, #8d9289); font-weight:400; }
      #msx-nocrew .msx-nc-note { margin:6px 0; font-size:12px; }
      #msx-nocrew ul { margin:6px 0 2px; padding-left:18px; max-height:260px; overflow-y:auto; line-height:1.6; }
      #msx-nocrew .msx-nc-on { color:var(--ms-lime, #b4df87); }
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
      #msx-mycrewjob .msx-postbtn { margin-left:8px; }
      .msx-gymlock { display:block; width:fit-content; margin-top:8px; padding:4px 10px; border-radius:8px; cursor:pointer;
        font-size:12px; font-family:inherit; color:var(--ms-bone, #e7ede1); background:rgba(0,0,0,.25);
        border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      .msx-gymlock:hover { border-color:var(--ms-lime, #b4df87); }
      .msx-gymlock.locked { color:var(--ms-red, #eb6561); border-color:var(--ms-red, #eb6561); background:rgba(235,101,97,.12); }
      button.msx-train-locked { opacity:.45; cursor:not-allowed !important; }
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
      #msx-trading .msx-stale { color:var(--ms-gold, #e9c46a); }
      .right-column #msx-mycrewjob { margin:16px 0 0; }
      #msx-chainpost { margin:16px 0 0; }
      #msx-chainmode { margin:0 0 12px; padding:8px 12px; border-radius:10px; font-size:13px; font-weight:600; color:var(--ms-lime, #b4df87);
        background:rgba(180,223,135,.08); border:1px solid rgba(180,223,135,.35); }
      .msx-heatlock button.msx-chain-toggle, .msx-heatlock button.msx-heat-toggle { margin-left:2px; }
      .msx-feat-how { margin-top:3px; font-size:12px; color:var(--ms-lime, #b4df87); }
      .msx-feat-how b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      #msx-chainpost button { width:100%; padding:8px 12px; border-radius:8px; cursor:pointer; color:var(--ms-bone, #e7ede1); font-size:13px; font-family:inherit; font-weight:600;
        background:rgba(0,0,0,.28); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      #msx-chainpost button:hover { border-color:var(--ms-lime, #b4df87); }
      .right-column #msx-mycrewjob textarea { min-height:220px; }
      #msx-trading .msx-trade-key { padding-left:18px; font-size:12px; line-height:1.5; }
      #msx-trading .msx-trade-key b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      .msx-ws { display:flex; flex-direction:column; gap:2px; margin-top:6px; padding:6px 8px; border-radius:8px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); font-size:11.5px; line-height:1.35; color:var(--ms-smoke, #8d9289); font-weight:400; }
      .msx-ws b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      .msx-ws .msx-ws-disc b { color:var(--ms-lime, #b4df87); }
      .msx-ws .msx-ws-deal { align-self:flex-start; margin-top:4px; padding:2px 8px; border-radius:6px; cursor:pointer; font-size:11px; font-family:inherit; font-weight:600; width:auto; min-height:0; color:var(--ms-bone, #e7ede1); background:rgba(0,0,0,.25); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      .msx-ws .msx-ws-deal:hover { border-color:#9ecbff; }
      .rung .tool-line > span.msx-tool-link { cursor:pointer; }
      .rung .tool-line > span.msx-tool-link:hover { border-color:#9ecbff; text-decoration:underline; }
      .ws-row.msx-ws-focus { outline:2px solid var(--ms-lime, #b4df87); outline-offset:4px; border-radius:10px; transition:outline-color .4s; }
      .sidebar .brand:has(.msx-clock) { min-width:0; }
      .sidebar .brand:has(.msx-clock) .brand-logo { flex:0 1 auto; min-width:0; }
      .msx-clock { display:inline-flex; flex:none; color:var(--ms-lime, #b4df87); cursor:default; }
      .msx-clock-row { margin:2px 0 6px; text-align:center; font-size:11px; color:var(--ms-smoke, #8d9289); font-variant-numeric:tabular-nums; white-space:nowrap; cursor:default; }
      a.msx-pill-link { text-decoration:none; color:var(--ms-bone, #e7ede1); cursor:pointer; }
      a.msx-pill-link:hover { border-color:var(--ms-lime, #b4df87); }
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
      #msx-toast { position:fixed; right:12px; bottom:calc(56px + env(safe-area-inset-bottom, 0px)); z-index:9999; max-width:min(360px, calc(100vw - 24px));
        padding:10px 12px; border-radius:10px; background:var(--ms-asphalt, #1c201c); color:var(--ms-bone, #e7ede1);
        border:1px solid var(--ms-lime, #b4df87); font-size:12px; line-height:1.4; opacity:0; pointer-events:none; transition:opacity .2s; }
      #msx-toast.show { opacity:1; }
    `;
    document.head.appendChild(s);
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
    return oddsDetails(c.key, title.replace(/"/g, '&quot;'), `${bits.join(' ')} ${end}`);
  }

  // The breakdown sits folded away behind a small "Odds" toggle (user request, 0.17.4: the always-open line was
  // too big). Cards are redrawn often, so which ones you opened is remembered for as long as the page is open.
  const oddsOpen = new Set();
  function oddsDetails(key, title, inner) {
    return `<details class="msx-odds" data-key="${key}"${oddsOpen.has(key) ? ' open' : ''}>` +
      `<summary>Odds</summary><div class="msx-odds-body" title="${title}">${inner}</div></details>`;
  }
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.classList || !d.classList.contains('msx-odds')) return;
    if (d.open) oddsOpen.add(d.dataset.key); else oddsOpen.delete(d.dataset.key);
  }, true);

  function oddsHtmlFromApi(c) {
    const a = c.api;
    const heatPts = Math.floor((a.heat || 0) / 4);
    const fmt = (v) => (v < 0 ? '−' : '+') + Math.abs(v);
    const bits = [`${a.baseChance} base`];
    if (a.masteryBonus) bits.push(`${fmt(a.masteryBonus)} mastery`);
    if (a.bonus) {
      // The game's one combined bonus, split into its pieces. Whatever the known pieces don't explain is shown as
      // "other", so the line always adds up to the game's own number.
      const forThis = (p) => !p.crimes || p.crimes.some((k) => k === a.id || c.key.startsWith(norm(k)));
      const parts = ((apiState && apiState.crimeBonusParts) || []).filter(forThis).map((p) => ({ label: p.label, v: p.v }));
      const inside = loadDb().mods?.crewPerkCrime;
      if (apiState && apiState.crew && inside) parts.push({ label: 'Inside line', v: inside });
      const other = a.bonus - parts.reduce((s, p) => s + p.v, 0);
      parts.forEach((p) => bits.push(`${fmt(p.v)} ${escHtml(p.label)}`));
      if (other) bits.push(`<span class="msx-unk" title="Part of the game's bonus that none of the known sources explain">${fmt(other)} other</span>`);
    }
    if (heatPts) bits.push(`${fmt(-heatPts)} heat`);
    const sum = a.baseChance + (a.masteryBonus || 0) + (a.bonus || 0) - heatPts;
    const capped = a.chance === 95 && sum > 95;
    const end = capped ? `= ${sum} → capped at 95%` : `= ${a.chance}%`;
    const crew = apiState && apiState.crew;
    const crewNote = crew && crew.buffActive && crew.buffUntil > Date.now()
      ? ` The crew +5% window ends in ${Math.max(1, Math.round((crew.buffUntil - Date.now()) / 60000))} min (${new Date(crew.buffUntil).toUTCString().slice(17, 22)} UTC).` : '';
    const critNote = a.criticalChance != null ? ` Clean-job chance: ${a.criticalChance}%.` : '';
    const title = ('Exact numbers from the game\'s own data: base success + mastery bonus + bonus (merits, education, crew and perks, already combined by the game) − 1 per 4 heat, capped at 95%.' + crewNote + critNote).replace(/"/g, '&quot;');
    return oddsDetails(c.key, title, `${bits.join(' ')} ${end}`);
  }

  function dropsHtml(c) {
    const d = CRIMES[c.key]?.drops;
    if (!d) return '';
    return `<div class="msx-drops" title="Clean jobs drop the common item. About 1 in 100 clean jobs also drops the district rare, which only comes from this source.">` +
      `Clean-job drops: <b>${d.common}</b> · rare (~1%): <b>${d.rare}</b></div>`;
  }

  // ─── Heat lock (Crimes page) ──────────────────────────────────────────────
  // User request (0.17.7): at 80 heat and up (half XP, no clean jobs) a crime's own Attempt button is disabled
  // until the district cools to 79, with an "Unlock anyway" button per district. Same idea as the Cat Tree lock:
  // the script never clicks or attempts anything, it only blocks your own click. Button from a dev-tools capture
  // (Screenshot 338): article.rung > div.rung-main > button.accent. An override lasts until the district cools.
  const HEAT_OVERRIDE_KEY = 'ms_heat_override_v1';
  function loadHeatOverrides() { try { return JSON.parse(GM_getValue(HEAT_OVERRIDE_KEY, '{}')) || {}; } catch (e) { return {}; } }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.msx-heat-toggle');
    if (!b) return;
    const o = loadHeatOverrides();
    if (o[b.dataset.district]) delete o[b.dataset.district]; else o[b.dataset.district] = true;
    GM_setValue(HEAT_OVERRIDE_KEY, JSON.stringify(o));
    schedule();
  });
  function applyHeatLock(c, hot, heat, box, overrides) {
    const btn = c.card.querySelector('.rung-main > button.accent');
    if (!btn) return;
    const locked = hot && !overrides[c.district];
    if (locked) { if (!btn.disabled) btn.disabled = true; btn.classList.add('msx-heat-locked'); }
    else if (btn.classList.contains('msx-heat-locked')) { btn.classList.remove('msx-heat-locked'); if (!btn.classList.contains('msx-chain-locked')) btn.disabled = false; }
    if (!hot) return;
    const mins = heat != null ? Math.max(0, heat - (HOT_HEAT - 1)) * 5 : 0; // cools 1 point per 5 minutes
    const when = mins ? ` · unlocks in ~${mins >= 60 ? Math.floor(mins / 60) + 'h ' : ''}${mins % 60}m` : '';
    const note = document.createElement('div');
    note.className = 'msx-heatlock' + (locked ? ' locked' : '');
    note.innerHTML = (locked ? `🔒 Heat ${heat != null ? heat : '80+'}: half XP, Attempt locked${when}` : '🔓 Hot, unlocked by you') +
      ` <button type="button" class="msx-heat-toggle" data-district="${escHtml(c.district)}">${locked ? 'Unlock anyway' : 'Lock again'}</button>`;
    box.prepend(note);
  }

  // ─── Tool chips -> Whiskers & Co. (Crimes page) ───────────────────────────
  // User request (0.18.1): clicking a crime's tool chip ("Fake manifest none", "Crowbar ×1") opens Whiskers & Co.
  // and scrolls to that tool. Your own click, a plain page change. Chip from a dev-tools capture (Screenshot 339):
  // article.rung > div.rung-main > div.tool-line > span (class "missing" when you own none).
  document.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('.rung .tool-line > span');
    if (!chip) return;
    const name = chip.textContent.replace(/\s*(none|×\s*\d+|x\s*\d+)\s*$/i, '').trim();
    location.assign('/whiskers' + (name ? '#msx-item=' + encodeURIComponent(name) : ''));
  });
  function decorateToolChips() {
    document.querySelectorAll('.rung .tool-line > span').forEach((chip) => {
      if (!chip.classList.contains('msx-tool-link')) chip.classList.add('msx-tool-link');
      setTitle(chip, 'Open Whiskers & Co. to buy this tool');
    });
  }

  function draw(data) {
    clearDrawn();
    decorateToolChips();
    // An "Unlock anyway" ends once its district has cooled below 80.
    const overrides = loadHeatOverrides();
    let overridesChanged = false;
    Object.keys(overrides).forEach((d) => { if (data.heat[d] != null && data.heat[d] < HOT_HEAT) { delete overrides[d]; overridesChanged = true; } });
    if (overridesChanged) GM_setValue(HEAT_OVERRIDE_KEY, JSON.stringify(overrides));
    // Chain mode: "Unlock anyway" picks only last while it stays on.
    const chainMode = chainModeState();
    let chainOverrides = loadChainOverrides();
    if (!chainMode && Object.keys(chainOverrides).length) { chainOverrides = {}; clearChainOverrides(); }
    ensureChainModeBanner(chainMode);
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
          parts.push('<span class="msx-tag hot" title="At 80 heat and up this district pays half the XP and turns no clean job. The XP/n above already reflects that.">Heat 80+: ½ XP, no clean</span>');
        } else {
          const n = Math.ceil((HOT_HEAT - h0) / 6); // attempts until heat reaches 80 (+6 heat each)
          if (n <= 8) parts.push(`<small title="Attempts until this district's heat reaches 80 (half XP, no clean jobs)">Heat 80 in ${n} attempt${n === 1 ? '' : 's'}</small>`);
        }
      }
      if (x === bestXp) parts.push('<span class="msx-tag xp">★ Best XP</span>');
      if (x === bestCash) parts.push('<span class="msx-tag cash">★ Best $</span>');
      const oddsBlock = c.api ? oddsHtmlFromApi(c) : oddsHtml(c, data.heat[c.district], loadDb().mods || {});
      box.innerHTML = (parts.join('') || '<small>No data yet</small>') + oddsBlock + dropsHtml(c);
      host.appendChild(box);
      applyHeatLock(c, s.hot, h0, box, overrides);
      applyChainModeLock(c, box, chainMode, chainOverrides);

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
  const DEFAULT_SETTINGS = { events: true, shareCrew: false };
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(GM_getValue(SETTINGS_KEY, 'null'));
    if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) { /* use the defaults */ }
  function saveSettings() {
    try { GM_setValue(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // ─── Crew sharing with the crew's Discord bot (opt-in, 0.19.0) ────────────
  // OFF unless you tick "Share crew info with our crew's Discord bot" on the Account page. When on, each time the
  // game's own /api/state passes by, a small summary goes to the crew bot's server: crew name, crew chain count
  // and end time, and the crew's active jobs (seats, members' names/levels, payout) -- the same things the Crew
  // page and the "Copy for Discord" message already show. Never your account, cash, email or messages. Nothing is
  // ever sent to MeowStreets itself. The bot ignores every crew but its own.
  const CREW_BOT_URL = 'http://168.138.79.225:3001/v1/crew';
  const CREW_BOT_DEAL_URL = 'http://168.138.79.225:3001/v1/deal'; // the 📣 beside Whiskers items
  const CREW_BOT_CHAIN_URL = 'http://168.138.79.225:3001/v1/chain'; // the ⛓️ button on the Crew page
  const CREW_BOT_FEATS_URL = 'http://168.138.79.225:3001/v1/feats'; // hidden feats found by the crew (Merits page)
  const CHAIN_FRESH_MS = 2 * 60000; // chain info older than this is never posted (the bot checks again)
  const SHARE_MIN_GAP_MS = 15000; // at most one update every 15 seconds
  const SHARE_ID_KEY = 'ms_share_id_v1';
  // Sharing is only for one crew (user request, 0.22.0): the game's own crew id must be 2 (Pirate Cats). Anyone
  // else never sees the sharing switch or the Discord buttons, and nothing is sent. The bot checks the id too.
  const SHARE_CREW_ID = 2;
  const inShareCrew = () => !!(apiState && apiState.crew && apiState.crew.id === SHARE_CREW_ID);
  const sharingOn = () => !!settings.shareCrew && inShareCrew();
  // Crew chain mode (0.23.0): leadership turns it on in Discord; the bot's reply to every crew update says
  // { on, min }. Kept with when it was heard, and trusted for 30 minutes (then the locks lift by themselves).
  const CHAIN_MODE_KEY = 'ms_chain_mode_v1';
  const CHAIN_MODE_TTL_MS = 30 * 60000;
  const CHAIN_OVERRIDE_KEY = 'ms_chain_override_v1'; // { [crimeKey]: true } "Unlock anyway", cleared when it turns off
  let shareLastSig = '', shareLastAt = 0, shareTimer = null;

  // A random id for this install only (lets the bot slow down one noisy sender); not tied to your game account.
  function shareId() {
    let v = GM_getValue(SHARE_ID_KEY, '');
    if (!v) {
      v = 'ms-' + Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8)).join('');
      GM_setValue(SHARE_ID_KEY, v);
    }
    return v;
  }

  function crewSharePayload() {
    if (!apiState || !apiState.crew || !apiState.crew.name) return null;
    const c = apiState.crew;
    // seenAt = when the game delivered this data. It changes on every game update, so the bot also hears "someone is
    // live" while nothing else changed -- the chain alert only fires on info the game confirmed in the last 2 minutes.
    const body = { v: 1, sender: shareId(), crew: { name: c.name, id: c.id, chain: c.chain, chainEndsAt: c.chainEndsAt, seenAt: apiState.at } };
    if (apiState.crewJobsSeen) {
      body.jobs = (apiState.myCrewJobs || []).map((j) => ({
        id: j.id, name: j.name, tier: j.tier, minLevel: j.minLevel, status: j.status, roles: j.roles,
        members: (j.members || []).map((m) => ({ role: m.role, name: m.name, level: m.level })),
        minMembers: j.minMembers, maxMembers: j.maxMembers, endsAt: j.endsAt,
        cut: j.cut, take: j.take, respect: j.respect, nerve: j.nerve, stake: j.stake, chance: j.chance,
      }));
      body.roleTitles = apiState.crewJobRoles || {};
    }
    return body;
  }

  function sendToCrewBot(body, done) {
    if (typeof GM_xmlhttpRequest !== 'function') { if (done) done({ ok: false, error: 'Tampermonkey blocked the request' }); return; }
    GM_xmlhttpRequest({
      method: 'POST', url: CREW_BOT_URL, data: JSON.stringify(body), timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      onload: (r) => {
        let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* not json */ }
        if (j && j.chainMode && typeof j.chainMode === 'object') {
          const m = { on: !!j.chainMode.on, min: Number(j.chainMode.min) || 90, type: j.chainMode.type === 'grow' ? 'grow' : 'pct', heard: Date.now() };
          const old = GM_getValue(CHAIN_MODE_KEY, null);
          GM_setValue(CHAIN_MODE_KEY, m);
          if (!old || old.on !== m.on || old.min !== m.min || old.type !== m.type) schedule();
        }
        if (done) done(j || { ok: false, error: 'bad reply (' + r.status + ')' });
      },
      onerror: () => { if (done) done({ ok: false, error: 'could not reach the crew bot' }); },
      ontimeout: () => { if (done) done({ ok: false, error: 'the crew bot did not answer' }); },
    });
  }

  // Sends only when something changed, and at most once per SHARE_MIN_GAP_MS (a late change waits for the gap).
  function shareCrew() {
    if (!sharingOn()) return;
    const body = crewSharePayload();
    if (!body) return;
    const sig = JSON.stringify(body);
    if (sig === shareLastSig) return;
    const wait = shareLastAt + SHARE_MIN_GAP_MS - Date.now();
    if (wait > 0) { if (!shareTimer) shareTimer = setTimeout(() => { shareTimer = null; shareCrew(); }, wait); return; }
    shareLastSig = sig; shareLastAt = Date.now();
    sendToCrewBot(body);
  }

  // ─── Shared stock prices (crew pool, 0.20.0) ──────────────────────────────
  // Same switch as above. Your own recorded prices (one per company per 15-minute period) go to the crew pool, and
  // every price the crew has that you don't comes back and is merged into your history, marked src:'crew'. So the
  // lows, highs, averages and LOW/HIGH calls on Claw Street Ex are worked out from the whole crew's history.
  // Your own reading always wins over a pooled one for the same period. Stock prices are the same for everyone.
  const STOCK_POOL_URL = 'http://168.138.79.225:3001/v1/stocks';
  const STOCK_SYNC_KEY = 'ms_stock_sync_v1'; // { since: last pooled period already merged }
  const STOCK_SYNC_GAP_MS = 5 * 60000; // at most every 5 minutes (prices move every 15)
  const STOCK_SEND_MAX = 2000; // a long backlog goes up in chunks
  let stockSyncAt = 0, stockSyncBusy = false;

  function syncStocks(force) {
    if (!sharingOn() || stockSyncBusy || !apiState.crew.name) return;
    if (typeof GM_xmlhttpRequest !== 'function') return;
    if (!force && Date.now() - stockSyncAt < STOCK_SYNC_GAP_MS) return;
    const out = [];
    Object.entries(loadDb().stocks).forEach(([id, rec]) => (rec.obs || []).forEach((o) => {
      const p = periodOf(o);
      if (p != null && o.src !== 'crew' && !o.x && out.length < STOCK_SEND_MAX) out.push([id, p, o.price]);
    }));
    let sync = {};
    try { sync = JSON.parse(GM_getValue(STOCK_SYNC_KEY, '{}')) || {}; } catch (e) { sync = {}; }
    stockSyncAt = Date.now();
    stockSyncBusy = true;
    GM_xmlhttpRequest({
      method: 'POST', url: STOCK_POOL_URL, timeout: 20000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 1, sender: shareId(), crew: { name: apiState.crew.name, id: apiState.crew.id }, prices: out, since: Number.isInteger(sync.since) ? sync.since : null }),
      onload: (r) => {
        stockSyncBusy = false;
        let j = null;
        try { j = JSON.parse(r.responseText); } catch (e) { return; }
        if (!j || !j.ok) return;
        const db = loadDb();
        // Mark what was sent, so it isn't sent again.
        const sent = new Set(out.map((e) => e[0] + ':' + e[1]));
        Object.entries(db.stocks).forEach(([id, rec]) => (rec.obs || []).forEach((o) => { if (o.src !== 'crew' && sent.has(id + ':' + periodOf(o))) o.x = 1; }));
        // Merge the crew's prices: fill periods you don't have; never overwrite your own reading.
        const now = new Date().toISOString();
        Object.entries(j.prices || {}).forEach(([id, list]) => {
          if (!Array.isArray(list)) return;
          const rec = db.stocks[id] || (db.stocks[id] = { name: id, obs: [] });
          const byP = new Map(rec.obs.map((o) => [periodOf(o), o]));
          list.forEach(([p, price]) => {
            if (!Number.isInteger(p) || !(price > 0)) return;
            const have = byP.get(p);
            if (!have) { const o = { t: now, p, price, delta: 0, src: 'crew' }; rec.obs.push(o); byP.set(p, o); } else if (have.src === 'crew' && have.price !== price) have.price = price;
          });
          rec.obs.sort((a, b) => (periodOf(a) ?? 0) - (periodOf(b) ?? 0));
          while (rec.obs.length > MAX_STOCK_TICKS) rec.obs.shift();
        });
        db.updated = now;
        saveDb(db);
        GM_setValue(STOCK_SYNC_KEY, JSON.stringify({ since: j.upTo }));
        // A big backlog either way? Carry on after the bot's one-a-minute limit.
        if (j.more || out.length >= STOCK_SEND_MAX) setTimeout(() => syncStocks(true), 65000);
        schedule();
      },
      onerror: () => { stockSyncBusy = false; },
      ontimeout: () => { stockSyncBusy = false; },
    });
  }

  // The "📣 Post to Discord" button: sends the current crew info plus which job to post.
  function postJobToDiscord(jobId) {
    if (!sharingOn()) { toast('Not posted: sharing is only for crew members with sharing switched on.'); return; }
    const body = crewSharePayload();
    if (!body) { toast('No crew info yet. Open the Crew page once it has loaded.'); return; }
    body.post = jobId;
    shareLastSig = JSON.stringify({ ...body, post: undefined }); shareLastAt = Date.now();
    sendToCrewBot(body, (r) => {
      const p = r && r.post;
      if (r && r.ok && p && p.ok) toast(p.already ? 'Already posted. The bot keeps that post up to date.' : 'Posted to Discord. It will update as people join.');
      else toast('Not posted: ' + ((p && p.error) || (r && r.error) || 'unknown problem') + '.');
    });
  }

  // ⛓️ Post chain (0.21.0, replaced the bot's automatic 1-minute ping): the bot posts "Crew chain ×N ends in …" as a
  // Discord countdown. Only from game info under 2 minutes old -- the script never asks the game for fresh data
  // itself (read-only rule), so stale info means "refresh the page".
  function postChainToDiscord() {
    const c = apiState && apiState.crew;
    if (!sharingOn()) { toast('Not posted: sharing is only for crew members with sharing switched on.'); return; }
    const ageMs = Date.now() - apiState.at;
    if (ageMs > CHAIN_FRESH_MS) { toast('Not posted: the chain info is over 2 minutes old. Refresh the page, then try again.'); return; }
    if (!c.chainEndsAt || c.chainEndsAt <= Date.now()) { toast('Not posted: the chain has already ended.'); return; }
    const body = { v: 1, sender: shareId(), crew: { name: c.name, id: c.id, chain: c.chain, chainEndsAt: c.chainEndsAt, seenAt: apiState.at }, ageMs };
    if (typeof GM_xmlhttpRequest !== 'function') { toast('Not posted: Tampermonkey blocked the request.'); return; }
    GM_xmlhttpRequest({
      method: 'POST', url: CREW_BOT_CHAIN_URL, data: JSON.stringify(body), timeout: 15000, headers: { 'Content-Type': 'application/json' },
      onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (err) { /* not json */ } toast(j && j.ok ? 'Chain posted to Discord.' : 'Not posted: ' + ((j && j.error) || 'unknown problem') + '.'); },
      onerror: () => toast('Not posted: could not reach the crew bot.'),
      ontimeout: () => toast('Not posted: the crew bot did not answer.'),
    });
  }

  // The button lives on the Crew page, right column, under "Your neighborhood" (above the crew job box), while
  // crew sharing is on.
  function ensureChainPostButton() {
    let box = document.getElementById('msx-chainpost');
    const want = sharingOn() && location.pathname.replace(/\/+$/, '') === '/crew' && apiState && apiState.crew && apiState.crew.name;
    if (!want) { if (box) box.remove(); return; }
    const hood = document.querySelector('.right-column .neighborhood');
    const host = hood ? null : document.querySelector('.main-content') || document.querySelector('main');
    if (!hood && !host) return;
    if (!box) {
      box = document.createElement('div');
      box.id = 'msx-chainpost';
      box.innerHTML = '<button type="button" title="Post the crew chain and its countdown in the crew Discord">⛓️ Post chain to Discord</button>';
      box.querySelector('button').addEventListener('click', postChainToDiscord);
    }
    if (hood) { if (hood.nextElementSibling !== box) hood.after(box); } else if (host.firstElementChild !== box) host.prepend(box);
  }

  // ─── Hidden feats (Merits page, 0.22.0) ───────────────────────────────────
  // The game sends a hidden feat as just { id, hidden: true } until you earn it. Crew members (crew 2, sharing on)
  // send the feats they HAVE earned (id, name, how to get it) to the crew bot and get back every one the crew has
  // found, so a hidden feat on your Merits page can show how to get it. Nothing about who found it.
  let meritFeats = null; // [{ id, name, criteria, hidden, held }] from the last /api/merits seen
  const FEAT_POOL_KEY = 'ms_feat_pool_v1'; // { [featId]: { name, criteria } } from the crew bot
  const FEAT_SYNC_GAP_MS = 10 * 60000;
  let featSyncAt = 0, featSyncSig = '';

  function onMeritsResponse(json) {
    if (!json || !Array.isArray(json.feats)) return;
    meritFeats = json.feats.filter((f) => f && f.id != null).map((f) => ({
      id: String(f.id), name: typeof f.name === 'string' ? f.name : null, criteria: typeof f.criteria === 'string' ? f.criteria : null,
      hidden: !!f.hidden, held: !!f.held,
    }));
    syncFeats();
    schedule();
  }

  function syncFeats() {
    if (!meritFeats || !sharingOn() || typeof GM_xmlhttpRequest !== 'function') return;
    // Only feats you hold, with their text. Non-hidden ones are sent too: once earned, the game may no longer
    // mark a hidden feat as hidden, so there is no telling them apart. All of it is on everyone's Merits page anyway.
    const mine = meritFeats.filter((f) => f.held && f.name && f.criteria).map((f) => ({ id: f.id, name: f.name, criteria: f.criteria }));
    const sig = mine.map((f) => f.id).join(',');
    if (sig === featSyncSig && Date.now() - featSyncAt < FEAT_SYNC_GAP_MS) return;
    featSyncSig = sig; featSyncAt = Date.now();
    GM_xmlhttpRequest({
      method: 'POST', url: CREW_BOT_FEATS_URL, timeout: 15000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 1, sender: shareId(), crew: { name: apiState.crew.name, id: apiState.crew.id }, feats: mine }),
      onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* not json */ } if (j && j.ok && j.feats && typeof j.feats === 'object') { GM_setValue(FEAT_POOL_KEY, j.feats); schedule(); } },
    });
  }

  // Each hidden feat stays exactly as the game shows it ("???" / "Hidden until you earn it.") -- the page keeps
  // showing that even after you earn one (2026-10-04: "Payday" held, page still "???"), but the game's data then has
  // its name and criteria. One line is added under each: "✅ You earned this: name: criteria" for your own (from
  // your own data, works without sharing), "🔓 Crew found: criteria" for one a crewmate has earned (sharing on; the
  // name stays hidden, user request). The page lists feats in the data's order, so the Nth "Hidden until you earn
  // it." is the Nth hidden feat, earned or not (0.24.1 fix: 0.22.0 skipped earned ones, so the counts never matched
  // once anyone held one and nothing was shown). Skipped if the counts still differ.
  function drawHiddenFeats() {
    const old = document.querySelectorAll('.msx-feat-how');
    if (location.pathname.replace(/\/+$/, '') !== '/merits' || !meritFeats) { old.forEach((n) => n.remove()); return; }
    const pool = (sharingOn() && GM_getValue(FEAT_POOL_KEY, null)) || {};
    const hidden = meritFeats.filter((f) => f.hidden);
    const spots = [...document.querySelectorAll('.main-content *, main *')].filter((el) => !el.children.length && el.textContent.trim() === 'Hidden until you earn it.');
    if (spots.length !== hidden.length) { old.forEach((n) => n.remove()); return; }
    spots.forEach((el, i) => {
      const f = hidden[i];
      const mine = f.held && f.name && f.criteria;
      const found = !mine && pool[f.id] && pool[f.id].criteria ? pool[f.id] : null;
      let line = el.nextElementSibling && el.nextElementSibling.classList.contains('msx-feat-how') ? el.nextElementSibling : null;
      if (!mine && !found) { if (line) line.remove(); return; }
      if (!line) { line = document.createElement('div'); el.after(line); }
      const cls = 'msx-feat-how' + (mine ? ' mine' : '');
      if (line.className !== cls) line.className = cls;
      const html = mine
        ? `✅ You earned this: <b>${escHtml(f.name)}</b>: ${escHtml(f.criteria)}`
        : `🔓 Crew found: ${escHtml(found.criteria)}`;
      if (line.innerHTML !== html) line.innerHTML = html;
      setTitle(line, mine ? 'From your own game data (the page keeps hidden feats as ??? even once earned).' : 'Shared by a crewmate who has earned this feat (crew sharing). Not shown by the game.');
    });
  }

  // ─── "No crew" list (Players page, 0.25.0) ────────────────────────────────
  // The Players list only renders the ~15 rows on screen (each pinned to its slot), so rows can't just be hidden.
  // Instead a fold-out list above it shows every cat with no crew: from the page's own /api/players reply when the
  // script saw it (the full list), else from the rows you have scrolled past. Kept in memory for this page view
  // only, never saved or sent (other players' data). No links or whisper buttons: opening a whisper means
  // clicking the game's own chat for you.
  const noCrew = { api: null, rows: new Map() }; // api: Map id/name -> cat, or null; rows: from the rendered rows
  let noCrewOpen = false;
  const isPlayersPage = () => location.pathname.replace(/\/+$/, '') === '/players';

  // The game marks "no crew" as `crew: null` in /api/town and /api/cat (2026-10-04); /api/players is assumed to
  // match. Without a crew field at all the reply is ignored and the rendered rows are used instead.
  function onPlayersResponse(json) {
    const arr = Array.isArray(json) ? json
      : json && typeof json === 'object' ? [json.players, json.cats, json.residents, json.list, ...Object.values(json)].find(Array.isArray) : null;
    const cats = (arr || []).filter((c) => c && typeof c.name === 'string' && ('crew' in c || 'crew_id' in c));
    if (!cats.length) return;
    if (!noCrew.api) noCrew.api = new Map();
    cats.forEach((c) => {
      const crew = 'crew' in c ? c.crew : c.crew_id;
      const none = crew == null || crew === '' || (typeof crew === 'object' && !crew.name && crew.id == null);
      noCrew.api.set(String(c.id != null ? c.id : c.name), {
        name: c.name, level: Number.isFinite(c.level) ? c.level : null, rank: Number.isFinite(c.rank) ? c.rank : null,
        online: c.online === true, none,
      });
    });
    schedule();
  }

  // Rendered row (Screenshots 348–351): button.reg-hit aria-label "Mags, ID 72, rank 1, level 15, Odd Tuna Cult"
  // plus a hidden span.reg-crew holding the crew name.
  function readPlayerRows() {
    document.querySelectorAll('.reg-item button.reg-hit[aria-label]').forEach((b) => {
      const m = b.getAttribute('aria-label').match(/^(.+?), ID (\d+), rank (\d+), level (\d+)(?:, (.*))?$/);
      if (!m) return;
      const crewEl = b.closest('.reg-item').querySelector('.reg-crew');
      const crew = ((crewEl && crewEl.textContent) || m[5] || '').trim();
      noCrew.rows.set(m[2], { name: m[1], level: +m[4], rank: +m[3], online: false, none: !crew });
    });
  }

  function ensureNoCrewPanel() {
    const old = document.getElementById('msx-nocrew');
    if (!isPlayersPage()) { old?.remove(); noCrew.api = null; noCrew.rows.clear(); return; }
    const list = document.querySelector('.panel.reg');
    if (!list) return;
    readPlayerRows();
    let panel = old;
    if (!panel) {
      panel = document.createElement('details');
      panel.id = 'msx-nocrew';
      panel.open = noCrewOpen;
      panel.innerHTML = '<summary></summary><div class="msx-nc-body"></div>';
      panel.addEventListener('toggle', () => { noCrewOpen = panel.open; });
    }
    if (panel.nextElementSibling !== list) list.before(panel);
    const fromApi = !!noCrew.api;
    const all = [...(fromApi ? noCrew.api : noCrew.rows).values()];
    const cats = all.filter((c) => c.none).sort((a, b) => (b.level || 0) - (a.level || 0) || (a.rank || 1e9) - (b.rank || 1e9));
    const totalM = (document.querySelector('.panel.reg ~ .sr-only, main .sr-only[aria-live]')?.textContent || '').match(/(\d+)\s+cats/);
    const total = totalM ? +totalM[1] : null;
    const sum = `No crew: ${cats.length} cat${cats.length === 1 ? '' : 's'}` + (fromApi ? '' : ` <small>(of ${all.length}${total ? ' / ' + total : ''} checked)</small>`);
    const sumEl = panel.querySelector('summary');
    if (sumEl.innerHTML !== sum) sumEl.innerHTML = sum;
    let h = fromApi ? '' : '<p class="msx-nc-note">Scroll the list below to check more cats, or open Players from the sidebar to read the full list at once.</p>';
    h += cats.length
      ? '<ul>' + cats.map((c) => `<li>${c.online ? '<span class="msx-nc-on" title="Online">●</span> ' : ''}<b>${escHtml(c.name)}</b>` +
        `${c.level != null ? ` [${c.level}]` : ''}${c.rank != null ? ` <small>#${c.rank}</small>` : ''}</li>`).join('') + '</ul>'
      : '<p class="msx-nc-note">None found yet.</p>';
    const body = panel.querySelector('.msx-nc-body');
    if (body.innerHTML !== h) body.innerHTML = h;
  }

  // ─── Crew chain mode lock (Crimes page, 0.23.0) ───────────────────────────
  // While crew leadership has chain mode on (set in Discord, see above), every crime whose success % on its card
  // is under the threshold gets its own Attempt button disabled, like the heat lock -- the script never attempts
  // anything, it only blocks your own click. "Unlock anyway" per crime, until chain mode is turned off.
  // { type: 'pct', min } or { type: 'grow', chain } while chain mode applies to you, else null. Grow the chain
  // (0.24.0) uses the crew chain from the game's own data right now.
  function chainModeState() {
    const m = GM_getValue(CHAIN_MODE_KEY, null);
    if (!sharingOn() || !m || !m.on || Date.now() - m.heard > CHAIN_MODE_TTL_MS) return null;
    if (m.type === 'grow') {
      const chain = apiState && apiState.crew && Number.isFinite(apiState.crew.chain) ? apiState.crew.chain : null;
      return chain == null ? null : { type: 'grow', chain };
    }
    return { type: 'pct', min: m.min };
  }
  // Where the crew chain settles if everyone pulled this crime at this success %: a success adds its nerve, a fail
  // takes 10% off and adds nothing (players). = 10 x nerve x successes per fail. Table: chain-plateau.csv.
  const chainSettlesAt = (nerve, pct) => (pct >= 100 ? Infinity : (10 * nerve * pct) / (100 - pct));
  const GROW_FROM = 100; // under the first milestone every crime grows the chain, so nothing is locked
  const MAX_PCT = 95; // the game caps success at 95%
  // Lowest success % at which a crime of this nerve keeps a chain this long growing (same rounding as the lock), or
  // null if not even 95% does.
  function growPctFor(nerve, chain) {
    for (let p = 1; p <= MAX_PCT; p++) if (Math.floor(chainSettlesAt(nerve, p) + 0.5) >= chain) return p;
    return null;
  }
  // The cheapest crime (by nerve, from the game's crime list) that can still grow the chain, and the % it needs
  // (user request, 0.25.1: "Minimum X nerve crime @ Y%"). null once no crime can.
  function minGrowCrime(chain) {
    const nerves = [...new Set(Object.values(CRIMES).map((t) => t.nerve))].sort((a, b) => a - b);
    for (const n of nerves) { const p = growPctFor(n, chain); if (p != null) return { nerve: n, pct: p }; }
    return null;
  }
  const minGrowText = (chain) => {
    const m = minGrowCrime(chain);
    return m ? `Minimum ${m.nerve} nerve crime @ ${m.pct}%` : 'no crime grows the chain at any %';
  };
  function clearChainOverrides() { GM_setValue(CHAIN_OVERRIDE_KEY, {}); }
  function loadChainOverrides() { const o = GM_getValue(CHAIN_OVERRIDE_KEY, null); return o && typeof o === 'object' ? o : {}; }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.msx-chain-toggle');
    if (!b) return;
    const o = loadChainOverrides();
    if (o[b.dataset.crime]) delete o[b.dataset.crime]; else o[b.dataset.crime] = true;
    GM_setValue(CHAIN_OVERRIDE_KEY, o);
    schedule();
  });
  function applyChainModeLock(c, box, mode, overrides) {
    const btn = c.card.querySelector('.rung-main > button.accent');
    if (!btn) return;
    const pct = c.success != null ? Math.round(c.success * 100) : null; // c.success is a fraction (0.95)
    const nerve = c.nerve || (CRIMES[c.key] && CRIMES[c.key].nerve) || null;
    let under = false, why = '', detail = '';
    if (mode && pct != null && mode.type === 'pct') {
      under = pct < mode.min;
      why = `${pct}% is under ${mode.min}%`;
    } else if (mode && pct != null && nerve && mode.type === 'grow' && mode.chain >= GROW_FROM) {
      const settles = Math.floor(chainSettlesAt(nerve, pct) + 0.5);
      under = settles < mode.chain;
      // The cheapest crime that still grows it; plus this crime's own % when it could get there at a higher %.
      const m = minGrowCrime(mode.chain);
      const need = growPctFor(nerve, mode.chain);
      why = minGrowText(mode.chain) + (need != null && (!m || m.nerve !== nerve) ? ` (this one needs ${need}%)` : '');
      detail = `At ${pct}% this crime settles the chain at ${settles.toLocaleString()}; the chain is ${mode.chain.toLocaleString()}, so it would shrink it.`;
    }
    const locked = under && !overrides[c.key];
    if (locked) { if (!btn.disabled) btn.disabled = true; btn.classList.add('msx-chain-locked'); }
    else if (btn.classList.contains('msx-chain-locked')) {
      btn.classList.remove('msx-chain-locked');
      if (!btn.classList.contains('msx-heat-locked')) btn.disabled = false;
    }
    if (!under) return;
    const note = document.createElement('div');
    note.className = 'msx-heatlock' + (locked ? ' locked' : '');
    if (detail) note.title = detail;
    note.innerHTML = (locked ? `⛓️ Chain mode: ${why}. Attempt locked` : `⛓️ Chain mode: ${why}. Unlocked by you`) +
      ` <button type="button" class="msx-chain-toggle" data-crime="${escHtml(c.key)}">${locked ? 'Unlock anyway' : 'Lock again'}</button>`;
    box.prepend(note);
  }
  // A one-line banner at the top of the Crimes page while chain mode is on.
  function ensureChainModeBanner(mode) {
    let el = document.getElementById('msx-chainmode');
    const host = document.querySelector('.main-content') || document.querySelector('main');
    if (!mode || !host) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'msx-chainmode'; host.prepend(el); }
    const rule = mode.type === 'grow'
      ? `only crimes that grow the chain (now ${mode.chain.toLocaleString()}${mode.chain < GROW_FROM ? ', nothing locked under 100' : `: ${minGrowText(mode.chain)}`})`
      : `only crimes at ${mode.min}%+`;
    const text = `⛓️ Crew chain mode is on: ${rule} (set by crew leadership in Discord)`;
    if (el.textContent !== text) el.textContent = text;
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
      box.innerHTML = stockBoxHtml(s, st);
      host.appendChild(box);
    });
  }

  // The redesigned stock page (Screenshot 355, 2026-10-06): one company at a time in `section.xr-big`, at
  // /claw-street-ex/<short id>. The old table is gone, so the company comes from the address and the price from the
  // card ("$90"), with the game's own data as a fallback. Prices keep being recorded from /api/state on every page.
  // The box sits under "A sale takes the oldest block first." (`p.sx-fine` in `.xr-blocks`, the spot the user picked).
  function readStockCard() {
    const card = document.querySelector('section.xr-big');
    const id = location.pathname.split('/').filter(Boolean)[1];
    if (!card || !id) return null;
    const headText = norm(card.querySelector('.xr-bighead')?.textContent);
    const co = (apiState?.stocks?.companies || []).find((c) => c.name && headText.includes(norm(c.name)));
    const m = (card.querySelector('.xr-bigbody')?.textContent || '').match(/\$([\d,]+)/);
    const hist = (apiState?.stocks?.history || []).filter((h) => h.id === id).sort((a, b) => b.at - a.at)[0];
    const price = m ? num(m[1]) : co ? co.price : hist ? hist.price : NaN;
    if (!Number.isFinite(price)) return null;
    return { id, name: co ? co.name : id, price, perkShares: co ? co.perkShares : null, card };
  }

  function drawStockCard() {
    const s = isStockPage() ? readStockCard() : null;
    const old = document.querySelector('.msx-stock');
    const st = s && stockStats(s.id, s.price);
    if (!st) { old?.remove(); return; }
    const blocks = s.card.querySelector('.xr-blocks');
    const fine = blocks && blocks.querySelector('.sx-fine');
    let box = old && s.card.contains(old) ? old : null;
    if (!box) { old?.remove(); box = document.createElement('div'); box.className = 'msx-stock msx-stock-card'; }
    if (fine) { if (fine.nextElementSibling !== box) fine.after(box); }
    else if (blocks) { if (box.parentElement !== blocks) blocks.appendChild(box); }
    else { const body = s.card.querySelector('.xr-bigbody'); if (!body) { box.remove(); return; } if (body.nextElementSibling !== box) body.after(box); }
    const html = stockBoxHtml(s, st);
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  // The six company cards on the stock page (`a.xr-screen`, data-co = short id, aria-label "Whisker Holdings, $121,
  // up 1.7% in 1 day, ..."; Screenshot 355): green border when the price Looks LOW, red when it Looks HIGH (user
  // request, 0.26.1). Same verdict as the box.
  function markStockScreens() {
    document.querySelectorAll('a.xr-screen[data-co]').forEach((a) => {
      const m = (a.getAttribute('aria-label') || '').match(/\$([\d,]+)/);
      const st = m && isStockPage() ? stockStats(a.dataset.co, num(m[1])) : null;
      const v = st && (st.verdict === 'low' || st.verdict === 'high') ? st.verdict : '';
      a.classList.toggle('msx-low', v === 'low');
      a.classList.toggle('msx-high', v === 'high');
      // The border was barely noticeable (user, 0.26.2), so the price number itself is coloured too: green LOW, red
      // HIGH, white otherwise (once there is enough history to judge). The card's inside has not been seen, so it is
      // whichever element holds only the price text ("$121"); only a class is added, the game's text is untouched.
      const verdictKnown = st && st.verdict !== 'learn';
      a.querySelectorAll('*').forEach((el) => {
        const isPrice = !el.children.length && /^\$[\d,]+$/.test(el.textContent.trim());
        el.classList.toggle('msx-price-low', isPrice && v === 'low');
        el.classList.toggle('msx-price-high', isPrice && v === 'high');
        el.classList.toggle('msx-price-mid', isPrice && !!verdictKnown && !v);
      });
      setTitle(a, v ? `MeowStreets Extra Info: looks ${v.toUpperCase()} (${Math.round(st.pos * 100)}% of range, lowest seen $${st.min}, highest $${st.max})` : '');
    });
  }

  function stockBoxHtml(s, st) {
    const arrow = st.trend > 0 ? '↗' : st.trend < 0 ? '↘' : '→';
    const label = st.verdict === 'learn'
      ? `Learning ${st.n}/${MIN_TICKS_FOR_VERDICT}`
      : `${VERDICT_LABEL[st.verdict]} · ${Math.round(st.pos * 100)}% of range · ${ordinal(Math.round(st.pct * 100))} pct`;
    const perkCost = s.perkShares ? ` · perk ≈ ${fmtMoney(s.perkShares * s.price)}` : '';
    return `<span class="msx-tag stk ${st.verdict}" title="% of range: how far up between the lowest and highest price recorded (0% = lowest seen, 100% = highest seen). pct: the share of recorded price periods that were lower. HIGH or LOW shows when either is within 20% of an end.">${label}</span>` +
      `<span class="msx-trend" title="Average of the last 3 price moves vs the 3 before">${st.n >= 6 ? arrow : ''}</span>` +
      `<small class="msx-moves" title="How many of the last 10 and last 25 price moves went up (↑), down (↓) or stayed the same (=). Only counts moves the script saw one after another, so a gap in the record is skipped.">${movesHtml(st.mw)}</small>` +
      `<small class="msx-range" title="Lowest / highest price this script has recorded, over ${st.n} price moves (avg $${st.avg.toFixed(1)})">` +
      `Lowest seen <b>$${st.min}</b> · Highest seen <b>$${st.max}</b> · Avg $${st.avg.toFixed(0)}${perkCost}</small>` +
      perkTimingHtml(s.name);
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
    // A plain link (user request, 0.17.5): opens Claw Street Ex.
    const el = document.createElement('a');
    el.href = '/claw-street-ex';
    el.className = 'msx-ticker msx-pill-link';
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
    // A plain link (user request, 0.17.5): opens the Crew page, which also re-syncs the chain.
    const el = document.createElement('a');
    el.href = '/crew';
    el.className = 'msx-ticker msx-chain msx-pill-link';
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

  // ─── Crew +5% crime bonus (sidebar, every page, 0.22.0) ───────────────────
  // While the crew's +5% window is on, a "+5%: h:mm:ss" line inside the crew chain box (same dashed divider as the
  // crew job line), counting down to the game's own `buff_until`. Hidden once it ends.
  function updateCrewBuffPill() {
    const crew = apiState && apiState.crew;
    const chainEl = document.querySelector('.msx-chain');
    let seg = chainEl ? chainEl.querySelector('.msx-crewbuff-inline') : null;
    const remain = crew && crew.buffActive ? crew.buffUntil - Date.now() : 0;
    if (!chainEl || !(remain > 0)) { if (seg) seg.remove(); return; }
    if (!seg) {
      seg = document.createElement('span');
      seg.className = 'msx-crewjob-inline msx-crewbuff-inline';
      const job = chainEl.querySelector('.msx-crewjob-inline');
      if (job) job.before(seg); else chainEl.appendChild(seg);
    }
    setTitle(seg, `Crew +5% crime chance ends at ${fmtTime(crew.buffUntil)}`);
    seg.classList.toggle('soon', remain <= 15 * 60 * 1000);
    const text = `+5%: ${fmtClock(remain)}`;
    if (seg.textContent !== text) seg.textContent = text;
  }

  // ─── Bank deposits ready to collect (sidebar, every page, 0.22.0) ─────────
  // Only shown while at least one deposit is past its end time; a plain link to the Feline Bank, like the
  // companion and tuna/catnip pills.
  const BANK_ICON = '<svg viewBox="0 0 48 48" class="msx-item-icon" aria-hidden="true"><path d="M6 18 24 7l18 11Z" fill="#E9C46A"/><rect x="8" y="18" width="32" height="3" fill="#8A8F86"/><rect x="11" y="22" width="4" height="14" fill="#E7EDE1"/><rect x="19" y="22" width="4" height="14" fill="#E7EDE1"/><rect x="27" y="22" width="4" height="14" fill="#E7EDE1"/><rect x="35" y="22" width="4" height="14" fill="#E7EDE1"/><rect x="6" y="36" width="36" height="4" rx="1" fill="#8A8F86"/><circle cx="24" cy="14" r="2" fill="#182316"/></svg>';
  function updateBankPill() {
    const now = Date.now();
    const ready = ((apiState && apiState.deposits) || []).filter((d) => d.endsAt <= now);
    let el = document.querySelector('.msx-bank');
    if (!ready.length) { if (el) el.remove(); return; }
    if (!el) {
      const anchor = document.querySelector('.msx-chain') || document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
      if (!anchor || !anchor.parentNode) return;
      el = document.createElement('a');
      el.href = '/feline-bank';
      el.className = 'msx-ticker msx-bank msx-pill-link soon';
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    const total = ready.reduce((s, d) => s + d.amount, 0);
    setTitle(el, `${ready.length} bank deposit${ready.length > 1 ? 's' : ''} (${fmtMoney(total)} put in) ready to collect at the Feline Bank`);
    const html = `${BANK_ICON}${ready.length} ready`;
    if (el.innerHTML !== html) el.innerHTML = html;
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
      // A plain link (user request, 0.17.4): clicking the pill opens the Companion page, like any link would.
      el = document.createElement('a');
      el.href = '/companion';
      el.className = 'msx-ticker msx-companion msx-pill-link';
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
      // A plain link (user request, 0.17.4): opens the Purrse, where tuna and catnip are used.
      el = document.createElement('a');
      el.href = '/purrse';
      el.className = 'msx-ticker msx-consumable msx-pill-link';
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    setTitle(el, 'Whether Premium tuna and Catnip tea are off cooldown, from the game’s own data');
    el.classList.toggle('soon', anyCapped);
    const html = bits.join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ─── Cat clock (next to the sidebar logo, every page) ─────────────────────
  // The game runs on UTC: the Whiskers daily limit, the 12-a-day tuna/catnip uses and contracts all reset at
  // 00:00 UTC (the Whiskers page says "Resets 00:00 UTC"; the game's own `contractResetAt` lands exactly there).
  // A cat-face clock goes beside the logo (`.sidebar .brand`, seen in a dev-tools capture, Screenshot 335) and a
  // short line under that row counts down to the reset. The weekly reset is in the tooltip only.
  const UTC_DAY_MS = 86400000;
  function ensureCatClock() {
    const brand = document.querySelector('.sidebar .brand');
    if (!brand) return;
    if (!brand.querySelector('.msx-clock')) {
      const icon = document.createElement('span');
      icon.className = 'msx-clock';
      icon.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M5 9 L5.5 2.5 L10 6.2 Z M19 9 L18.5 2.5 L14 6.2 Z" fill="currentColor"/>' +
        '<circle cx="12" cy="13.5" r="8" fill="var(--ms-asphalt, #1c201c)" stroke="currentColor" stroke-width="1.6"/>' +
        '<path d="M1 13 L4.5 13.6 M1 16 L4.5 15.2 M23 13 L19.5 13.6 M23 16 L19.5 15.2" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/>' +
        '<line class="msx-clock-h" x1="12" y1="13.5" x2="12" y2="9.5" stroke="var(--ms-bone, #e7ede1)" stroke-width="1.8" stroke-linecap="round"/>' +
        '<line class="msx-clock-m" x1="12" y1="13.5" x2="12" y2="7.2" stroke="var(--ms-bone, #e7ede1)" stroke-width="1.1" stroke-linecap="round"/>' +
        '<circle cx="12" cy="13.5" r="1" fill="currentColor"/></svg>';
      brand.appendChild(icon);
    }
    if (!document.querySelector('.msx-clock-row')) {
      const row = document.createElement('div');
      row.className = 'msx-clock-row';
      brand.after(row);
    }
    updateCatClock();
  }

  function updateCatClock() {
    const row = document.querySelector('.msx-clock-row');
    if (!row) return;
    const now = Date.now();
    const d = new Date(now);
    const h = d.getUTCHours(), m = d.getUTCMinutes();
    const reset = (Math.floor(now / UTC_DAY_MS) + 1) * UTC_DAY_MS;
    const left = Math.ceil((reset - now) / 1000);
    const text = `reset in ${Math.floor(left / 3600)}:${String(Math.floor(left / 60) % 60).padStart(2, '0')}:${String(left % 60).padStart(2, '0')} · ` +
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`;
    if (row.textContent !== text) row.textContent = text;
    const weekly = apiState && apiState.weeklyResetAt > now ? apiState.weeklyResetAt : 0;
    const dateTime = (ts) => new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const title = `Game time is UTC. Daily reset (Whiskers limit, tuna/catnip uses, contracts) at 00:00 UTC = ${fmtTime(reset)} your time.` +
      (weekly ? ` Weekly reset: ${dateTime(weekly)}.` : '');
    setTitle(row, title);
    const icon = document.querySelector('.msx-clock');
    if (icon) {
      setTitle(icon, title);
      const hourDeg = ((h % 12) + m / 60) * 30, minDeg = m * 6;
      const hand = (sel, deg) => { const el = icon.querySelector(sel); const v = `rotate(${deg} 12 13.5)`; if (el && el.getAttribute('transform') !== v) el.setAttribute('transform', v); };
      hand('.msx-clock-h', hourDeg);
      hand('.msx-clock-m', minDeg);
    }
  }

  setInterval(() => {
    // Redraw the Trading panel the moment an hourly store price runs out, so it shows "old price" straight away.
    if (tradingRefreshAt && Date.now() >= tradingRefreshAt) { tradingRefreshAt = 0; schedule(); }
    updateCatClock(); updateTicker(); updateChainPill(); updateCrewJobPill(); updateCrewBuffPill(); updateHeistPill(); updateCompanionPill(); updatePvpPill(); updateConsumablesPill(); updateBankPill(); }, 1000);

  // ─── Reading page text ─────────────────────────────────────────────────────
  // Page text without our own additions and without the chat column.
  function readMainText(cap) {
    const root = document.querySelector('.main-content') || document.querySelector('main');
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.msx-info, .msx-stock, .msx-heat, .msx-ticker, .msx-gymlock, #msx-invest, #msx-heists, #msx-crewjobs, #msx-mycrewjob, #msx-chainpost, #msx-myheist, #msx-trading, script, style').forEach((n) => n.remove());
    // A locked Train button is this script's own doing, not something the game itself did -- a page capture
    // should reflect the real page, so the lock is undone on the clone (never on the live page) before saving.
    clone.querySelectorAll('button.msx-train-locked').forEach((n) => { n.disabled = false; n.classList.remove('msx-train-locked'); });
    clone.querySelectorAll('div, p, li, h1, h2, h3, h4, tr, dt, dd, article, section, br').forEach((n) => n.appendChild(document.createTextNode('\n')));
    return clone.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, cap);
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

  // ─── Cat Tree: lock a stat so its Train button can't be clicked (user request) ─────────────
  // Still strictly read-only: this never clicks or submits anything on its own. It only disables the game's own
  // Train button for a stat you've chosen to lock, so a stray click -- or just habit -- can't train it by
  // accident; unlocking it is instant too. Checked against a real capture of the page (dev tools, 2026-10-01):
  // each stat is an `article.station-card` whose Train button carries `aria-label="Train <stat>"` -- a reliable,
  // real selector, not a guess. The lock itself is kept in this browser's storage (not exported, not sent
  // anywhere), the same place everything else here is kept.
  const GYM_LOCK_KEY = 'ms_gym_locks_v1';
  function loadGymLocks() { try { return JSON.parse(GM_getValue(GYM_LOCK_KEY, '{}')) || {}; } catch (e) { return {}; } }
  function saveGymLocks(locks) { GM_setValue(GYM_LOCK_KEY, JSON.stringify(locks)); }

  function applyGymLocks() {
    if (location.pathname.replace(/\/+$/, '') !== '/cat-tree') return;
    const locks = loadGymLocks();
    document.querySelectorAll('article.station-card').forEach((card) => {
      const btn = card.querySelector('button[aria-label^="Train "]');
      if (!btn) return;
      const stat = btn.getAttribute('aria-label').replace(/^Train\s+/i, '').trim().toLowerCase();
      const statCap = stat.charAt(0).toUpperCase() + stat.slice(1);
      const host = btn.closest('.card-do') || card;
      let toggle = host.querySelector('.msx-gymlock');
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'msx-gymlock';
        host.appendChild(toggle);
        toggle.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const cur = loadGymLocks();
          cur[stat] = !cur[stat];
          saveGymLocks(cur);
          applyGymLocks();
        });
      }
      const locked = !!locks[stat];
      toggle.textContent = locked ? `🔒 ${statCap} locked` : `🔓 Lock ${statCap}`;
      setTitle(toggle, locked
        ? `Train is disabled here until you unlock it. This never trains or clicks anything for you -- it only blocks your own click.`
        : `Disable the Train button here, so ${statCap} can't be trained by a stray click. Never clicks it for you either way.`);
      toggle.classList.toggle('locked', locked);
      btn.disabled = locked;
      btn.classList.toggle('msx-train-locked', locked);
    });
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
    const anchor = document.querySelector('.sidebar .msx-clock-row') || document.querySelector('.sidebar .brand') || document.querySelector('.sidebar .profile');
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

  const currentPath = () => location.pathname.replace(/\/+$/, '') || '/';

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
    // Open seats first, filled ones under them (user request, 0.17.3): the open seats are what a reader acts on.
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
    if (filled.length) {
      lines.push('', '✅ Filled:');
      filled.forEach((m) => lines.push(`• ${roleTitle(m.role)} — ${m.name || 'someone'}${m.level != null ? ` (Lv ${m.level})` : ''}`));
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
      ? jobs.map((j) => {
        // Two jobs can share a name, so each tab also says whether it's yours and how full it is.
        const seats = j.maxMembers ? ` · ${(j.members || []).length}/${j.maxMembers}` : '';
        return `<button type="button" class="msx-jobtab${String(j.id) === selected ? ' active' : ''}" data-id="${escHtml(String(j.id))}">` +
          `${escHtml(j.name || 'Job')}${j.mine ? ' (yours)' : ''}${seats}</button>`;
      }).join('')
      : '';
    if (tabsEl.innerHTML !== tabsHtml) tabsEl.innerHTML = tabsHtml;
    renderSelected();
  }

  function ensureMyCrewJobPanel() {
    const jobs = (apiState && apiState.myCrewJobs) || [];
    ensureJobMessagesPanel('msx-mycrewjob', '/crew', 'msx-crewjobs', jobs.length > 1 ? 'Crew jobs' : 'Crew job',
      'A ready-to-paste Discord message: open seats, filled seats and the payout.' +
      (jobs.length > 1 ? ' Click a job to make its message.' : ''),
      jobs, buildCrewJobMessage, apiState && apiState.crew && apiState.crew.name);
    // In the right-hand column, straight under the "Your neighborhood" card (user request, 0.17.6; layout from a
    // dev-tools capture, Screenshot 337: aside.right-column > section.panel.neighborhood). Falls back to the
    // main column if that card isn't there.
    const panel = document.getElementById('msx-mycrewjob');
    const hood = document.querySelector('.right-column .neighborhood');
    const anchor = hood && hood.nextElementSibling && hood.nextElementSibling.id === 'msx-chainpost' ? hood.nextElementSibling : hood;
    if (panel && anchor && anchor.nextElementSibling !== panel) anchor.after(panel);
    // "📣 Post to Discord" (0.19.0): only while crew sharing is on. The crew bot posts the selected job and then
    // keeps editing that post as people join.
    let post = panel && panel.querySelector('.msx-postbtn');
    if (panel && sharingOn() && !post) {
      post = document.createElement('button');
      post.type = 'button';
      post.className = 'msx-postbtn';
      post.textContent = '📣 Post to Discord';
      post.title = 'Post this job in the crew Discord. The post updates itself as people join.';
      post.addEventListener('click', () => postJobToDiscord(panel.dataset.selectedId));
      panel.querySelector('.msx-copybtn').after(post);
    } else if (post && !sharingOn()) post.remove();
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
    // The store price is what the game charges you, already after any store discount (0.22.0 fix: it used to take the
    // discount off a second time). A discounted item notes its normal price; the range shown is the normal range.
    const now = Date.now();
    tradingRefreshAt = 0;
    const rows = [...cheapest.entries()].map(([id, l]) => {
      const s = store[id];
      const total = l.price + taxOn(l.price);
      const buyPrice = s && Number.isFinite(s.price) ? s.price : null;
      // Hourly prices: once `priceUntil` has passed, the store price shown is last hour's until the game reloads.
      const stale = !!(s && s.until && now >= s.until);
      if (s && s.until > now && (!tradingRefreshAt || s.until < tradingRefreshAt)) tradingRefreshAt = s.until;
      let storeCell = '—';
      if (buyPrice != null) {
        storeCell = money0(buyPrice) + (s.disc ? ` <small>(your discount; normal ${money0(s.base)})</small>` : '');
        if (s.baseMin != null) storeCell += `<br><small>range ${money0(s.baseMin)} – ${money0(s.baseMax)}</small>`;
        if (stale) storeCell += '<br><small class="msx-stale">(old price, refresh)</small>';
      }
      const sellPrice = s ? s.sellPrice : null;
      // Positive = free money (buy the listing, sell it straight back to Whiskers & Co. for more than it cost).
      const sellProfit = sellPrice != null ? sellPrice - total : null;
      // Negative = cheaper than the store; positive = the store is the better buy.
      const buyDiff = buyPrice != null ? total - buyPrice : null;
      return { name: s ? s.name : id, buyPrice, storeCell, sellPrice, listedPrice: l.price, total, seller: l.seller, count: counts.get(id), sellProfit, buyDiff };
    }).sort((a, b) => {
      // Best opportunity first, whichever kind it is: the biggest sell-back profit, or failing that the
      // biggest discount off the store's buy price. Items with neither sit at the bottom.
      const opportunity = (r) => Math.max(r.sellProfit != null ? r.sellProfit : -Infinity, r.buyDiff != null ? -r.buyDiff : -Infinity);
      return opportunity(b) - opportunity(a);
    });
    // Kept short on purpose (user request, 0.17.2): one line per column that needs explaining.
    let h = '<ul class="msx-inv-note msx-trade-key">' +
      '<li>Cheapest open listing per item, best deal first.</li>' +
      '<li><b>With tax</b>: listed price + the 2% buyer\'s tax.</li>' +
      '<li><b>Vs store</b>: that total vs Whiskers & Co.\'s price (your discounted price if you own a discount).</li>' +
      '<li><b>Resell profit</b>: buy it here, sell it to Whiskers & Co. for more.</li>' +
      '<li>Hourly-priced items show their range. A dash means no price is known.</li></ul>';
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
        `<td>${money0(r.total)}</td><td>${r.storeCell}</td><td>${vs}</td>` +
        `<td>${r.sellPrice != null ? money0(r.sellPrice) : '—'}</td><td>${profit}</td><td>${r.count}</td></tr>`;
    });
    h += '</tbody></table>';
    body.innerHTML = h;
  }

  // ─── Whiskers & Co. (/whiskers) ───────────────────────────────────────────
  // Page layout from a real dev-tools capture (Screenshot 333, 2026-10-01): every item is a `.ws-row`, its name
  // in `.ws-text > b` and its price in `.ws-each > b`. The box below goes inside `.ws-text`, under the name.
  const MAX_SHOP_TICKS = 2000; // one reading per item per price period (an hour) -- about 12 weeks of hours seen

  // One reading per price period per item (`priceUntil` marks the end of each period). Runs whenever the game's
  // own /api/state passes by, on any page, so prices are caught even when the Whiskers page isn't open.
  function logShopPricesFromApi() {
    if (!apiState || !apiState.shopItems) return;
    const db = loadDb();
    let changed = false;
    apiState.shopItems.forEach((it) => {
      if (it.min == null || !it.until) return;
      const key = norm(it.name);
      const rec = db.shopPrices[key] || (db.shopPrices[key] = { name: it.name, obs: [] });
      if (rec.min !== it.min || rec.max !== it.max || rec.ref !== it.ref) { rec.name = it.name; rec.min = it.min; rec.max = it.max; rec.ref = it.ref; changed = true; }
      const same = rec.obs.find((o) => o.until === it.until);
      if (same) { if (same.price !== it.price) { same.price = it.price; changed = true; } return; }
      rec.obs.push({ t: new Date().toISOString(), until: it.until, price: it.price });
      rec.obs.sort((a, b) => a.until - b.until);
      if (rec.obs.length > MAX_SHOP_TICKS) rec.obs.shift();
      changed = true;
    });
    if (changed) { db.updated = new Date().toISOString(); saveDb(db); }
  }

  // The discount line, laid out like the crime odds breakdown: each source and its share, then the total.
  // The total is always the game's own `marketRate`, never the sources added up by hand (whether two
  // discounts add or multiply isn't known yet).
  function whiskersDiscountHtml(it) {
    // The game's price already has the discount taken off (0.22.0 fix), so this only says so and gives the
    // normal price. No discount owned: show nothing (user request, 0.16.1).
    // Two lines (user request, 0.22.1): the regular price, then where your discount comes from.
    if (!it.disc) return '';
    const pct = Math.round((1 - apiState.marketRate) * 1000) / 10;
    const named = (apiState.marketDiscounts || []).filter((s) => s.owned).map((s) => `${escHtml(s.name)} −${s.pct}%`);
    const label = named.length ? named.join(' · ') : `Discount −${pct}%`;
    return `<div>Regular price <b>${money0(it.base)}</b></div><div class="msx-ws-disc">Your discount: ${label}</div>`;
  }

  // Kept deliberately short (user request, 0.16.1): just the game's own range, plus a discount line only when
  // one is owned. The hourly price history is still recorded (db.shopPrices, in the export), just not shown.
  function whiskersHtml(it) {
    let h = '';
    // The normal range, without your discount (user request, 0.22.0).
    if (it.baseMin != null && it.baseMax > it.baseMin) h += `<div>Range <b>${money0(it.baseMin)} – ${money0(it.baseMax)}</b></div>`;
    h += whiskersDiscountHtml(it);
    return h;
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.msx-ws-deal');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (!sharingOn()) { toast('Not posted: sharing is only for crew members with sharing switched on.'); return; }
    const body = { v: 1, sender: shareId(), crew: { name: apiState.crew.name, id: apiState.crew.id }, item: b.dataset.item, price: Number(b.dataset.price) };
    if (b.dataset.min) { body.min = Number(b.dataset.min); body.max = Number(b.dataset.max); }
    GM_xmlhttpRequest({
      method: 'POST', url: CREW_BOT_DEAL_URL, data: JSON.stringify(body), timeout: 15000, headers: { 'Content-Type': 'application/json' },
      onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (err) { /* not json */ } toast(j && j.ok ? `Posted: ${b.dataset.item} for $${Number(b.dataset.price).toLocaleString()}.` : 'Not posted: ' + ((j && j.error) || 'unknown problem') + '.'); },
      onerror: () => toast('Not posted: could not reach the crew bot.'),
      ontimeout: () => toast('Not posted: the crew bot did not answer.'),
    });
  }, true);

  // Arrived from a crime's tool chip (#msx-item=<name>): scroll to that item and highlight it, once.
  function focusWhiskersItem() {
    const m = location.hash.match(/^#msx-item=(.+)$/);
    if (!m) return;
    const want = norm(decodeURIComponent(m[1]));
    const row = [...document.querySelectorAll('.ws-row')].find((r) => norm(r.querySelector('.ws-text > b')?.textContent) === want);
    if (!row) return; // not rendered yet -- the next redraw tries again
    history.replaceState(null, '', location.pathname + location.search);
    row.scrollIntoView({ block: 'center' });
    row.classList.add('msx-ws-focus');
    setTimeout(() => row.classList.remove('msx-ws-focus'), 2500);
  }

  function drawWhiskers() {
    if (location.pathname.replace(/\/+$/, '') !== '/whiskers') return;
    focusWhiskersItem();
    if (!apiState) return;
    const items = new Map((apiState.shopItems || []).map((it) => [norm(it.name), it]));
    document.querySelectorAll('.ws-row').forEach((row) => {
      const text = row.querySelector('.ws-text');
      const nameEl = text && text.querySelector(':scope > b');
      if (!nameEl) return;
      const it = items.get(norm(nameEl.textContent));
      let box = text.querySelector(':scope > .msx-ws');
      // 📣 while crew sharing is on (user request, 0.20.0): posts "X is for sale at Whiskers & Co. for $Y" to the
      // crew bot's deals channel. Only on items whose price moves within a range (0.21.0) -- fixed prices are no news.
      // The Discord post gets the normal price and range, never your personal discount (user request, 0.22.0).
      const deal = it && sharingOn() && it.baseMin != null && it.baseMax > it.baseMin
        ? `<button type="button" class="msx-ws-deal" data-item="${escHtml(it.name)}" data-price="${it.base}" data-min="${it.baseMin}" data-max="${it.baseMax}" title="Post this price to the crew Discord">📣 Post to Discord</button>`
        : '';
      const html = it ? whiskersHtml(it) + deal : '';
      if (!html) { if (box) box.remove(); return; }
      if (!box) { box = document.createElement('div'); box.className = 'msx-ws'; text.appendChild(box); }
      if (box.__msxHtml !== html) { box.innerHTML = html; box.__msxHtml = html; }
    });
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
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-events"> Log my Mews events (crime results, trades, training)</label>' +
      '<div id="msx-acc-sharebox" hidden><h3>Crew Discord bot</h3>' +
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-share"> Share with our crew\'s Discord bot: crew chain, crew jobs, stock prices and the feats you have earned (for chain and job posts, the crew\'s shared stock lows/highs and how to get hidden feats; nothing else, never sent to MeowStreets)</label></div>';
    host.appendChild(box);

    box.querySelector('#msx-acc-events').addEventListener('change', (e) => { settings.events = e.target.checked; saveSettings(); });
    box.querySelector('#msx-acc-share').addEventListener('change', (e) => { settings.shareCrew = e.target.checked; saveSettings(); if (settings.shareCrew) { shareCrew(); syncStocks(true); } });
    updateAccountPanel();
  }

  function updateAccountPanel() {
    const box = document.getElementById('msx-account');
    if (!box) return;
    const ev = box.querySelector('#msx-acc-events');
    const sh = box.querySelector('#msx-acc-share');
    const shBox = box.querySelector('#msx-acc-sharebox');
    if (shBox.hidden === inShareCrew()) shBox.hidden = !inShareCrew(); // only shown to the crew the bot serves
    if (sh.checked !== settings.shareCrew) sh.checked = settings.shareCrew;
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
      ensureAccountPanel();
      readModifiers();
      logStocksFromApi();
      syncStocks(); // crew stock pool: at most every 5 minutes, only while sharing is on
      readEvents();
      readEventsFromApi();
      readGym();
      applyGymLocks();
      readTraining();
      if (isCrimesPage() && document.querySelector('.ladders article.rung')) {
        const data = readAll();
        draw(data);
        logObservations(data);
      }
      if (isStockPage()) syncNextMove();
      ensureCatClock();
      ensureTicker();
      ensureLegend();
      updateLegend();
      syncChain();
      ensureChainPill();
      updateCrewJobPill();
      updateCrewBuffPill();
      updateHeistPill();
      updateCompanionPill();
      updatePvpPill();
      updateConsumablesPill();
      updateBankPill();
      drawHiddenFeats();
      ensureNoCrewPanel();
      ensureChainPostButton();
      ensureMyCrewJobPanel();
      ensureMyHeistPanel();
      ensureHeistsPanel();
      ensureCrewJobsPanel();
      ensureTradingPanel();
      logShopPricesFromApi();
      drawWhiskers();
      if (isStockPage() && document.querySelector('.watch-table')) {
        const stocks = readStocks();
        logStocks(stocks);
        drawStocks(stocks);
        ensureInvestPanel(stocks);
      } else {
        drawStockCard(); // the redesigned one-company page (0.26.0)
        markStockScreens(); // LOW / HIGH borders on the six company cards (0.26.1)
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
        const own = (m) => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('.msx-ticker, .msx-legend, #msx-toast, #msx-invest, #msx-heists, #msx-crewjobs, #msx-mycrewjob, #msx-chainpost, #msx-chainmode, #msx-myheist, #msx-trading, #msx-nocrew, .msx-stock, .msx-ws, .msx-clock, .msx-clock-row, .msx-feat-how');
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
        if (!incoming.shopPrices) incoming.shopPrices = {};
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

  schedule();
  observe();
})();
