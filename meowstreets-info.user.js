// ==UserScript==
// @name         MeowStreets Extra Info
// @namespace    https://meowstreets.com
// @version      0.49.5
// @description  Crimes pages: the best place in each job with pay and XP per nerve, and on each job's page the game's success % with where every point comes from, heat, mastery and its unlocks. Claw Street Ex: logs stock prices and shows if a price looks low or high. Sidebar timers for stocks and your crew chain, a "Script data" checklist and a Mews event log, all kept on your computer. It also reads (never requests) the JSON the game's own pages fetch from their own API, for exact crime, merit and crew numbers. Sharing with The Purrfessionals' Discord bot is on unless you turn it off (Account page): stock prices, earned feats, mastery unlocks, fish catches, the gear of cats seen in your fights, and your own battle stats only if you turn on Share my battle stats (Cataclysm alliance crews only; nobody else's stats are ever kept), with your cat id (plus crew chain and job info for the crew the bot serves). Everyone gets the shared data back except other cats' gear and the battle stats members chose to share, which only the Cataclysm alliance crews get. Nothing is sent to MeowStreets.
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
// @grant        GM_xmlhttpRequest
// @connect      168.138.79.225
// @connect      meowstreets.com
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
  const DB_KEY = 'ms_db_v1';

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const num = (s) => parseFloat(String(s).replace(/,/g, ''));
  const fmtMoney = (n) => '$' + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1));
  const n0 = (v) => Math.round(v).toLocaleString('en-US'); // whole number with commas
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

  // Crime success pieces from the game's `bonuses` list (see above). null when the game sent no list. Each piece:
  // { label, v, crimes: [crime ids] or null for every crime }. Lines about other things (gym, wages, springing a cat,
  // the clean-job chance) are left out because they name no crime.
  function crimeBonusesFromList(raw) {
    // Only the list as sent since 2026-11-13 ({ source, line, from }); the older plain strings (2026-11-04) left out
    // Inside line and the merits, so for those the older reckoning above stays.
    if (!Array.isArray(raw.bonuses) || !raw.bonuses.length || !raw.bonuses.every((x) => x && typeof x === 'object' && typeof x.line === 'string' && x.source)) return null;
    const crimes = (raw.crimes || []).filter((c) => c && c.id && c.name);
    const byName = (n) => { const k = norm(String(n).replace(/^the\s+/i, '')); const c = crimes.find((x) => norm(x.name.replace(/^the\s+/i, '')) === k); return c ? c.id : null; };
    const districtNames = {};
    ((raw.street && raw.street.districts) || []).forEach((d) => { if (d && d.id && d.name) districtNames[norm(d.name.replace(/^the\s+/i, ''))] = d.id; });
    const out = [];
    raw.bonuses.forEach((b) => {
      if (!b || typeof b.line !== 'string') return;
      const label = String(b.from || b.source || 'bonus').split(' · ')[0];
      b.line.split(/,\s*(?=[+−-]\d)/).forEach((part) => { // "+5% crime cash, +4 points on A, B and C": split before each +N only
        const m = part.trim().replace(/\.$/, '').match(/^([+−-])(\d+) points? (to|on) (.+)$/i);
        if (!m) return;
        const v = (m[1] === '+' ? 1 : -1) * Number(m[2]);
        // "to every crime’s success chance" (and "on every crime’s …", as the game wrote it before): every crime.
        if (/^every crime(?:’s|'s|s)?\b/i.test(m[4])) { out.push({ label, v, crimes: null }); return; }
        if (m[3].toLowerCase() !== 'on') return; // "to spring a cat", "to your happiness cap": not a crime
        const dm = m[4].match(/^every (.+?) crime$/i);
        if (dm) {
          const id = districtNames[norm(dm[1].replace(/^the\s+/i, ''))];
          if (id) out.push({ label, v, crimes: crimes.filter((c) => c.district === id).map((c) => c.id) });
          return;
        }
        const ids = m[4].split(/\s*,\s*|\s+and\s+/i).map(byName);
        if (ids.length && ids.every(Boolean)) out.push({ label, v, crimes: ids });
      });
    });
    return out;
  }

  function extractApiState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
      const out = {
        at: Date.now(), crimes: {}, meritLines: {}, merits: null, crew: null, chain: null, stocks: null, events: [],
        education: null, companion: null, protectedUntil: 0, bountyOnMe: 0, cooldowns: {}, usedUp: [], energy: null, nerve: null, caps: null,
        crimeBonusParts: [], storeItems: {}, listings: [], shopItems: [], marketRate: 1, marketDiscounts: [], weeklyResetAt: 0, crewJobsSeen: false,
        heists: [], crewJobTiers: [], heistXp: null, activeCrewJob: null, activeHeist: null, myCrewJobs: [], myHeists: [], crewJobRoles: null, deposits: [],
        gymSpent: null, gymsNext: [],
      };
      (raw.crimes || []).forEach((c) => {
        if (!c || !c.name) return;
        out.crimes[norm(c.name)] = {
          id: c.id, chance: c.chance, baseChance: c.baseChance, masteryLevel: c.masteryLevel, masteryBonus: c.masteryBonus,
          heat: c.heat, hot: !!c.hot, heatZeroAt: Number(c.heatZeroAt) || 0, bonus: c.bonus, criticalChance: c.criticalChance,
          successes: c.successes, attempts: c.attempts, payMin: c.payMin, payMax: c.payMax,
          masteryPercent: Number.isFinite(c.masteryPercent) ? c.masteryPercent : null,
          // The most this job's % can be (game build 2026-11-08: 96–99 by job, was 95 for all).
          ceiling: Number.isFinite(c.ceiling) ? c.ceiling : 95,
        };
      });
      // The rebuilt crimes (game build 2026-10-10, API log "newupdate"): `street` has each crime's places and their
      // buttons with nerve, heat, XP and pay, plus district heat. The success % per crime is still only in `crimes`.
      if (raw.street && Array.isArray(raw.street.crimes)) {
        const chanceById = {};
        (raw.crimes || []).forEach((c) => { if (c && c.id) chanceById[c.id] = c.chance; });
        const act = (a) => ({ key: a.key, verb: a.verb, cost: a.cost, heat: a.heat, xp: a.xp, payMin: a.payMin, payMax: a.payMax, main: !!a.main,
          // Each button's odds: a % since build 2026-11-08 (`odds.pct`), a word (Safe / Good / Fair) before.
          odds: a.odds ? (Number.isFinite(a.odds.pct) ? a.odds.pct : a.odds.word || null) : null });
        out.street = {
          districts: {},
          crimes: raw.street.crimes.filter((c) => c && c.id).map((c) => ({
            id: c.id, name: c.name, kind: c.kind, district: c.district, cost: c.cost, state: c.state, chance: chanceById[c.id],
            // Jobs that pay once at the end: the safe's wheels, the clock's steps (the pay shown is for the whole job).
            steps: c.kind === 'crack' ? ((c.targets || [])[0]?.wheels?.of || 1) : c.kind === 'steps' ? (c.targets || []).length || 1 : 1,
            tools: (c.tools || []).filter((t) => t && t.name).map((t) => ({ name: t.name, held: Number(t.held) || 0 })),
            places: (c.targets || []).filter((t) => t && !t.empty).map((t) => ({ id: t.id, name: t.name, open: !t.shut, acts: (t.acts || []).map(act) })),
            // Mastery unlocks ("rungs", at mastery 3/6/10/15/20). The game only sends `text` once you have reached one.
            rungs: (Array.isArray(c.rungs) ? c.rungs : []).filter((r) => r && r.name && Number.isInteger(r.at))
              .map((r) => ({ at: r.at, name: r.name, text: typeof r.text === 'string' ? r.text : '', got: !!r.got })),
          })),
        };
        (raw.street.districts || []).forEach((d) => { if (d && d.id) out.street.districts[d.id] = { name: d.name, heat: d.heat, hot: !!d.hot, line: d.line || '' }; });
      }
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
      // The crew's weekly contracts (2026-10-19): id, name, goal, got on every page. What counts and your own share only
      // come with the Contracts tab's reply (see onCrewContractsResponse).
      if (raw.crew && raw.crewWeek && Array.isArray(raw.crewWeek.contracts)) {
        out.crewWeek = {
          ends: Number(raw.crewWeek.ends) || 0,
          contracts: raw.crewWeek.contracts.filter((c) => c && c.id).map((c) => ({ id: String(c.id), name: c.name || String(c.id), goal: Number(c.goal) || 0, got: Number(c.got) || 0, done: !!c.done })),
        };
      }
      if (raw.street && Number.isFinite(raw.street.level)) out.playerLevel = raw.street.level;
      if (raw.rules && Number.isFinite(raw.rules.mugProtection)) out.mugProtectionMs = raw.rules.mugProtection;
      // Your own recent attacks (every page): the ones where you took cash, for the 💰 muggable mark (0.35.0). Same attack
      // ids as the crew attack log, so one mug is never counted twice.
      if (Array.isArray(raw.attacks) && raw.player && raw.player.id != null) {
        out.myMugs = raw.attacks.filter((a) => a && a.id != null && a.attacker_id === raw.player.id && Number(a.stolen) > 0 && a.defender_id != null)
          .map((a) => ({ id: a.id, victim: a.defender_id, name: '', stolen: Number(a.stolen), at: a.created_at || 0 }));
      }
      // Crew perks with their ranks come with every /api/state (seen 2026-10-19), so the Perks tab never has to be
      // opened: Inside line = ranks x step (% crime chance).
      if (Array.isArray(raw.crewPerks)) {
        const inside = raw.crewPerks.find((p) => p && p.id === 'crime');
        out.crewPerkCrime = inside && Number.isFinite(inside.ranks) ? inside.ranks * (Number(inside.step) || 1) : 0;
      }
      // The gym you are at and its gain per stat (Cat Tree auto-lock, 0.34.0). `state: 'here'` marks it.
      if (Array.isArray(raw.gyms)) {
        const g = raw.gyms.find((x) => x && x.state === 'here') || raw.gyms.find((x) => x && raw.player && x.id === raw.player.gym);
        if (g && g.gains && typeof g.gains === 'object') out.gym = { id: g.id, name: g.name, gains: { ...g.gains } };
        // The gyms that open next (0.40.0): only those in state 'next' carry `required` (energy trained to open them).
        out.gymsNext = raw.gyms.filter((x) => x && x.state === 'next' && Number.isFinite(x.required))
          .map((x) => ({ id: x.id, name: x.name, short: x.short || x.name, required: x.required, price: Number(x.price) || 0 }));
      }
      if (Number.isFinite(raw.gymEnergySpent)) out.gymSpent = raw.gymEnergySpent; // all energy ever spent training
      // Cat Café pet and brush (0.41.0): when each can be done again, and what it gives right now.
      if (raw.cafe && typeof raw.cafe === 'object') {
        const p = raw.cafe.pet || {}, b = raw.cafe.brush || {};
        out.cafe = { petAt: Number(p.readyAt) || 0, petGain: p.gain, petPrice: p.price, brushAt: Number(b.readyAt) || 0, brushGain: b.gain, brushPrice: b.price };
      }
      // Pier Nine (0.42.0): casts today, the bucket (each fish's grams, value and when it goes off) and the fish book.
      const pier = raw.pier && typeof raw.pier === 'object' ? readPier(raw.pier) : null;
      if (pier) out.pier = pier;
      // Your own recent attacks, for the half-XP tag (0.41.0). Attacking the same cat again within `repeatWindow` (3 h)
      // of your last attack on it gives half XP (checked on your saved fights; another cat's attack doesn't count).
      if (Array.isArray(raw.attacks) && raw.player && raw.player.id != null) {
        out.myAttacks = raw.attacks.filter((a) => a && a.attacker_id === raw.player.id && a.defender_id != null && Number(a.created_at) > 0)
          .map((a) => ({ id: a.id, victim: a.defender_id, name: a.defender || '', at: Number(a.created_at) }));
      }
      if (raw.combat && Number(raw.combat.repeatWindow) > 0) out.repeatWindow = Number(raw.combat.repeatWindow);
      // Other cats' gear, last seen in a fight (0.42.0). Each of your last 10 fights carries `state` (JSON text) with
      // both cats' level, max health and gear ids at the time. Your own side is skipped. Its other cats' stats are
      // never read (0.49.3): the game owner said they leaked by mistake (fixed 2026-11-12) and asked that they be
      // deleted and not shared.
      if (raw.player && raw.player.id != null) out.myId = raw.player.id;
      // Your own base stats, level and worn gear (0.49.0, user request: see the alliance's stats like fight records).
      // Only these few fields of `player`; they leave this browser only with sharing on (noteSelfGear).
      const pl = raw.player;
      if (pl && pl.id != null && [pl.strength, pl.defense, pl.speed, pl.dexterity].every(Number.isFinite)) {
        const self = { id: pl.id, n: pl.name || '', st: [pl.strength, pl.defense, pl.speed, pl.dexterity] };
        if (Number.isFinite(pl.level)) self.lv = pl.level;
        if (Array.isArray(raw.loadout)) {
          const slot = (k) => { const x = raw.loadout.find((l) => l && l.slot === k); return x && x.item ? String(x.item) : null; };
          Object.assign(self, { p: slot('primary'), s: slot('secondary'), t: slot('thrown'), a: slot('armor') });
        }
        out.selfCat = self;
      }
      out.gearNames = {};
      [...(Array.isArray(raw.gear) ? raw.gear : []), ...(Array.isArray(raw.throwables) ? raw.throwables : [])]
        .forEach((g) => { if (g && g.id && g.name) out.gearNames[g.id] = g.name; });
      out.fightCats = []; // from `attacks[].state`, which the game no longer sends (2026-11-12); fight pages still give gear
      (Array.isArray(raw.attacks) ? raw.attacks : []).forEach((a) => {
        let s = null;
        try { s = a && (typeof a.state === 'string' ? JSON.parse(a.state) : a.state); } catch (e) { s = null; }
        const at = a && Number(a.created_at);
        if (!s || !(at > 0)) return;
        [s.a, s.d].forEach((c) => { const r = c && c.id !== out.myId && gearRecord(c, at); if (r) out.fightCats.push(r); });
      });
      // Bank deposits still "open" (0.22.0): only the amount and end time. One past its end time is waiting to be
      // collected on the Feline Bank page ("broken" = taken out early, not counted).
      if (Array.isArray(raw.deposits)) {
        out.deposits = raw.deposits.filter((d) => d && d.status === 'open' && Number.isFinite(d.ends_at))
          .map((d) => ({ amount: Number(d.amount) || 0, rate: Number(d.rate) || 0, endsAt: d.ends_at }));
        out.depositsSeen = true; // this reply had the list (an empty one means none open)
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
      // bands[].minLevel is the level a PLANNER needs for that tier (a level 15 planner gets tier 3, minLevel 12). It
      // is NOT needed to join: a level 2 cat joined a tier 3 cold store (2026-10-21), and level 7 and 9 cats earlier.
      // So it is kept in the data but no longer shown as "Level N+" on heist messages (0.39.0).
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
      // Heist roles (0.39.0): the game's own `roles` list, [{ id, name, stat }]. Not the crew job table: a heist
      // Lockpicker uses strength, a crew job Lockpicker dexterity.
      if (Array.isArray(raw.roles)) {
        out.heistRoles = {};
        raw.roles.forEach((r) => { if (r && r.id) out.heistRoles[r.id] = { title: r.name || r.id, stat: r.stat || null }; });
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
          // Heists carry no seat count of their own; it's the game-wide heistRules.maxMembers (3). expires_at = when
          // recruiting closes (API log 2026-10-08).
          minMembers: h.minMembers, maxMembers: h.maxMembers || (raw.heistRules && raw.heistRules.maxMembers) || null, energy: h.energy, nerve: h.nerve,
          expiresAt: h.expires_at || null,
          members: (h.members || []).map((m) => ({ role: m.role, name: m.name })),
        }));
        // Heists of yours that finished or were scrapped in the last 6 hours: tells the crew bot to take their posts down.
        out.heistsDone = raw.heists.filter((h) => h && (h.status === 'completed' || h.status === 'cancelled') && h.closed_at > Date.now() - 6 * 3600000)
          .slice(0, 20).map((h) => h.id);
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
            shares: Number.isFinite(c.shares) ? c.shares : null, // your own; the game stops buying at perkShares
          })),
          history: (raw.stocks.history || []).map((h) => ({ id: h.company, price: h.price, at: h.at })),
        };
      }
      out.dailyCap = raw.rules && Number.isFinite(raw.rules.dailyConsumableCap) ? raw.rules.dailyConsumableCap : null;
      (raw.events || []).forEach((e) => {
        if (e && e.body && e.kind) out.events.push({ id: e.id, body: e.body, kind: e.kind, at: e.created_at });
      });
      if (Array.isArray(raw.courses)) {
        let eduCrimePoints = 0; let coursesTaken = 0; let eduLandsAt = null;
        raw.courses.forEach((c) => {
          if (!c) return;
          if (c.status === 'completed') {
            coursesTaken++;
            // The exact wording the DOM reader already looks for, taken from the course's own real text instead
            // of guessing at page text -- so it stays a general crime-success bonus, not a crime-specific one.
            // From the course's own numbers (0.34.0): "Casing a joint" says "+4 points ON every crime's success
            // chance" and the old "to every crime" text match missed it. A crimeChance add without a crime list
            // counts for every crime. The wording (to/on) is the fallback when `mods` has no readable key.
            let known = false;
            (Array.isArray(c.mods) ? c.mods : []).forEach((md) => {
              if (!md || md.key !== 'crimeChance') return;
              known = true;
              if (Number.isFinite(md.add) && !Array.isArray(md.crimes)) eduCrimePoints += md.add;
            });
            const m = !known && String(c.perk || '').match(/\+(\d+)\s*points?\s+(?:to|on)\s+every\s+crime.s\s+success\s+chance/i);
            if (m) eduCrimePoints += +m[1];
          } else if (Number.isFinite(c.ends_at)) {
            if (eduLandsAt == null || c.ends_at < eduLandsAt) eduLandsAt = c.ends_at;
          }
        });
        out.education = { eduCrimePoints, coursesTaken, eduLandsAt };
      }
      // Every piece of a crime's success "bonus", which the game only hands over already added up (user request,
      // 0.17.7: "we need to see where each % is coming from"). `crimes` limits a piece to those crimes (the game's
      // own crime ids, e.g. "fish"/"rooftop"); null = every crime. Inside line (out.crewPerkCrime) is added when
      // drawing, only while you are in a crew.
      out.crimeBonusParts = [];
      const addPart = (label, v, crimes) => { if (Number.isFinite(v) && v) out.crimeBonusParts.push({ label, v, crimes: crimes || null }); };
      const streetSense = ((raw.merits && raw.merits.lines) || []).find((l) => l && l.name === 'Street sense');
      if (streetSense) addPart('Street sense', streetSense.ranks);
      (raw.courses || []).forEach((c) => {
        if (!c || c.status !== 'completed') return;
        // Only a course's success-chance adds: its other `add` mods (heat per crime, say) are left out by checking
        // that it is either tied to named crimes or its perk text talks about success chance.
        (c.mods || []).forEach((m) => {
          // A district's crimes (Tide tables: "+4 points on every Dockside crime", mods { key: crimeChance, district:
          // 'docks' }): the ids of the crimes in that district.
          if (m && Number.isFinite(m.add) && m.key === 'crimeChance' && m.district) {
            addPart(c.name, m.add, (raw.crimes || []).filter((x) => x && x.district === m.district).map((x) => x.id));
            return;
          }
          if (m && Number.isFinite(m.add) && (Array.isArray(m.crimes) || /success chance/i.test(c.perk || ''))) addPart(c.name, m.add, Array.isArray(m.crimes) ? m.crimes : null);
        });
      });
      ((raw.stocks && raw.stocks.companies) || []).forEach((c) => {
        const m = c && c.perkOn && String(c.perk || '').match(/\+(\d+)\s*points?\s+to\s+every\s+crime/i);
        if (m) addPart(c.name + ' shares', +m[1]);
      });
      (raw.perks || []).forEach((p) => {
        if (!p || !p.owned) return;
        // "+3 points on Crate-jacking." or "+1 point to every crime’s success chance." (Master key, seen 2026-11-08).
        const m = String(p.description || '').match(/\+(\d+)\s*(?:points?\s+)?(?:on\s+(.+?)|to\s+(every crime.*?))\.?$/i);
        if (!m) return;
        if (m[3]) { addPart(p.name, +m[1]); return; }
        addPart(p.name, +m[1], /every crime/i.test(m[2]) ? null : [norm(m[2].replace(/^the\s+/i, '').replace(/['’]s success chance$/i, ''))]);
      });
      if (raw.crew && raw.crew.buffActive) addPart('crew chain', 5);
      // The game's own list of everything you have (`bonuses`, seen 2026-11-13: { source, line, from }), e.g. "+6 points
      // to every crime’s success chance" from "Inside line", "+3 points on Crate-jacking" from "Manifest access · Harbour
      // pilot", "+5% crime cash, +4 points on Fish market heist and Rooftop burglary". When it is there it replaces the
      // pieces above (it already has Inside line and the chain bonus): the game's words, so the split always matches.
      const fromList = crimeBonusesFromList(raw);
      if (fromList) { out.crimeBonusParts = fromList; out.bonusesFromGame = true; }
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
    if (ex) { apiState = ex; noteUses(ex.events); noteFightCats(); notePierFromState(); schedule(); shareCrew(); syncGear(); syncFish(); } // nothing in the DOM changed, so redraw by hand to pick up the new numbers
  }

  // ─── Tuna / catnip uses today (0.30.0, user request) ──────────────────────
  // The game caps each at `rules.dailyConsumableCap` (12) a day, resetting 00:00 UTC, but sends no running count --
  // only `usedUp` once you hit it. Each use is a Mews event ("Used Premium tuna. Restored 25 energy.", kind "use"),
  // and the last 20 events come with every state and action reply (the Mews page has 50), so the script counts
  // today's by event id (each counted once, across tabs). Uses made elsewhere (another device) are only counted if
  // they're still in a list the script sees.
  const USES_KEY = 'ms_daily_uses_v1'; // { day: 'YYYY-MM-DD' (UTC), tuna: [event ids], catnip: [event ids] }
  const USE_FAMILY = [[/^Used Premium tuna\b/i, 'tuna'], [/^Used Catnip tea\b/i, 'catnip']];
  const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
  function loadUses() {
    const u = GM_getValue(USES_KEY, null);
    const today = utcDay(Date.now());
    return u && u.day === today ? u : { day: today, tuna: [], catnip: [] };
  }
  function noteUses(events) {
    const u = loadUses();
    const dayStart = Date.parse(u.day + 'T00:00:00Z');
    let changed = false;
    (events || []).forEach((e) => {
      if (!e || e.kind !== 'use' || e.id == null || !(e.at >= dayStart)) return;
      const fam = (USE_FAMILY.find(([re]) => re.test(String(e.body))) || [])[1];
      if (!fam || u[fam].includes(String(e.id))) return;
      u[fam].push(String(e.id)); changed = true;
    });
    if (changed) GM_setValue(USES_KEY, u);
  }
  function onMewsResponse(json) {
    const rows = json && Array.isArray(json.rows) ? json.rows : null;
    if (rows) { const ev = rows.map((r) => ({ id: r.id, body: r.body, kind: r.kind, at: r.at })); noteUses(ev); noteBaitPrices(ev); schedule(); }
  }

  // Only a full state is taken (an error reply, e.g. { error }, would otherwise blank everything).
  function onActionResponse(json) {
    if (json && typeof json === 'object' && json.player && Array.isArray(json.crimes)) onApiStateResponse(json);
  }

  function installApiWatch() {
    const pathOf = (url) => { try { return new URL(url, location.href).pathname; } catch (e) { return ''; } };
    // /api/state everywhere; /api/merits is what the Merits page itself loads (for the hidden feats, 0.22.0).
    // /api/players is the Players page's own list of every cat (0.25.0, the "No crew" list).
    // /api/action (0.28.0): the reply to every crime, train, deposit... carries the whole state too, so the numbers
    // (crew chain, nerve, heat, odds) update the moment you act instead of on the next page load.
    // /api/stocks/chart (0.32.0) is the stock page's own price chart, used for the market trend line.
    // /api/crew/contracts (0.34.0) is the Crew > Contracts tab's own reply: what each crew contract counts.
    // /api/crew/attacks (0.35.0) is the Crew > Crew attacks log: mugs by the crew, for the 💰 muggable mark.
    const HANDLERS = { '/api/state': onApiStateResponse, '/api/action': onActionResponse, '/api/mews': onMewsResponse, '/api/merits': onMeritsResponse, '/api/players': onPlayersResponse, '/api/stocks/chart': onStockChartResponse, '/api/crew': onCrewResponse, '/api/crew/contracts': onCrewContractsResponse, '/api/crew/attacks': onCrewAttacksResponse, '/api/crew/attack': onCrewAttackResponse, '/api/pier': onPierResponse, '/api/crew/chains': onChainHistoryResponse, '/api/heists/history': onHeistHistoryResponse };
    // /api/crew/chains and /api/heists/history (0.49.5): the Crew page's chain history and the Heists page's history,
    // for the crew bot's ⛓️ chain report and ✅ heist results (crew sharing only).
    // /api/fight/<code> (0.42.0) is a fight page's own reply: both cats' gear, for the ⚔️ record. /api/pier and anything
    // under it (0.42.0): the Pier page's weekly board, and the pier itself if a cast's reply carries it.
    const handlerFor = (path) => HANDLERS[path] || (/^\/api\/fight\/[\w-]+$/.test(path) ? onFightResponse : /^\/api\/pier\//.test(path) ? onPierResponse : null);
    const realFetch = pageWin.fetch;
    if (typeof realFetch === 'function') {
      pageWin.fetch = function (...args) {
        const p = realFetch.apply(this, args);
        p.then((res) => {
          try { const h = res && res.url && handlerFor(pathOf(res.url)); if (h) res.clone().json().then(h).catch(() => {}); } catch (e) { /* ignore */ }
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
          try { const h = this.__msxUrl && handlerFor(pathOf(this.__msxUrl)); if (h && this.responseText) h(JSON.parse(this.responseText)); } catch (e) { /* ignore */ }
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

  // At 80 heat and up a district pays half the XP and turns no clean job at all; the game's own `hot` flag wins
  // whenever its data has been seen (the job pages' heat lock).
  const HOT_HEAT = 80;

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

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const STYLE_ID = 'msx-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
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
      #msx-crimetable { margin-top:14px; padding:10px 12px; border-radius:10px; background:rgba(0,0,0,.28); font-size:12.5px; }
      #msx-crimetable h3 { margin:0 0 6px; font-size:14px; }
      #msx-crimetable table { border-collapse:collapse; width:100%; }
      #msx-crimetable th, #msx-crimetable td { padding:3px 10px 3px 0; text-align:left; white-space:nowrap; }
      #msx-crimetable th { color:var(--ms-smoke, #8d9289); font-weight:600; }
      #msx-crimetable td.msx-best { color:var(--ms-lime, #b4df87); font-weight:700; }
      #msx-crimetable small { display:block; margin-top:6px; color:var(--ms-smoke, #8d9289); }
      .cs-dock .msx-pernerve { margin:4px 0 0; font-size:11.5px; color:var(--ms-smoke, #8d9289); }
      .cs-dock .msx-chance { margin:4px 0 0; font-size:12px; }
      .cs-dock .msx-chance b { color:var(--ms-lime, #b4df87); font-size:17px; font-weight:800; margin-right:4px; } /* user: make it stand out */
      .cs-dock .msx-chance small { color:var(--ms-smoke, #8d9289); font-size:11px; }
      .cs-dock .cs-risk > span.msx-tool-link { cursor:pointer; }
      .cs-dock .cs-risk > span.msx-tool-link:hover { text-decoration:underline; }
      .cs-dock .msx-croplock { display:flex; flex-direction:column; gap:4px; margin-top:6px; }
      .msx-odds .msx-odds-body { margin-top:2px; }
      .msx-odds .msx-unk { color:var(--ms-gold, #e9c46a); }
      .msx-tag { padding:1px 7px; border-radius:999px; font-size:11px; font-weight:700; }
      .msx-tag.xp { background:var(--ms-lime, #b4df87); color:var(--ms-ink, #182316); }
      .msx-tag.cash { background:var(--ms-gold, #e9c46a); color:var(--ms-ink, #182316); }
      .msx-stock { display:flex; flex-wrap:wrap; gap:4px 8px; align-items:center; margin-top:4px; font-weight:400; }
      .msx-stock small { color:var(--ms-smoke, #8d9289); font-size:11px; }
      a.xr-screen.msx-low { outline:2px solid var(--ms-lime, #b4df87); outline-offset:-2px; }
      a.xr-screen.msx-high { outline:2px solid var(--ms-red, #eb6561); outline-offset:-2px; }
      a.xr-screen .msx-price-low { color:var(--ms-lime, #b4df87) !important; }
      a.xr-screen .msx-price-high { color:var(--ms-red, #eb6561) !important; }
      a.xr-screen .msx-price-mid { color:#fff !important; }
      .msx-stock.msx-stock-card { flex-basis:100%; width:100%; margin:0; padding-top:6px; border-top:1px dashed var(--ms-line, rgba(231,237,225,.15)); justify-content:center; }
      .msx-stock .msx-range b { color:var(--ms-bone, #e7ede1); }
      .msx-stock .msx-trend { font-size:13px; }
      .msx-stock small.msx-mtrend { flex-basis:100%; text-align:center; color:var(--ms-bone, #e7ede1); }
      .msx-stock small.msx-mtrend.rising b { color:var(--ms-lime, #b4df87); }
      .msx-stock small.msx-mtrend.stalled b { color:var(--ms-gold, #e9c46a); }
      .msx-stock small.msx-mtrend.falling b { color:var(--ms-red, #eb6561); }
      .msx-stock .msx-moves, .msx-stock .msx-range, .msx-stock .msx-perk-status, .msx-stock .msx-rangeset { flex-basis:100%; }
      .msx-stock.msx-stock-card > * { text-align:center; }
      /* A stock you hold none of: the game's purchases area is just "Nothing bought yet"; stack the box under it. */
      .xr-blocks.is-empty:has(> .msx-stock-card) { display:block; text-align:center; }
      .msx-stock .msx-rangeset input { width:4.5em; padding:1px 4px; font:inherit; color:var(--ms-bone, #e7ede1); background:transparent; border:1px solid var(--ms-line, rgba(231,237,225,.25)); border-radius:4px; text-align:center; }
      .msx-stock .msx-perk-status b { color:var(--ms-lime, #b4df87); }
      .msx-stock .msx-moves b { font-weight:700; color:var(--ms-bone, #e7ede1); }
      .msx-stock .msx-moves b.up { color:var(--ms-lime, #b4df87); }
      .msx-stock .msx-moves b.down { color:var(--ms-red, #eb6561); }
      .msx-stock .msx-moves i { font-style:normal; opacity:.7; }
      #msx-invest, #msx-heists, #msx-crewjobs, #msx-trading { margin:18px 0; padding:12px 16px; border-radius:12px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); color:var(--ms-bone, #e7ede1); font-size:13px; }
      #msx-invest summary { cursor:pointer; font-size:16px; font-weight:700; }
      .msx-players { margin:0 0 12px; padding:8px 14px; border-radius:12px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); color:var(--ms-bone, #e7ede1); font-size:13px; }
      .msx-players summary { cursor:pointer; font-weight:700; }
      .msx-players small, .msx-players .msx-nc-note { color:var(--ms-smoke, #8d9289); font-weight:400; }
      .msx-players .msx-nc-note { margin:6px 0; font-size:12px; }
      .msx-players ul { margin:6px 0 2px; padding-left:18px; max-height:260px; overflow-y:auto; line-height:1.6; }
      .msx-players a.msx-cat-link { color:inherit; text-decoration:none; }
      .msx-players a.msx-cat-link:hover b { text-decoration:underline; color:#9ecbff; }
      .msx-players .msx-nc-new { color:var(--ms-lime, #b4df87); }
      #msx-heists h2, #msx-crewjobs h2, #msx-trading h2 { margin:0; font-size:16px; font-weight:700; }
      #msx-invest h4 { margin:14px 0 6px; font-size:13px; color:var(--ms-lime-light, #d3f0b4); }
      #msx-invest .msx-inv-note, #msx-heists .msx-inv-note, #msx-crewjobs .msx-inv-note, #msx-trading .msx-inv-note { margin:8px 0; color:var(--ms-smoke, #8d9289); }
      #msx-gymlock { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:8px 0 4px; font-size:12px; color:var(--ms-smoke, #8d9289); }
      #msx-gymlock .msx-gl-chip { padding:3px 9px; border-radius:999px; border:1px solid var(--ms-line, rgba(231,237,225,.2)); background:rgba(0,0,0,.25);
        color:var(--ms-bone, #e7ede1); font:inherit; cursor:pointer; }
      #msx-gymlock .msx-gl-chip:hover { border-color:var(--ms-lime, #b4df87); }
      #msx-gymlock .msx-gl-chip.locked { color:var(--ms-red, #eb6561); border-color:var(--ms-red, #eb6561); background:rgba(235,101,97,.12); }
      #msx-gymlock label { display:inline-flex; align-items:center; gap:4px; cursor:pointer; }
      #msx-gymlock .msx-gl-note { flex-basis:100%; color:var(--ms-red, #eb6561); }
      #msx-gymnext { margin:2px 0 6px; font-size:12px; color:var(--ms-smoke, #8d9289); text-align:center; }
      #msx-gymnext b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      .co-plate .msx-gymtogo { display:block; font-size:10px; line-height:1.2; color:var(--ms-smoke, #8d9289); white-space:nowrap; }
      #msx-gymfig { margin:4px 0; font-size:12px; color:var(--ms-bone, #e7ede1); }
      .tf-members th.msx-sorthead { cursor:pointer; }
      .tf-members th.msx-sorthead .msx-sortmark { color:var(--ms-lime, #b4df87); }
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
      .msx-heatlock button.msx-heat-toggle { margin-left:2px; }
      .msx-feat-how { margin-top:3px; font-size:12px; color:var(--ms-lime, #b4df87); }
      .msx-feat-how b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      #msx-trading .msx-trade-key { padding-left:18px; font-size:12px; line-height:1.5; }
      #msx-trading .msx-trade-key b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      .msx-ws { display:flex; flex-direction:column; gap:2px; margin-top:6px; padding:6px 8px; border-radius:8px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); font-size:11.5px; line-height:1.35; color:var(--ms-smoke, #8d9289); font-weight:400; }
      .msx-ws b { color:var(--ms-bone, #e7ede1); font-weight:600; }
      .msx-ws .msx-ws-disc b { color:var(--ms-lime, #b4df87); }
      .ws-row.msx-ws-focus { outline:2px solid var(--ms-lime, #b4df87); outline-offset:4px; border-radius:10px; transition:outline-color .4s; }
      .sidebar .brand:has(.msx-clock) { min-width:0; }
      .sidebar .brand:has(.msx-clock) .brand-logo { flex:0 1 auto; min-width:0; }
      .msx-clock { display:inline-flex; flex:none; color:var(--ms-lime, #b4df87); cursor:default; }
      .msx-clock-row { margin:2px 0 6px; text-align:center; font-size:11px; color:var(--ms-smoke, #8d9289); font-variant-numeric:tabular-nums; white-space:nowrap; cursor:default; }
      a.msx-pill-link { text-decoration:none; color:var(--ms-bone, #e7ede1); cursor:pointer; }
      a.msx-pill-link:hover { border-color:var(--ms-lime, #b4df87); }
      .msx-consumable { flex-wrap:wrap; row-gap:4px; }
      .msx-consumable .msx-item { display:inline-flex; align-items:center; gap:4px; }
      .msx-consumable .msx-itemcol { display:inline-flex; flex-direction:column; gap:2px; }
      .msx-consumable .msx-itemcol:not(:last-child) { margin-right:14px; }
      .msx-shopprice { display:inline-flex; align-items:center; gap:4px; font-size:11px; }
      .msx-shopprice small { color:var(--ms-smoke, #8d9289); font-size:10px; }
      .msx-shopprice.old { opacity:.55; }
      .msx-shopprice svg.msx-goldbag { display:block; margin-left:-2px; }
      .msx-shopprice svg.msx-shopico { display:block; flex:none; color:var(--ms-smoke, #8d9289); }
      .msx-pq { font-weight:700; padding:0 4px; border-radius:4px; }
      .msx-pq-top { color:#9a9a9a; background:#0b0b0b; }
      .msx-pq-high { color:var(--ms-red, #eb6561); }
      .msx-pq-mid { color:var(--ms-gold, #e9c46a); }
      .msx-pq-low { color:var(--ms-lime, #b4df87); }
      .msx-item-icon { width:30px; height:30px; flex:none; }
      #msx-invest .msx-inv-chart { width:100%; max-width:480px; height:auto; color:var(--ms-bone, #e7ede1); }
      #msx-invest .msx-inv-legend { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:12px; }
      #msx-invest .msx-inv-legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; }
      .msx-tag.stk.low { background:var(--ms-lime, #b4df87); color:var(--ms-ink, #182316); }
      .msx-tag.stk.high { background:var(--ms-red, #eb6561); color:var(--ms-ink, #182316); }
      .msx-tag.stk.mid, .msx-tag.stk.flat, .msx-tag.stk.risehigh { background:var(--ms-slate, #2e342d); color:var(--ms-bone, #e7ede1); }
      .msx-tag.stk.learn { background:transparent; color:var(--ms-smoke, #8d9289); border:1px dashed var(--ms-smoke, #8d9289); }
      .msx-tag.hot { background:var(--ms-red, #eb6561); color:var(--ms-ink, #182316); }
      .msx-crimeheat { font-size:12px; margin:2px 0 4px; color:var(--ms-smoke, #8d9289); }
      .msx-crimeheat b { color:var(--ms-ink, #e7ede1); }
      .msx-crimeheat.hot, .msx-crimeheat.hot b { color:var(--ms-red, #eb6561); }
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); font-size:12px; color:var(--ms-bone, #e7ede1); }
      #msx-account { margin:18px 0; padding:16px 18px; border-radius:12px; background:rgba(0,0,0,.28);
        border:1px solid var(--ms-line, rgba(231,237,225,.15)); color:var(--ms-bone, #e7ede1); font-size:13px; line-height:1.5; }
      #msx-account h2 { margin:0 0 2px; font-size:17px; }
      #msx-account h3 { margin:16px 0 6px; font-size:13px; color:var(--ms-lime-light, #d3f0b4); }
      #msx-account .msx-acc-key { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
      #msx-account .msx-acc-key input { flex:1 1 220px; min-width:0; padding:4px 6px; font:inherit; color:inherit; background:transparent; border:1px solid var(--ms-line, rgba(231,237,225,.25)); border-radius:4px; }
      #msx-account .msx-acc-key .msx-bad { color:var(--ms-red, #eb6561); }
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
      .msx-rail { display:flex; flex-direction:column; background:rgba(0,0,0,.28); }
      .msx-rail > .msx-ticker { margin:0; border:0; border-radius:0; background:transparent; padding:6px 10px; }
      .msx-rail > .msx-ticker + .msx-ticker { border-top:1px solid var(--msx-rail-line, var(--ms-line, rgba(231,237,225,.15))); }
      .msx-rail > .msx-ticker.soon { color:var(--ms-gold, #e9c46a); }
      .msx-uses { opacity:.75; font-size:10.5px; }
      .msx-uses.full { opacity:1; color:var(--ms-gold, #e9c46a); }
      .msx-crewjob-inline { margin-left:2px; padding-left:8px; border-left:1px dashed var(--ms-line-strong, rgba(231,237,225,.3)); }
      .msx-chain > .msx-crewjob-inline:first-of-type { margin-left:0; padding-left:0; border-left:0; }
      .msx-crewjob-inline.soon { color:var(--ms-gold, #e9c46a); }
      /* Crew things are light blue (user request, 0.34.0): the sidebar crew box, crew contracts, crew job boxes. */
      :root { --msx-crew:#8fcbff; }
      .msx-rail > .msx-ticker.msx-chain, .msx-ticker.msx-chain { flex-wrap:wrap; box-shadow:inset 0 0 0 1px var(--msx-crew); background:rgba(143,203,255,.07); }
      .msx-chain > .ms-icon { color:var(--msx-crew); }
      .msx-contracts { flex-basis:100%; display:grid; gap:1px; font-size:11px; }
      .msx-contracts .msx-ct-head { color:var(--msx-crew); font-weight:600; }
      .msx-contracts .msx-ct { display:flex; justify-content:space-between; gap:8px; }
      .msx-contracts .msx-ct b { font-weight:600; }
      .msx-contracts .msx-ct.done { opacity:.55; }
      .msx-contracts .msx-ct.off { opacity:.55; }
      .msx-statsnudge { flex-basis:100%; font-size:11px; font-weight:600; color:var(--msx-crew); text-decoration:none; }
      .msx-statsnudge:hover { text-decoration:underline; }
      .msx-hittook { margin-left:6px; font-size:11px; font-weight:700; color:var(--ms-red, #e8846f); }
      a.msx-crew-ct { outline:2px solid var(--msx-crew); outline-offset:2px; border-radius:6px; }
      #msx-crimetable tr.msx-crew-row td:first-child { box-shadow:inset 3px 0 0 var(--msx-crew); padding-left:6px; }
      #msx-crimetable .msx-ct-chip { margin-left:6px; padding:0 6px; border-radius:999px; font-size:11px; color:var(--msx-crew); border:1px solid var(--msx-crew); }
      .cs-dock.msx-crew-dock { outline:2px solid var(--msx-crew); outline-offset:3px; }
      .msx-ct-line, #msx-ct-banner { margin:8px 0; padding:6px 10px; border-radius:8px; font-size:12.5px; color:var(--ms-bone, #e7ede1);
        background:rgba(143,203,255,.08); border:1px solid var(--msx-crew); }
      .msx-ct-line b, #msx-ct-banner b { color:var(--msx-crew); }
      .msx-ct-line small, #msx-ct-banner small { color:var(--ms-smoke, #8d9289); }
      #msx-crewjobs { border-color:var(--msx-crew); }
      .msx-xpline { margin-top:2px; font-size:11px; line-height:1.3; color:var(--ms-smoke, #8d9289); font-variant-numeric:tabular-nums; }
      .msx-muggable { display:inline-flex; align-items:center; vertical-align:middle; margin-left:4px; cursor:help; }
      .msx-muggable svg { display:block; }
      .msx-halfxp { margin-left:4px; font-size:11px; color:var(--ms-gold, #e9c46a); white-space:nowrap; cursor:help; vertical-align:middle; }
      .cp-chips > .msx-halfxp { margin-left:0; }
      .msx-geartag { margin-left:4px; font-size:12px; cursor:help; vertical-align:middle; }
      .msx-geartag.msx-hasstats { font-size:11px; color:var(--ms-smoke, #8d9289); white-space:nowrap; font-variant-numeric:tabular-nums; }
      #msx-catgear { margin:8px 0; padding:6px 10px; border-left:3px solid var(--ms-gold, #e9c46a); font-size:12px; line-height:1.5; }
      #msx-catgear .msx-catgear-stats { opacity:.85; }
      .msx-cafe b, .msx-pier b { font-weight:600; }
      #msx-pierlog { margin:10px 0; padding:8px 12px; border-left:3px solid var(--ms-gold, #e9c46a); font-size:12px; line-height:1.55; }
      #msx-pierlog .msx-pierlog-t { font-weight:600; margin-bottom:4px; }
      .msx-kpay { margin-top:8px; padding-top:6px; border-top:1px dashed var(--ms-line, rgba(231,237,225,.15)); font-size:12px; }
      .msx-kpay-h b, .msx-kpay-me b { color:var(--ms-gold, #e9c46a); }
      .msx-kpay-me { margin-top:2px; }
      .msx-kpay-all summary { cursor:pointer; opacity:.8; margin-top:2px; }
      .msx-kpay-all div { padding-left:10px; }
      .msx-kpay-all span { opacity:.6; font-size:11px; }
      #msx-pierlog .msx-pf { width:100%; border-collapse:collapse; margin-top:6px; font-variant-numeric:tabular-nums; }
      #msx-pierlog .msx-pf th { text-align:left; font-weight:600; font-size:10px; text-transform:uppercase; letter-spacing:.05em; opacity:.7; padding:2px 8px 2px 0; }
      #msx-pierlog .msx-pf td { padding:3px 8px 3px 0; vertical-align:top; border-top:1px solid rgba(141,146,137,.2); }
      #msx-pierlog .msx-pf td:nth-child(4), #msx-pierlog .msx-pf td:nth-child(5) { white-space:nowrap; }
      #msx-pierlog .msx-pf-dim { opacity:.7; font-size:11px; }
      #msx-pierlog .msx-pf-now { color:var(--ms-lime, #b4df87); font-weight:700; cursor:help; }
      #msx-pierlog .msx-pf tr.now td { background:rgba(180,223,135,.06); }
      .msx-lowtag { margin-left:6px; padding:0 6px; border-radius:999px; font-size:11px; white-space:nowrap; cursor:help;
        color:var(--ms-bone, #e7ede1); background:rgba(0,0,0,.3); border:1px solid var(--ms-line-strong, rgba(231,237,225,.3)); }
      #msx-toast { position:fixed; right:12px; bottom:calc(56px + env(safe-area-inset-bottom, 0px)); z-index:9999; max-width:min(360px, calc(100vw - 24px));
        padding:10px 12px; border-radius:10px; background:var(--ms-asphalt, #1c201c); color:var(--ms-bone, #e7ede1);
        border:1px solid var(--ms-lime, #b4df87); font-size:12px; line-height:1.4; opacity:0; pointer-events:none; transition:opacity .2s; }
      #msx-toast.show { opacity:1; }
      .msx-rungtip { margin:4px 0 0; font-size:12px; color:var(--ms-lime, #b4df87); }
    `;
    document.head.appendChild(s);
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
      // The game's own list already has Inside line in it; only the older reckoning adds it here.
      const inside = apiState && Number.isFinite(apiState.crewPerkCrime) ? apiState.crewPerkCrime : loadDb().mods?.crewPerkCrime;
      if (apiState && !apiState.bonusesFromGame && apiState.crew && inside) parts.push({ label: 'Inside line', v: inside });
      const other = a.bonus - parts.reduce((s, p) => s + p.v, 0);
      parts.forEach((p) => bits.push(`${fmt(p.v)} ${escHtml(p.label)}`));
      if (other) bits.push(`<span class="msx-unk" title="Part of the game's bonus that none of the known sources explain">${fmt(other)} other</span>`);
    }
    if (heatPts) bits.push(`${fmt(-heatPts)} heat`);
    const sum = a.baseChance + (a.masteryBonus || 0) + (a.bonus || 0) - heatPts;
    const cap = Number.isFinite(a.ceiling) ? a.ceiling : 95;
    const capped = a.chance === cap && sum > cap;
    const end = capped ? `= ${sum} → capped at ${cap}%` : `= ${a.chance}%`;
    const crew = apiState && apiState.crew;
    const crewNote = crew && crew.buffActive && crew.buffUntil > Date.now()
      ? ` The crew +5% window ends in ${Math.max(1, Math.round((crew.buffUntil - Date.now()) / 60000))} min (${new Date(crew.buffUntil).toUTCString().slice(17, 22)} UTC).` : '';
    const critNote = a.criticalChance != null ? ` Clean-job chance: ${a.criticalChance}%.` : '';
    const title = ('Exact numbers from the game\'s own data: base success + mastery bonus + bonus (merits, education, crew and perks, already combined by the game) − 1 per 4 heat, capped at the most the job allows (96–99% since 2026-11-08).' + crewNote + critNote).replace(/"/g, '&quot;');
    return oddsDetails(c.key, title, `${bits.join(' ')} ${end}`);
  }

  // ─── Heat lock (Crimes page) ──────────────────────────────────────────────
  // User request (0.17.7): at 80 heat and up (half XP, no clean jobs) a crime's own Attempt button is disabled
  // until the district cools to 79, with an "Unlock anyway" button per district. Same idea as the Cat Tree lock:
  // the script never clicks or attempts anything, it only blocks your own click. Button from a dev-tools capture
  // (Screenshot 338). Since the 2026-10-10 rebuild it is the job page's nerve buttons (applyCrimeLocks); an override lasts
  // until the district cools.
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

  // ─── Tool chips -> Whiskers & Co. (Crimes page) ───────────────────────────
  // User request (0.18.1): clicking a crime's tool chip ("Fake manifest none", "Crowbar ×1") opens Whiskers & Co.
  // and scrolls to that tool. Your own click, a plain page change. Chip from a dev-tools capture (Screenshot 339):
  // since the rebuild, the job page's dock: p.cs-risk / p.cs-gear > span ("Bolt cutters ×9").
  const toolName = (chip) => chip.textContent.replace(/\s*(none|×\s*\d+|x\s*\d+)\s*$/i, '').trim();
  document.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('.cs-dock .cs-risk > span, .cs-dock .cs-gear > span');
    if (!chip) return;
    const name = toolName(chip);
    location.assign('/whiskers' + (name ? '#msx-item=' + encodeURIComponent(name) : ''));
  });

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
    // The next-tick time is exact here and the same for every company (0.34.0: taken on any page; it used to wait
    // for a stock already recorded by name, which only the stock page did, hence "open Claw Street Ex once").
    (apiState.stocks.companies || []).forEach((c) => {
      if (c && Number.isFinite(c.nextTick) && Math.abs(c.nextTick - nextMoveAnchor) > 2000) {
        nextMoveAnchor = c.nextTick;
        try { GM_setValue(NEXT_MOVE_KEY, c.nextTick); } catch (e) { /* ignore */ }
      }
    });
    if (changed) { db.updated = now; saveDb(db); }
  }

  // ─── Settings (kept on this computer, edited on the Account page) ─────────
  const SETTINGS_KEY = 'ms_settings_v1';
  // shareOff (0.49.2, user request 2026-11-12): sharing is on unless switched off on the Account page. The old
  // shareCrew switch (off by default until 0.49.1) is no longer read, so every install starts on.
  // shareStats: opt-in, alliance crews only (0.49.4, user request); statsNudgeOff: hide the sidebar reminder to share them.
  const DEFAULT_SETTINGS = { events: true, shareOff: false, shareStats: false, statsNudgeOff: false };
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(GM_getValue(SETTINGS_KEY, 'null'));
    if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) { /* use the defaults */ }
  function saveSettings() {
    try { GM_setValue(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // ─── Sharing with The Purrfessionals' Discord bot (0.19.0; on by default since 0.49.2) ────────────
  // ON unless switched off on the Account page (user request 2026-11-12). Crew 2's members also send their crew's
  // summary each time the game's own /api/state passes by: crew name, chain count and end time, and the crew's
  // active jobs (seats, members' names/levels, payout) -- the same things the Crew page already shows. Never your
  // account, cash, email or messages. Nothing is ever sent to MeowStreets itself.
  const CREW_BOT_URL = 'http://168.138.79.225:3001/v1/crew';
  const CONTRACT_CUT_KEY = 'ms_contract_cut_v1'; // { cut, ends, paid: { contractId: [catId] }, at } from the crew bot's replies
  const LOAN_CATS_KEY = 'ms_loan_cats_v1'; // [catId] with an open 💳 bank loan, from the crew bot's replies
  const CREW_BOT_FEATS_URL = 'http://168.138.79.225:3001/v1/feats'; // hidden feats found by the crew (Merits page)
  const SHARE_MIN_GAP_MS = 15000; // at most one update every 15 seconds
  const SHARE_ID_KEY = 'ms_share_id_v1';
  // Who gets what (0.48.0; 0.49.2, user request 2026-11-12): everyone sends the pooled city data they see (stock
  // prices, fight stats and gear, pier fish, hidden feats, mastery unlocks) and gets it back, except other cats'
  // battle stats and gear: those come back to the alliance crews only (gearPoolOn), which the bot enforces from the
  // cat id. Crew 2 (ours) alone has the crew features (chain, jobs, heists, contracts, treasury, deposits). Each message carries your
  // cat id from the game's own data: the bot checks it is on that crew's live member list.
  const SHARE_CREW_ID = 2;
  const ALLIANCE_CREW_IDS = [2, 3, 4, 10, 11]; // The Purrfessionals, Cats With Attitude, The Church of Meowology (joined 2026-11-12), The Meowfia Cat$, Night Watch
  const inShareCrew = () => !!(apiState && apiState.crew && ALLIANCE_CREW_IDS.includes(apiState.crew.id));
  const inOwnCrew = () => !!(apiState && apiState.crew && apiState.crew.id === SHARE_CREW_ID);
  const sharingOn = () => !settings.shareOff && !!(apiState && apiState.myId); // sends what you see
  const gearPoolOn = () => sharingOn() && inShareCrew(); // ...and gets other cats' battle stats and gear back
  const crewSharingOn = () => gearPoolOn() && inOwnCrew();
  // No crew: { name: null, id: null } (the bot checks the cat id alone).
  const shareCrewRef = () => ({ name: (apiState.crew && apiState.crew.name) || null, id: (apiState.crew && apiState.crew.id) || null, cat: apiState.myId || null });
  // Crew chain mode (0.23.0–0.33.x) was retired in 0.34.0: a failed crime no longer costs the crew chain anything
  // (API log "ubernew", 2026-10-20), so no crime can shrink it. Code kept in Archive/chain-mode/.
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
    const body = { v: 1, sender: shareId(), crew: { name: c.name, id: c.id, cat: apiState.myId || null, chain: c.chain, chainEndsAt: c.chainEndsAt, seenAt: apiState.at } };
    if (apiState.crewJobsSeen) {
      body.jobs = (apiState.myCrewJobs || []).map((j) => ({
        id: j.id, name: j.name, tier: j.tier, minLevel: j.minLevel, status: j.status, roles: j.roles,
        members: (j.members || []).map((m) => ({ role: m.role, name: m.name, level: m.level })),
        minMembers: j.minMembers, maxMembers: j.maxMembers, endsAt: j.endsAt,
        cut: j.cut, take: j.take, respect: j.respect, nerve: j.nerve, stake: j.stake, chance: j.chance,
      }));
      body.roleTitles = apiState.crewJobRoles || {};
    }
    // Heists you are in (0.32.0), for the bot's heist posts; only when the game sent
    // its heist list. Member names and roles, never ids.
    if (Array.isArray(apiState.heistsDone)) {
      body.heists = (apiState.myHeists || []).map((h) => ({
        id: h.id, name: h.name, tier: h.tier, minLevel: h.minLevel, status: h.status,
        members: (h.members || []).map((m) => ({ role: m.role, name: m.name })),
        minMembers: h.minMembers, maxMembers: h.maxMembers, endsAt: h.endsAt, expiresAt: h.expiresAt,
        stake: h.stake, profit: h.profit, failReturn: h.failReturn, chance: h.chance, energy: h.energy, nerve: h.nerve,
      }));
      body.heistsDone = apiState.heistsDone;
      if (apiState.heistRoles) body.heistRoles = apiState.heistRoles;
    }
    // The highest cat id seen on the Players page (0.44.1, user request): the game's API can't say how many cats
    // there are, so the crew bot's 🧲 Recruits list reads up to this id instead of guessing.
    const newest = newestCatSeen();
    if (newest > 0) body.newestCat = newest;
    // This week's contract rewards from Crew → Contracts (0.44.1, user request), for the bot's 💰 Contract pay.
    const pay = contractPayForBot();
    if (pay) body.contractPay = pay;
    // Treasury payments to members from the Crew page (0.44.3), so the bot can tick contract pay off by itself.
    // Finished chains and your recent heist results (0.49.5), only once you have opened those histories.
    Object.assign(body, historyForBot());
    const tp = treasuryPaysForBot();
    if (tp) body.treasuryPays = tp;
    // Your open bank deposits (0.46.6, user request: a 💳 bank loan's interest share, how much and when), only when
    // the bot's last reply named your cat id as having one (`loanCats`), so nobody else's deposits are ever sent.
    const lc = GM_getValue(LOAN_CATS_KEY, []);
    if (apiState.myId && Array.isArray(lc) && lc.includes(apiState.myId) && apiState.depositsSeen) {
      body.me = apiState.myId;
      body.deposits = apiState.deposits.map((d) => ({ amount: d.amount, rate: d.rate, endsAt: d.endsAt }));
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
        // The crew's cut of contract rewards and who's been paid, set by the leaders on the bot (0.44.2), and who skips
        // their pay (0.45.1, 🚫 on the bot).
        if (j && j.contractPay && typeof j.contractPay === 'object' && Number.isFinite(Number(j.contractPay.cut))) {
          GM_setValue(CONTRACT_CUT_KEY, { cut: Number(j.contractPay.cut), ends: Number(j.contractPay.ends) || null, paid: j.contractPay.paid && typeof j.contractPay.paid === 'object' ? j.contractPay.paid : {},
            skip: Array.isArray(j.contractPay.skip) ? j.contractPay.skip.map(Number).filter(Number.isFinite) : [], at: Date.now() });
          schedule();
        }
        if (j && Array.isArray(j.loanCats)) {
          const ids = j.loanCats.map(Number).filter(Number.isInteger);
          if (JSON.stringify(ids) !== JSON.stringify(GM_getValue(LOAN_CATS_KEY, []))) GM_setValue(LOAN_CATS_KEY, ids);
        }
        if (done) done(j || { ok: false, error: 'bad reply (' + r.status + ')' });
      },
      onerror: () => { if (done) done({ ok: false, error: 'could not reach the crew bot' }); },
      ontimeout: () => { if (done) done({ ok: false, error: 'the crew bot did not answer' }); },
    });
  }

  // Sends only when something changed, and at most once per SHARE_MIN_GAP_MS (a late change waits for the gap).
  function shareCrew() {
    if (!crewSharingOn()) return;
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
    if (!sharingOn() || stockSyncBusy) return;
    if (typeof GM_xmlhttpRequest !== 'function') return;
    if (!force && Date.now() - stockSyncAt < STOCK_SYNC_GAP_MS) return;
    const out = [];
    Object.entries(loadDb().stocks).forEach(([id, rec]) => (rec.obs || []).forEach((o) => {
      const p = periodOf(o);
      if (p != null && o.src !== 'crew' && !o.x && out.length < STOCK_SEND_MAX) out.push([id, p, o.price]);
    }));
    let sync = {};
    try { sync = JSON.parse(GM_getValue(STOCK_SYNC_KEY, '{}')) || {}; } catch (e) { sync = {}; }
    // 🐟 Whiskers price alerts (0.49.1, user request): this hour's normal price (before your discount) of the two
    // items whose store price moves hourly, Premium tuna and Catnip tea: [[item id, until, price]].
    const shop = [];
    const items = (apiState && apiState.storeItems) || {};
    ['tuna', 'catnip'].forEach((id) => {
      const it = items[id];
      if (it && it.until > Date.now() && Number.isFinite(it.base) && it.base > 0) shop.push([id, it.until, it.base]);
    });
    stockSyncAt = Date.now();
    stockSyncBusy = true;
    GM_xmlhttpRequest({
      method: 'POST', url: STOCK_POOL_URL, timeout: 20000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 1, sender: shareId(), crew: shareCrewRef(), prices: out, since: Number.isInteger(sync.since) ? sync.since : null, shop }),
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
        Object.entries((sharingOn() && j.prices) || {}).forEach(([id, list]) => {
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
    // Only HIDDEN feats you hold, with their text (0.31.0, user: the point is sharing how to get hidden ones; visible
    // feats are on everyone's page anyway). Confirmed 2026-10-04: an earned hidden feat stays `hidden: true`.
    // `hiddenTotal` = how many hidden feats the game has, for "1 of 8" in the bot's status.
    const mine = meritFeats.filter((f) => f.held && f.hidden && f.name && f.criteria).map((f) => ({ id: f.id, name: f.name, criteria: f.criteria, hidden: true }));
    const sig = mine.map((f) => f.id).join(',');
    if (sig === featSyncSig && Date.now() - featSyncAt < FEAT_SYNC_GAP_MS) return;
    featSyncSig = sig; featSyncAt = Date.now();
    GM_xmlhttpRequest({
      method: 'POST', url: CREW_BOT_FEATS_URL, timeout: 15000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 1, sender: shareId(), crew: shareCrewRef(), feats: mine, hiddenTotal: meritFeats.filter((f) => f.hidden).length }),
      onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* not json */ } if (j && j.ok && sharingOn() && j.feats && typeof j.feats === 'object') { GM_setValue(FEAT_POOL_KEY, j.feats); schedule(); } },
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
    // Since 2026-10-19 the page names hidden feats you have earned, so its "???" boxes are only the ones not held.
    // Older pages kept every hidden feat as "???". Whichever count matches is used; nothing is drawn if neither does.
    const unheld = hidden.filter((f) => !f.held);
    const list = spots.length === hidden.length ? hidden : spots.length === unheld.length ? unheld : null;
    if (!list) { old.forEach((n) => n.remove()); return; }
    spots.forEach((el, i) => {
      const f = list[i];
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

  // ─── 💰 Muggable cats (user request, 0.35.0) ───────────────────────────────
  // A cat the crew has mugged for over $1,000 at least twice gets a small green money bag beside its name on the
  // Players page. Counted from the crew attack log (Crew > Crew attacks, its own reply /api/crew/attacks: side "out",
  // result "mug", stolen) whenever that log loads, plus your own attacks from the game data on every page. Each mug is
  // kept once by its attack id, in this browser only (`ms_mugs_v1`), so the count grows as more of the log is seen.
  const MUGS_KEY = 'ms_mugs_v1';
  const MUG_MIN = 1000, MUG_TIMES = 2, MUGS_MAX = 2000;
  let muggableCache = null; // { [catId]: { times, best, last } }, rebuilt when a new mug is saved
  function noteMugs(list) {
    const m = GM_getValue(MUGS_KEY, null) || {};
    let changed = false;
    (list || []).forEach((a) => {
      if (!a || a.id == null || a.victim == null || !(a.stolen > MUG_MIN)) return;
      const k = String(a.id);
      if (m[k]) { if (a.name && !m[k].n) { m[k].n = a.name; changed = true; } return; }
      m[k] = { v: String(a.victim), n: a.name || '', s: a.stolen, at: a.at || 0 };
      changed = true;
    });
    if (!changed) return;
    const keys = Object.keys(m);
    if (keys.length > MUGS_MAX) keys.sort((x, y) => (m[x].at || 0) - (m[y].at || 0)).slice(0, keys.length - MUGS_MAX).forEach((k) => delete m[k]);
    GM_setValue(MUGS_KEY, m);
    muggableCache = null;
    schedule();
  }
  // ⛓️ / ✅ History for the crew bot (0.49.5, user request): finished chains with each cat's links, crimes and fights,
  // and your finished heists with each member's payout. Kept in memory only, sent with crew sharing (names, never ids).
  let chainHistory = null, heistHistory = null;
  function onChainHistoryResponse(json) {
    if (!json || !Array.isArray(json.chains)) return;
    chainHistory = json.chains.filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && Number.isFinite(c.last) && Number.isInteger(c.links));
    shareCrew();
  }
  function onHeistHistoryResponse(json) {
    if (!json || !Array.isArray(json.heists)) return;
    heistHistory = json.heists.filter((h) => h && h.id != null && h.status === 'completed' && Number.isFinite(h.closed_at));
    shareCrew();
  }
  function historyForBot() {
    const now = Date.now();
    const out = {};
    if (chainHistory) {
      // Finished chains only (the day's chain stays in the list until 00:00 UTC), newest first.
      out.chains = chainHistory.filter((c) => c.end <= now).slice(0, 5).map((c) => ({
        start: c.start, end: c.end, last: c.last, links: c.links, best: !!c.best,
        cats: (Array.isArray(c.cats) ? c.cats : []).filter((x) => x && x.name).map((x) => ({ name: x.name, links: x.links, crimes: x.crimes, fights: x.fights })),
      }));
    }
    if (heistHistory) {
      // Heists that closed in the last 6 hours (the bot only notes ones it posted).
      out.heistResults = heistHistory.filter((h) => now - h.closed_at < 6 * 3600000).slice(0, 5).map((h) => ({
        id: h.id, name: h.name, success: h.success, closedAt: h.closed_at,
        members: (Array.isArray(h.members) ? h.members : []).filter((m) => m && m.name).map((m) => ({ name: m.name, payout: m.payout, stake: m.stake })),
      }));
    }
    return out;
  }

  function onCrewAttacksResponse(json) {
    if (!json || !Array.isArray(json.attacks)) return;
    const mugs = json.attacks.filter((a) => a && a.side === 'out' && a.result === 'mug' && a.them && a.them.id != null)
      .map((a) => ({ id: a.id, victim: a.them.id, name: a.them.name || '', stolen: Number(a.stolen) || 0, at: a.at || 0, by: (a.us && a.us.name) || '' }));
    noteLastMugs(mugs);
    noteMugs(mugs);
    noteGearLevels(json.attacks);
  }

  // ─── 🛡️ When a lying-low cat can be mugged again (user request, 0.36.0) ─────────
  // A mugged cat is "safe from muggers for an hour" (game text; rules.mugProtection 3,600,000 ms) and shows as
  // `lying_low` in the player list, with no end time. When the mug was ours (crew attack log, any amount, or your own
  // attacks), the end is the mug time + 1 hour: "🛡️ ready 04:12" beside the name while they lie low.
  const LASTMUG_KEY = 'ms_lastmug_v1'; // { [catId]: { at, by } }, only the last hour or two is kept
  const MUG_SAFE_MS = 3600000;
  function clockAt(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  const mugSafeMs = () => (apiState && Number.isFinite(apiState.mugProtectionMs) ? apiState.mugProtectionMs : MUG_SAFE_MS);
  function noteLastMugs(list) {
    const m = GM_getValue(LASTMUG_KEY, null) || {};
    const now = Date.now();
    let changed = false;
    (list || []).forEach((a) => {
      if (!a || a.victim == null || !(a.at > now - 2 * mugSafeMs())) return;
      const k = String(a.victim);
      if (!m[k] || m[k].at < a.at) { m[k] = { at: a.at, by: a.by || '' }; changed = true; }
    });
    Object.keys(m).forEach((k) => { if (!(m[k].at > now - 2 * mugSafeMs())) { delete m[k]; changed = true; } });
    if (changed) { GM_setValue(LASTMUG_KEY, m); schedule(); }
  }
  // { until, at, by } while a cat we mugged is still safe, else null. `lyingLow` false from the game wins.
  function safeUntil(id, lyingLow) {
    if (lyingLow === false) return null;
    const x = (GM_getValue(LASTMUG_KEY, null) || {})[String(id)];
    const until = x ? x.at + mugSafeMs() : 0;
    return until > Date.now() ? { until, at: x.at, by: x.by } : null;
  }
  const safeTitle = (s) => (s.api
    ? `Lying low: safe from muggers until ${clockAt(s.until)} (your time), from the game's own shield time (game API, your key).`
    : `Lying low: mugged${s.by ? ' by ' + s.by : ''} at ${clockAt(s.at)}, safe from muggers for an hour, so it can be mugged again at ${clockAt(s.until)} (your time).`);

  // ─── Game API key (0.44.0, user request): the game's official read-only API, opt-in ─────────
  // The game invites tools to read through https://meowstreets.com/api/v1/ with a key the player makes (Account in
  // the game; see api-v1-reference.md). With a key saved on the Account page, the script reads one thing: a lying-low
  // cat's `status.shield_until` from /v1/cat/<id>, so "🛡️ ready" also shows for cats nobody in the crew mugged. At most
  // one read every 3 s (the game allows 60 a minute), each cat remembered 5 min, in memory only. The key is kept in
  // this browser and sent only to meowstreets.com, never to the crew bot. No key: nothing is read, as before.
  const API_KEY_KEY = 'ms_api_key_v1';
  const apiKey = () => String(GM_getValue(API_KEY_KEY, '') || '').trim();
  const CAT_API_TTL = 5 * 60000, CAT_API_GAP = 3000, CAT_API_QUEUE = 20;
  const catApi = new Map(); // id -> { at, shieldUntil, jailUntil, lyingLow }
  const catApiQueue = [];
  let catApiBusy = false, catApiWaitUntil = 0, apiKeyState = null; // apiKeyState: { ok, text } for the Account page
  function apiGet(route, cb) {
    GM_xmlhttpRequest({
      method: 'GET', url: 'https://meowstreets.com/api/v1/' + route, headers: { Authorization: 'Bearer ' + apiKey() }, timeout: 15000,
      onload: (r) => {
        let j = null;
        try { j = JSON.parse(r.responseText); } catch (e) { /* not JSON */ }
        const ra = Number(((r.responseHeaders || '').match(/retry-after:\s*(\d+)/i) || [])[1]);
        cb(j, r.status, ra);
      },
      onerror: () => cb(null, 0, 0), ontimeout: () => cb(null, 0, 0),
    });
  }
  function wantCat(id) {
    if (!apiKey()) return;
    const c = catApi.get(String(id));
    if ((c && Date.now() - c.at < CAT_API_TTL) || catApiQueue.includes(String(id)) || catApiQueue.length >= CAT_API_QUEUE) return;
    catApiQueue.push(String(id));
    pumpCatApi();
  }
  function pumpCatApi() {
    if (catApiBusy || !catApiQueue.length) return;
    const wait = catApiWaitUntil - Date.now();
    if (wait > 0) { setTimeout(pumpCatApi, wait); return; }
    const id = catApiQueue.shift();
    catApiBusy = true;
    apiGet('cat/' + id, (j, status, ra) => {
      catApiBusy = false;
      if (j && j.ok && j.data && j.data.status) {
        const s = j.data.status;
        catApi.set(id, { at: Date.now(), shieldUntil: Number(s.shield_until) || null, jailUntil: Number(s.jail_until) || null, lyingLow: s.lying_low === true });
        schedule();
      } else if (status === 429) catApiWaitUntil = Date.now() + (ra > 0 ? ra * 1000 : 60000);
      else if (status === 401 || status === 403) {
        catApiWaitUntil = Date.now() + 10 * 60000;
        catApiQueue.length = 0;
        apiKeyState = { ok: false, text: `The game refused the key (${(j && j.error && j.error.code) || status}).` };
      }
      setTimeout(pumpCatApi, CAT_API_GAP);
    });
  }
  // A lying-low cat's shield time from the API, when there is one: { until, api: true }.
  function apiSafeUntil(id) {
    const c = catApi.get(String(id));
    return c && c.shieldUntil > Date.now() ? { until: c.shieldUntil, api: true } : null;
  }
  const safeTag = (id, lyingLow) => {
    const s = safeUntil(id, lyingLow);
    return s ? ` <span class="msx-lowtag" title="${escHtml(safeTitle(s))}">🛡️ ready ${clockAt(s.until)}</span>` : '';
  };
  let myMugsAt = null;
  function noteMyMugs() {
    if (!apiState || !apiState.myMugs || apiState.at === myMugsAt) return;
    myMugsAt = apiState.at;
    noteLastMugs(apiState.myMugs.map((a) => ({ ...a, by: 'you' })));
    noteMugs(apiState.myMugs);
  }
  // ─── Half XP for 3 h after you attack a cat (0.41.0, user request) ─────────
  // Confirmed on your saved fights: a repeat attack within 3 h of your last one on that cat gave exactly half XP
  // (Pussy 6 -> 3, Tiger 24 -> 12), and Krispy hitting Tiger 31 min before you didn't halve yours. Kept per cat:
  // the time of your last attack on it, from your own `attacks` in every game reply (it lists your last 10).
  const HALFXP_KEY = 'ms_my_attacks_v1'; // { [catId]: lastAttackAt }
  const repeatMs = () => (apiState && apiState.repeatWindow) || 3 * 3600000;
  let myAttacksAt = null;
  function noteMyAttacks() {
    if (!apiState || !apiState.myAttacks || apiState.at === myAttacksAt) return;
    myAttacksAt = apiState.at;
    const m = { ...(GM_getValue(HALFXP_KEY, null) || {}) };
    const now = Date.now();
    let changed = false;
    apiState.myAttacks.forEach((a) => { const k = String(a.victim); if (!(m[k] >= a.at)) { m[k] = a.at; changed = true; } });
    Object.keys(m).forEach((k) => { if (m[k] + repeatMs() <= now) { delete m[k]; changed = true; } });
    if (changed) GM_setValue(HALFXP_KEY, m);
  }
  function halfXpUntil(id) {
    const at = (GM_getValue(HALFXP_KEY, null) || {})[String(id)];
    const until = at ? at + repeatMs() : 0;
    return until > Date.now() ? { at, until } : null;
  }
  const halfXpText = (h) => `½ XP until ${clockAt(h.until)}`;
  const halfXpTitle = (h) => `You attacked this cat at ${clockAt(h.at)}. Attacking the same cat again within ${Math.round(repeatMs() / 3600000)} hours ` +
    `of your last attack on it gives half XP (seen in your own fights; other cats' attacks on it don't count). Full XP again at ${clockAt(h.until)} (your time).`;
  const halfXpTag = (id) => { const h = halfXpUntil(id); return h ? ` <span class="msx-halfxp" title="${escHtml(halfXpTitle(h))}">${halfXpText(h)}</span>` : ''; };
  // Profile pages (/cat/<id>): the tag goes with the game's own chips under the name ("Level 5").
  function drawProfileHalfXp() {
    const m = location.pathname.replace(/\/+$/, '').match(/^\/cat\/(\d+)$/);
    const chips = m && document.querySelector('.cp-lead .cp-chips');
    let tag = document.querySelector('.cp-chips > .msx-halfxp');
    const h = chips && halfXpUntil(m[1]);
    if (!h) { if (tag) tag.remove(); return; }
    if (!tag) { tag = document.createElement('span'); tag.className = 'tag msx-halfxp'; }
    if (tag.parentElement !== chips) chips.appendChild(tag);
    if (tag.textContent !== halfXpText(h)) tag.textContent = halfXpText(h);
    setTitle(tag, halfXpTitle(h));
  }

  // ─── ⚔️ Other cats' gear, last seen in a fight (0.42.0, user request) ───
  // Kept per cat, newest first by timestamp: gear (level, health, primary, secondary, thrown, armour) with `at`.
  // Stats (`st`, `stAt`) only from a cat's own share (`me`, 0.49.0): other cats' stats from fights leaked by the
  // game's mistake and are never kept (0.49.3; the game owner asked for them to be deleted and not shared). A newer sighting replaces what it knows; an
  // older one only fills gaps. From three places, all replies the game's own pages already load:
  //   your last 10 fights (`attacks[].state`, every page): level, max health, all four gear slots. The game stopped
  //   sending `state` with its 2026-11-12 fix (API log 2026-11-13); kept in case it comes back, stats never read
  //   a fight page (/api/fight/<code>): both cats' level, max health and gear, as at the start of that fight
  //   an opened crew attack (/api/crew/attack): only the weapons each cat actually used, by name
  // With crew sharing on, records also go to the crew bot and the crew's come back (src 'crew'), so they stay fresh
  // without anyone opening the page again.
  const GEAR_KEY = 'ms_cat_gear_v1'; // { [catId]: { n, at, lv, hp, p, s, t, a, st: [str, def, spd, dex], stAt, src, d } }
  const GEAR_MAX = 3000;
  const GEAR_FIELDS = ['lv', 'hp', 'p', 's', 't', 'a'];
  // One cat from a fight's `state` side or a fight page (same field names). Gear only, never stats (0.49.3).
  function gearRecord(c, at) {
    if (!c || c.id == null) return null;
    const r = { id: c.id, n: c.name || '', at, p: c.primary || null, s: c.secondary || null, t: c.thrown || null, a: c.armor || null };
    if (Number.isFinite(c.level)) r.lv = c.level;
    if (Number.isFinite(c.maxHp)) r.hp = c.maxHp;
    return r;
  }
  // Stats count only when they are the cat's own share (`me`, sent with them at the same time). Since 0.49.4 that is
  // opt-in (Account page, Share my battle stats); `st: null` with `me` = the cat took them back.
  const ownStatsUpdate = (r) => !!r && Number.isFinite(r.me) && r.stAt === r.me && (r.st === null || Array.isArray(r.st));
  const ownStats = (r) => ownStatsUpdate(r) && Array.isArray(r.st);
  // `undefined` = not known from this sighting, null = none.
  function mergeGear(old, nw) {
    const r = old ? { ...old } : { n: '', at: 0 };
    const newer = nw.at > (r.at || 0);
    if (nw.n && (newer || !r.n)) r.n = nw.n;
    GEAR_FIELDS.forEach((k) => { if (nw[k] !== undefined && (newer || r[k] === undefined)) r[k] = nw[k]; });
    if (newer) { r.at = nw.at; r.src = nw.src; }
    if (ownStatsUpdate(nw) && !(r.stAt >= nw.stAt)) { r.st = nw.st; r.stAt = nw.stAt; }
    if (Number.isFinite(nw.me) && !(r.me >= nw.me)) r.me = nw.me; // when the cat itself last shared this (0.49.0)
    if (r.st && !ownStats(r)) { delete r.st; delete r.stAt; }
    const strip =(x) => JSON.stringify(x ? { ...x, d: 0 } : null);
    return strip(r) === strip(old) ? null : r;
  }
  function noteGear(list, src) {
    if (!list || !list.length) return;
    const m = GM_getValue(GEAR_KEY, null) || {};
    let changed = false;
    list.forEach((nw) => {
      if (!nw || nw.id == null) return;
      const k = String(nw.id);
      const r = mergeGear(m[k], { ...nw, src });
      if (!r) return;
      if (src !== 'crew') r.d = 1; // still to send to the crew bot
      m[k] = r; changed = true;
    });
    if (!changed) return;
    const keys = Object.keys(m);
    if (keys.length > GEAR_MAX) keys.sort((x, y) => Math.max(m[x].at || 0, m[x].stAt || 0) - Math.max(m[y].at || 0, m[y].stAt || 0)).slice(0, keys.length - GEAR_MAX).forEach((k) => delete m[k]);
    GM_setValue(GEAR_KEY, m);
    schedule();
  }
  // 0.49.3: delete every other cat's stats already kept from fights (the game owner's request), on every load (cheap,
  // writes only when something goes). Gear and cats' own shared stats stay. 0.49.4: once, every stat kept so far,
  // own shares too (they were sent before sharing stats was a choice); the bot does the same.
  const STATS_OPTIN_KEY = 'ms_stats_optin_v1';
  function purgeFightStats() {
    const m = GM_getValue(GEAR_KEY, null);
    const all = !GM_getValue(STATS_OPTIN_KEY, false);
    let changed = false;
    if (m) Object.values(m).forEach((r) => { if (r && (r.st || r.stAt) && (all || !ownStatsUpdate(r))) { delete r.st; delete r.stAt; changed = true; } });
    if (changed) GM_setValue(GEAR_KEY, m);
    if (all) GM_setValue(STATS_OPTIN_KEY, true);
  }
  purgeFightStats();
  let fightCatsAt = null;
  function noteFightCats() {
    if (!apiState || !apiState.fightCats || apiState.at === fightCatsAt) return;
    fightCatsAt = apiState.at;
    noteGear(apiState.fightCats, 'you');
    noteSelfGear();
  }
  // Your own level and gear into the shared ⚔️ pool (0.49.0, user request), sharing on only: when they change, else at
  // most every 6 hours. `me` marks it as the cat's own numbers (the bot only takes that from the cat itself). Your
  // battle stats go only with Share my battle stats on (0.49.4, user request); off sends `st: null` (taken back).
  const SELF_GEAR_KEY = 'ms_self_gear_v1';
  const SELF_GEAR_EVERY_MS = 6 * 3600000;
  function noteSelfGear() {
    const s = apiState && apiState.selfCat;
    if (!s || !sharingOn()) return;
    const mine = settings.shareStats && inShareCrew() ? s : { ...s, st: null }; // alliance crews only
    const sig = JSON.stringify(mine);
    const last = GM_getValue(SELF_GEAR_KEY, null) || {};
    if (last.sig === sig && Date.now() - (last.at || 0) < SELF_GEAR_EVERY_MS) return;
    const at = Date.now();
    GM_setValue(SELF_GEAR_KEY, { sig, at });
    noteGear([{ ...mine, at, stAt: at, me: at }], 'you');
  }
  // The Crew attacks list: each row has the other cat's level. Kept for cats that already have a ⚔️ record (a level
  // alone starts none), only if newer than what's known. Only the level changes: the gear's "seen" time stays, so old
  // gear never looks newer than it is. Kept on this computer only (the crew pool goes by the gear time).
  function noteGearLevels(rows) {
    const g = GM_getValue(GEAR_KEY, null) || {};
    let changed = false;
    rows.forEach((a) => {
      const r = a && a.them && g[String(a.them.id)];
      const at = a && Number(a.at);
      if (!r || !Number.isFinite(a.them.level) || !(at > Math.max(r.at || 0, r.lvAt || 0)) || r.lv === a.them.level) return;
      r.lv = a.them.level; r.lvAt = at; changed = true;
    });
    if (changed) { GM_setValue(GEAR_KEY, g); schedule(); }
  }
  // A fight page's own reply: both cats as at the start of that fight.
  function onFightResponse(json) {
    const at = json && Number(json.startedAt);
    if (!(at > 0)) return;
    const me = apiState && apiState.myId;
    noteGear([json.attacker, json.defender].filter((c) => c && c.id !== me).map((c) => gearRecord(c, at, false)).filter(Boolean), 'you');
  }
  // An opened crew attack: the weapons each side swung (by name; "Pounce" is no weapon). Armour isn't in it.
  function onCrewAttackResponse(json) {
    const at = json && Number(json.at);
    if (!(at > 0) || !json.attacker || !json.defender) return;
    const byName = {};
    Object.entries((apiState && apiState.gearNames) || {}).forEach(([id, name]) => { byName[name] = id; });
    const log = Array.isArray(json.log) ? json.log : [];
    const me = apiState && apiState.myId;
    const out = [];
    [['attacker', json.attacker], ['defender', json.defender]].forEach(([who, c]) => {
      if (!c || c.id == null || c.id === me) return;
      const r = { id: c.id, n: c.name || '', at };
      if (Number.isFinite(c.level)) r.lv = c.level;
      if (Number.isFinite(c.maxHp)) r.hp = c.maxHp;
      log.forEach((e) => {
        const slot = e && e.who === who && { primary: 'p', secondary: 's', thrown: 't' }[e.slot];
        if (slot && byName[e.weapon]) r[slot] = byName[e.weapon];
      });
      out.push(r);
    });
    noteGear(out, 'you');
  }
  const catGear = (id) => (GM_getValue(GEAR_KEY, null) || {})[String(id)] || null;
  const seenAt = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const gearName = (id) => (id === undefined ? '?' : id === null ? 'none' : ((apiState && apiState.gearNames) || {})[id] || id);
  // { gear, stats } as two lines of plain text.
  function gearLines(g) {
    const own = g.me >= g.at; // the newest record is the cat's own share, not a fight
    const gear = (own ? `Shared by this cat ${seenAt(g.at)}: ` : `Seen in a fight ${seenAt(g.at)}${g.src === 'crew' ? ' (crew)' : ''}: `) +
      [g.lv != null ? 'Level ' + g.lv : null, 'Primary ' + gearName(g.p), 'Secondary ' + gearName(g.s), 'Thrown ' + gearName(g.t), 'Armour ' + gearName(g.a),
        g.hp != null ? n0(g.hp) + ' HP' : null].filter(Boolean).join(' · ');
    const st = g.st;
    const stats = st ? `STR ${n0(st[0])} · DEF ${n0(st[1])} · SPD ${n0(st[2])} · DEX ${n0(st[3])} (total ${n0(st[0] + st[1] + st[2] + st[3])})` +
      (Math.abs(g.stAt - g.at) > 60000 ? `, as of ${seenAt(g.stAt)}` : '') : 'No battle stats: only cats who choose to share their own show them.';
    return { gear, stats };
  }
  const gearTitle = (g) => { const l = gearLines(g); return l.gear + '\n' + l.stats + (g.me >= g.at ? (g.st ? '\nBase stats this cat chose to share, and its gear, from its own script (no temporary boosts).' : '\nLevel and gear shared by this cat\'s own script.') : '\nWhat they had then; they may have changed gear since.'); };
  // Beside a name: "⚔️ 1,234 · DEX/DEF" (total, then the two biggest stats) once stats are known, else just ⚔️.
  const STAT_ABBR = ['STR', 'DEF', 'SPD', 'DEX'];
  // Stats are always shown as STR/DEF/SPD/DEX (user request 2026-11-07), wherever the game spells them out.
  const STAT_SHORT = { strength: 'STR', defense: 'DEF', defence: 'DEF', speed: 'SPD', dexterity: 'DEX' };
  const statAbbr = (s) => STAT_SHORT[String(s).toLowerCase()] || s;
  function gearTagText(g) {
    const st = g.st;
    if (!st) return '⚔️';
    const top = [0, 1, 2, 3].sort((a, b) => st[b] - st[a]).slice(0, 2).map((i) => STAT_ABBR[i]).join('/');
    return `⚔️ ${n0(st[0] + st[1] + st[2] + st[3])} · ${top}`;
  }
  const gearTag = (id) => {
    const g = catGear(id);
    return g ? ` <span class="msx-geartag${g.st ? ' msx-hasstats' : ''}" title="${escHtml(gearTitle(g))}">${escHtml(gearTagText(g))}</span>` : '';
  };
  // Profile pages: two lines under the Attack button's reason.
  function drawProfileGear() {
    const m = location.pathname.replace(/\/+$/, '').match(/^\/cat\/(\d+)$/);
    const lead = m && document.querySelector('.cp-deck > .cp-lead');
    let box = document.getElementById('msx-catgear');
    const g = lead && catGear(m[1]);
    if (!g) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'msx-catgear'; }
    const anchor = lead.nextElementSibling && lead.nextElementSibling.classList.contains('reason') ? lead.nextElementSibling : lead;
    if (anchor.nextElementSibling !== box) anchor.after(box);
    const l = gearLines(g);
    const html = `<div>⚔️ ${escHtml(l.gear)}</div><div class="msx-catgear-stats">${escHtml(l.stats)}</div>`;
    if (box.innerHTML !== html) box.innerHTML = html;
    setTitle(box, g.me >= g.at ? (g.st ? 'Base stats this cat chose to share, and its gear, from its own script. No temporary boosts.' : 'This cat\'s level and gear, shared by its own script.')
      : 'What this cat had in its last fight the script saw' + (g.src === 'crew' ? ' (shared by a crewmate)' : '') + '. They may have changed gear since.');
  }

  // Crew pool (sharing on): send what you saw, get back what the crew saw. The bot keeps the newest per cat too.
  const GEAR_POOL_URL = 'http://168.138.79.225:3001/v1/gear';
  const GEAR_SYNC_KEY = 'ms_gear_sync_v1'; // { since: the bot's upTo from the last sync }
  const GEAR_SYNC_GAP_MS = 5 * 60000, GEAR_SEND_GAP_MS = 65000, GEAR_SEND_MAX = 300;
  let gearSyncAt = 0, gearSyncBusy = false;
  function syncGear() {
    if (!sharingOn() || gearSyncBusy || typeof GM_xmlhttpRequest !== 'function') return;
    const m = GM_getValue(GEAR_KEY, null) || {};
    const dirty = Object.keys(m).filter((k) => m[k].d);
    const gap = Date.now() - gearSyncAt;
    if (gap < GEAR_SEND_GAP_MS || (!dirty.length && gap < GEAR_SYNC_GAP_MS)) return;
    const send = dirty.slice(0, GEAR_SEND_MAX).map((k) => {
      const r = m[k];
      const o = { id: Number(k), n: r.n, at: r.at };
      GEAR_FIELDS.forEach((f) => { if (r[f] !== undefined) o[f] = r[f]; });
      if (ownStatsUpdate(r)) { o.st = r.st; o.stAt = r.stAt; }
      if (r.me) o.me = r.me; // the bot keeps it only from the cat itself
      return o;
    });
    const sync = GM_getValue(GEAR_SYNC_KEY, null) || {};
    gearSyncAt = Date.now(); gearSyncBusy = true;
    GM_xmlhttpRequest({
      method: 'POST', url: GEAR_POOL_URL, timeout: 20000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 2, sender: shareId(), crew: shareCrewRef(), cats: send, since: Number.isFinite(sync.since) ? sync.since : null }),
      onload: (r) => {
        gearSyncBusy = false;
        let j = null;
        try { j = JSON.parse(r.responseText); } catch (e) { return; }
        if (!j || !j.ok) return;
        // Sent ones are clean again, unless they changed while the request was out.
        const now = GM_getValue(GEAR_KEY, null) || {};
        send.forEach((o) => { const x = now[String(o.id)]; if (x && x.d && x.at === o.at && x.stAt === o.stAt) delete x.d; });
        GM_setValue(GEAR_KEY, now);
        if (gearPoolOn()) noteGear(Object.entries(j.cats || {}).map(([id, c]) => ({ ...c, id: Number(id) })), 'crew');
        if (Number.isFinite(j.upTo)) GM_setValue(GEAR_SYNC_KEY, { since: j.upTo });
        if (dirty.length > GEAR_SEND_MAX || j.more) setTimeout(syncGear, GEAR_SEND_GAP_MS + 1000);
      },
      onerror: () => { gearSyncBusy = false; },
      ontimeout: () => { gearSyncBusy = false; },
    });
  }

  // { [catId]: { times, best, last } } for cats mugged over $1,000 at least twice.
  function muggable() {
    if (muggableCache) return muggableCache;
    const by = {};
    Object.values(GM_getValue(MUGS_KEY, null) || {}).forEach((x) => {
      const c = by[x.v] || (by[x.v] = { times: 0, best: 0, last: 0 });
      c.times++; c.best = Math.max(c.best, x.s); c.last = Math.max(c.last, x.at || 0);
    });
    muggableCache = {};
    Object.entries(by).forEach(([id, c]) => { if (c.times >= MUG_TIMES) muggableCache[id] = c; });
    return muggableCache;
  }
  const MONEYBAG_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M9 2.5h6l-1.7 3.4h-2.6Z" fill="#5fae3b"/>' +
    '<path d="M10.3 5.9h3.4c3.9 2.1 6.5 5.7 6.5 9.4 0 3.7-3.3 5.7-8.2 5.7s-8.2-2-8.2-5.7c0-3.7 2.6-7.3 6.5-9.4Z" fill="#7cc95a" stroke="#3f7d28" stroke-width="1"/>' +
    '<text x="12" y="17.6" font-size="8.5" font-weight="700" text-anchor="middle" fill="#14310b" font-family="sans-serif">$</text></svg>';
  function muggableTitle(c) {
    return `Muggable: the crew has mugged this cat for over $1,000 ${c.times} times (biggest ${fmtMoney(c.best)}${c.last ? ', last ' + new Date(c.last).toUTCString().slice(5, 11) : ''}).`;
  }
  const muggableBadge = (id) => {
    const c = muggable()[String(id)];
    return c ? ` <span class="msx-muggable" title="${escHtml(muggableTitle(c))}">${MONEYBAG_SVG}</span>` : '';
  };
  // The game's player table: the badge goes right after the name button in each row. Rows are virtual (re-used as you
  // scroll), so each badge remembers whose it is and is moved or removed when the row changes.
  function markMuggableRows() {
    if (location.pathname.replace(/\/+$/, '') !== '/players') return;
    const mug = muggable();
    document.querySelectorAll('.reg-item button.reg-hit[aria-label]').forEach((b) => {
      const m = b.getAttribute('aria-label').match(/, ID (\d+),/);
      const c = m ? mug[m[1]] : null;
      let tag = b.nextElementSibling && b.nextElementSibling.classList.contains('msx-muggable') ? b.nextElementSibling : null;
      if (!c) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('span'); tag.className = 'msx-muggable'; tag.innerHTML = MONEYBAG_SVG; b.after(tag); }
      tag.dataset.id = m[1];
      setTitle(tag, muggableTitle(c));
    });
    // 🛡️ ready time, after the name (and the bag, if any).
    document.querySelectorAll('.reg-item button.reg-hit[aria-label]').forEach((b) => {
      const m = b.getAttribute('aria-label').match(/, ID (\d+),/);
      const info = m && playerInfo(m[1]);
      // With an API key, a lying-low cat gets the game's own shield time (0.44.0); otherwise our mug time + 1 h.
      if (m && info && info.lyingLow) wantCat(m[1]);
      const s = m ? (info && info.lyingLow && apiSafeUntil(m[1])) || safeUntil(m[1], info ? info.lyingLow : undefined) : null;
      const host = b.parentElement;
      let tag = host && host.querySelector(':scope > .msx-lowtag');
      if (!s) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('span'); tag.className = 'msx-lowtag'; }
      const after = b.nextElementSibling && b.nextElementSibling.classList.contains('msx-muggable') ? b.nextElementSibling : b;
      if (after.nextElementSibling !== tag) after.after(tag);
      const text = `🛡️ ready ${clockAt(s.until)}`;
      if (tag.textContent !== text) tag.textContent = text;
      setTitle(tag, safeTitle(s));
    });
    // ½ XP tag, last in the row (after the name, bag and 🛡️).
    document.querySelectorAll('.reg-item button.reg-hit[aria-label]').forEach((b) => {
      const m = b.getAttribute('aria-label').match(/, ID (\d+),/);
      const h = m ? halfXpUntil(m[1]) : null;
      const host = b.parentElement;
      let tag = host && host.querySelector(':scope > .msx-halfxp');
      if (!h) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('span'); tag.className = 'msx-halfxp'; }
      const sibs = [...host.children].filter((x) => x === b || x.classList.contains('msx-muggable') || x.classList.contains('msx-lowtag'));
      const after = sibs[sibs.length - 1];
      if (after.nextElementSibling !== tag) after.after(tag);
      if (tag.textContent !== halfXpText(h)) tag.textContent = halfXpText(h);
      setTitle(tag, halfXpTitle(h));
    });
    // 💸 what a cat took when it last hit you (0.49.5), right after the game's own "Hit you 1 day ago" tag. Only when it
    // took money (a fight it lost or a leave takes nothing).
    document.querySelectorAll('.reg-item button.reg-hit[aria-label]').forEach((b) => {
      const m = b.getAttribute('aria-label').match(/, ID (\d+),/);
      const hit = m && playerInfo(m[1]) && playerInfo(m[1]).hitYou;
      const row = b.closest('.reg-item');
      const gameTag = row && [...row.querySelectorAll('.reg-tag')].find((t) => /^Hit you\b/i.test(t.textContent.trim()));
      let tag = row && row.querySelector('.msx-hittook');
      if (!hit || !(hit.took > 0) || !gameTag) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('span'); tag.className = 'msx-hittook'; }
      if (gameTag.nextElementSibling !== tag) gameTag.after(tag);
      const text = `took ${fmtMoney(hit.took)}`;
      if (tag.textContent !== text) tag.textContent = text;
      setTitle(tag, `What this cat took from you when it last hit you (${new Date(hit.at).toUTCString().slice(5, 22)} UTC), from the game's own list.`);
    });
    // ⚔️ last seen stats (total + top two) and gear (hover), last of all.
    document.querySelectorAll('.reg-item button.reg-hit[aria-label]').forEach((b) => {
      const m = b.getAttribute('aria-label').match(/, ID (\d+),/);
      const g = m ? catGear(m[1]) : null;
      const host = b.parentElement;
      let tag = host && host.querySelector(':scope > .msx-geartag');
      if (!g) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('span'); tag.className = 'msx-geartag'; }
      const sibs = [...host.children].filter((x) => x === b || x.classList.contains('msx-muggable') || x.classList.contains('msx-lowtag') || x.classList.contains('msx-halfxp'));
      const after = sibs[sibs.length - 1];
      if (after.nextElementSibling !== tag) after.after(tag);
      const text = gearTagText(g);
      if (tag.textContent !== text) tag.textContent = text;
      tag.classList.toggle('msx-hasstats', !!g.st);
      setTitle(tag, gearTitle(g));
    });
  }
  // The 🛡️ and ½ XP tags go once their time is up.
  setInterval(() => {
    const path = location.pathname.replace(/\/+$/, '');
    if (path === '/players') markMuggableRows();
    if (/^\/cat\/\d+$/.test(path)) drawProfileHalfXp();
    syncGear(); // the crew's gear records, every 5 minutes while sharing is on
    syncFish(); // your new catches, and the crew's fish table every 10 minutes on the Pier page
  }, 20000);

  // ─── "No crew" and "New cats" lists (Players page, 0.25.0; fixed + new cats 0.27.0) ─────
  // The Players list only renders the ~15 rows on screen, so rows can't just be hidden. Two fold-out lists sit above
  // it instead, built from the page's own /api/players replies (API log "newsinceredoplayer", 2026-10-06):
  //   { offset, total, counts, you, marks: [[index, label]], rows: [{ id, name, level, rank, created_at, crew: null |
  //   { ... }, shield, jail_until, at_vet, busy, ... }] } -- 100 rows per reply, the next 100 load as you scroll.
  // 0.25.0 picked `marks` (the first list in the reply) instead of `rows`, so it never worked. Kept in memory for this
  // page view only, never sent; the only thing saved is the highest cat id seen, for "new since your last visit".
  // No links or whisper buttons: opening a whisper means clicking the game's own chat for you.
  const players = { api: new Map(), rows: new Map(), total: null, seenBefore: undefined };
  const PLAYERS_SEEN_KEY = 'ms_players_seen_v1'; // highest cat id seen on an earlier visit
  function newestCatSeen() { return Number(GM_getValue(PLAYERS_SEEN_KEY, 0)) || 0; }
  const NEW_CAT_MS = 24 * 3600000;
  const playerListOpen = { 'msx-nocrew': false, 'msx-newcats': false };
  const isPlayersPage = () => location.pathname.replace(/\/+$/, '') === '/players';

  // Crewless cats' last action (0.46.9, user request "filter out people who have been inactive in the last 48 hours,
  // and then sort them by most to least recent activity"). The game's player list has no last-active time; only each
  // cat's own page does. The crew bot's 🧲 Recruits already reads every crewless cat's public page with the game's
  // official API (active ones every 6 hours), so with crew sharing on the script asks the bot for those times
  // (POST /v1/recruits -> { cats: [[id, lastAt (0 = never did anything), checkedAt]] }), at most every 10 minutes,
  // only on the Players page. Kept on this computer as the last reply.
  const CREWLESS_URL = 'http://168.138.79.225:3001/v1/recruits';
  const CREWLESS_KEY = 'ms_crewless_v1'; // { at, cats: [[id, lastAt, checkedAt]] }
  const CREWLESS_GAP_MS = 10 * 60000;
  const CREWLESS_ACTIVE_MS = 48 * 3600000;
  let crewlessBusy = false, crewlessAskedAt = 0;
  function syncCrewless() {
    if (!sharingOn() || crewlessBusy || typeof GM_xmlhttpRequest !== 'function') return;
    const last = GM_getValue(CREWLESS_KEY, null);
    if (Date.now() - Math.max(crewlessAskedAt, (last && last.at) || 0) < CREWLESS_GAP_MS) return;
    crewlessBusy = true;
    crewlessAskedAt = Date.now();
    const done = () => { crewlessBusy = false; };
    GM_xmlhttpRequest({
      method: 'POST', url: CREWLESS_URL, timeout: 15000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 1, sender: shareId(), crew: shareCrewRef() }),
      onload: (r) => {
        done();
        let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* not json */ }
        if (!j || !j.ok || !Array.isArray(j.cats)) return;
        GM_setValue(CREWLESS_KEY, { at: Date.now(), cats: j.cats.filter((c) => Array.isArray(c) && Number.isInteger(c[0]) && Number.isFinite(c[1])).slice(0, 5000) });
        schedule();
      },
      onerror: done, ontimeout: done,
    });
  }
  // id -> lastAt (ms; 0 = never did anything), or null without sharing or before the bot has answered.
  function crewlessActivity() {
    if (!sharingOn()) return null;
    const last = GM_getValue(CREWLESS_KEY, null);
    return last && Array.isArray(last.cats) ? new Map(last.cats.map((c) => [c[0], c[1]])) : null;
  }

  function playerInfo(id) { return players.api.get(String(id)); }
  function onPlayersResponse(json) {
    const rows = json && Array.isArray(json.rows) ? json.rows : null;
    if (!rows) return;
    if (Number.isFinite(json.total)) players.total = json.total;
    rows.forEach((c) => {
      if (!c || typeof c.name !== 'string' || !Number.isFinite(Number(c.id))) return;
      players.api.set(String(c.id), {
        id: Number(c.id), name: c.name, level: Number.isFinite(c.level) ? c.level : null, rank: Number.isFinite(c.rank) ? c.rank : null,
        joined: Number.isFinite(c.created_at) ? c.created_at : null, crew: c.crew && c.crew.name ? String(c.crew.name) : '', none: !c.crew,
        lyingLow: typeof c.lying_low === 'boolean' ? c.lying_low : undefined,
        // The last time this cat attacked you and what it took (`hit_you`, API log 2026-11-13). The game shows "Hit you
        // 1 day ago" itself; the script adds only the amount.
        hitYou: c.hit_you && Number.isFinite(c.hit_you.at) && Number.isFinite(c.hit_you.took) ? { at: c.hit_you.at, took: c.hit_you.took } : null,
      });
    });
    if (!players.api.size) return;
    // "New since your last visit": remember what the last visit had seen, then save the new highest id.
    const stored = Number(GM_getValue(PLAYERS_SEEN_KEY, 0)) || 0;
    if (players.seenBefore === undefined) players.seenBefore = stored > 0 ? stored : null;
    const maxId = Math.max(...[...players.api.values()].map((c) => c.id));
    if (maxId > stored) GM_setValue(PLAYERS_SEEN_KEY, maxId);
    schedule();
  }

  // Fallback when the script missed the replies (it loads after the first one on a fresh reload): the rendered rows,
  // button.reg-hit aria-label "Mags, ID 72, rank 1, level 15, Odd Tuna Cult" + span.reg-crew (Screenshots 348–351).
  function readPlayerRows() {
    document.querySelectorAll('.reg-item button.reg-hit[aria-label]').forEach((b) => {
      const m = b.getAttribute('aria-label').match(/^(.+?), ID (\d+), rank (\d+), level (\d+)(?:, (.*))?$/);
      if (!m) return;
      const crewEl = b.closest('.reg-item').querySelector('.reg-crew');
      const crew = ((crewEl && crewEl.textContent) || m[5] || '').trim();
      players.rows.set(m[2], { id: +m[2], name: m[1], level: +m[4], rank: +m[3], joined: null, crew, none: !crew });
    });
  }

  // Profile link (user request, 0.27.1): a plain link the player clicks, opening the game's own profile page in a new
  // tab so the list stays open. Profile pages live at /cat/<id> (the page then loads /api/cat?id=...).
  const catLink = (c) => `<a class="msx-cat-link" href="/cat/${encodeURIComponent(c.id)}" target="_blank" rel="noopener" title="Open ${escHtml(c.name)}'s profile"><b>${escHtml(c.name)}</b></a>${muggableBadge(c.id)}${safeTag(c.id, c.lyingLow)}${halfXpTag(c.id)}${gearTag(c.id)}`;
  const agoText = (ms) => { const h = Math.floor(ms / 3600000); return h >= 1 ? `${h}h ago` : `${Math.max(1, Math.floor(ms / 60000))}m ago`; };
  // Redraws only when the html itself changed: compared with what was last written, not el.innerHTML (the browser
  // writes some of it back differently, so that check redrew the No crew list on every page change and its scroll
  // jumped back to the top; user report 2026-11-10). A redraw keeps the list's scroll position.
  const setHtml = (el, html) => {
    if (el.dataset.html === html) return;
    const ul = el.querySelector('ul');
    const top = ul ? ul.scrollTop : 0;
    el.innerHTML = html;
    el.dataset.html = html;
    const ul2 = el.querySelector('ul');
    if (ul2 && top) ul2.scrollTop = top;
  };

  function playerList(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('details');
      el.id = id;
      el.className = 'msx-players';
      el.open = playerListOpen[id];
      el.innerHTML = '<summary></summary><div class="msx-nc-body"></div>';
      el.addEventListener('toggle', () => { playerListOpen[id] = el.open; });
    }
    return el;
  }

  function ensureNoCrewPanel() {
    if (!isPlayersPage()) {
      document.querySelectorAll('.msx-players').forEach((n) => n.remove());
      players.api.clear(); players.rows.clear(); players.total = null; players.seenBefore = undefined;
      return;
    }
    const list = document.querySelector('.panel.reg');
    if (!list) return;
    syncCrewless();
    readPlayerRows();
    // Order above the game's list: No crew, then New cats.
    const nc = playerList('msx-nocrew'), nw = playerList('msx-newcats');
    if (nw.nextElementSibling !== list) list.before(nw);
    if (nc.nextElementSibling !== nw) nw.before(nc);

    const fromApi = players.api.size > 0;
    const all = [...(fromApi ? players.api : players.rows).values()];
    const totalM = (document.querySelector('.panel.reg ~ .sr-only, main .sr-only[aria-live]')?.textContent || '').match(/(\d+)\s+cats/);
    const total = players.total || (totalM ? +totalM[1] : null);
    const partial = !total || all.length < total;
    const note = partial ? `<p class="msx-nc-note">${all.length}${total ? ' of ' + total : ''} cats loaded so far. Scroll the list below to the end to load the rest.</p>` : '';
    const isNew = (c) => players.seenBefore != null && c.id > players.seenBefore;
    const newTag = (c) => (isNew(c) ? ' <span class="msx-nc-new" title="Joined since your last visit to this page">🆕</span>' : '');
    const now = Date.now();

    // No crew, highest level first. With the crew bot's last-active times (sharing on, 0.46.9): cats away 48+ hours
    // (or that never did anything) are left out, the rest go most recently active first, then the ones the bot hasn't
    // read yet (highest level first).
    const byLevel = (a, b) => (b.level || 0) - (a.level || 0) || (a.rank || 1e9) - (b.rank || 1e9);
    let noCrew = all.filter((c) => c.none).sort(byLevel);
    const act = crewlessActivity();
    let head = `No crew: ${noCrew.length} cat${noCrew.length === 1 ? '' : 's'}`;
    let actNote = inShareCrew() && !sharingOn() ? '<p class="msx-nc-note">Turn on crew sharing to hide cats away 48+ hours and sort the rest by when they were last active.</p>' : '';
    const lastBit = (c) => {
      if (!act) return '';
      const at = act.get(c.id);
      return at == null ? ' · not checked yet' : ` · active ${agoText(Math.max(0, now - at))}`;
    };
    if (act) {
      const active = noCrew.filter((c) => act.has(c.id) && act.get(c.id) > 0 && now - act.get(c.id) < CREWLESS_ACTIVE_MS).sort((a, b) => act.get(b.id) - act.get(a.id));
      const unread = noCrew.filter((c) => !act.has(c.id));
      const hidden = noCrew.length - active.length - unread.length;
      noCrew = active.concat(unread);
      head = `No crew: ${active.length} active in the last 48h` + (unread.length ? ` · ${unread.length} not checked yet` : '') + (hidden ? ` · ${hidden} away longer hidden` : '');
      actNote = '<p class="msx-nc-note">Last active from the crew bot\'s 🧲 Recruits, which checks each crewless cat\'s page (active ones every 6 hours).</p>';
    }
    setHtml(nc.querySelector('summary'), head + (partial ? ' <small>(so far)</small>' : ''));
    setHtml(nc.querySelector('.msx-nc-body'), note + actNote + (noCrew.length
      ? '<ul>' + noCrew.map((c) => `<li>${catLink(c)}${c.level != null ? ` [${c.level}]` : ''} <small>${c.rank != null ? `#${c.rank} · ` : ''}ID ${c.id}` +
        `${lastBit(c)}${c.joined ? ' · joined ' + agoText(now - c.joined) : ''}</small>${newTag(c)}</li>`).join('') + '</ul>'
      : '<p class="msx-nc-note">None found yet.</p>'));

    // New cats: joined in the last 24 hours (needs the join time, so only from the game's own replies), newest first.
    if (!fromApi) {
      setHtml(nw.querySelector('summary'), 'New cats (last 24h)');
      setHtml(nw.querySelector('.msx-nc-body'), '<p class="msx-nc-note">Needs the game\'s player list: open Players from the sidebar (not a reload) to read it.</p>');
      return;
    }
    const fresh = all.filter((c) => c.joined && now - c.joined < NEW_CAT_MS).sort((a, b) => b.joined - a.joined);
    const sinceVisit = all.filter(isNew).length;
    setHtml(nw.querySelector('summary'), `New cats: ${fresh.length} in the last 24h` + (players.seenBefore != null ? ` · ${sinceVisit} since your last visit` : '') + (partial ? ' <small>(so far)</small>' : ''));
    setHtml(nw.querySelector('.msx-nc-body'), note + (fresh.length
      ? '<ul>' + fresh.map((c) => `<li>${catLink(c)}${c.level != null ? ` [${c.level}]` : ''} <small>· ID ${c.id} · joined ${agoText(now - c.joined)} · ` +
        `${c.none ? 'no crew' : escHtml(c.crew || 'in a crew')}</small>${newTag(c)}</li>`).join('') + '</ul>'
      : '<p class="msx-nc-note">Nobody new in the last 24 hours.</p>'));
  }

  // ─── The rebuilt Crimes pages (0.33.0) ────────────────────────────────────
  // Game build 2026-10-10: /crimes is a street map with "The ladder" of 12 jobs, and each job has its own page,
  // /crimes/<id>, with places to pick (button.cs-hotspot) and a dock for the picked one: Odds / Payout / Heat / XP
  // (dl.cs-quote) and the buttons (button.cs-go, aria-label "Dive, The butcher's yard, 3 nerve, safe odds").
  // Layout from the API log's page snapshots ("newapiscan", 2026-10-10). The odds are only a word now (Safe / Good /
  // Fair), so the numbers here are pay and XP per nerve; the crime's own % is still in the game's data (`crimes[]`).
  const crimePageId = () => { const m = location.pathname.match(/^\/crimes\/([a-z]+)\/?$/); return m ? m[1] : null; };
  const streetCrime = (id) => (apiState && apiState.street && apiState.street.crimes.find((c) => c.id === id)) || null;
  // A place's best paying button: pay per nerve uses the middle of the range; a job that pays once at the end (safe,
  // clock) is spread over all its steps.
  function placeValue(crime, place) {
    let best = null;
    place.acts.forEach((a) => {
      if (!(a.cost > 0) || !Number.isFinite(a.payMin) || !Number.isFinite(a.payMax)) return;
      const cash = (a.payMin + a.payMax) / 2 / (a.cost * crime.steps);
      if (!best || cash > best.cash) best = { act: a, cash, xp: Number.isFinite(a.xp) ? a.xp / a.cost : null, odds: Number.isFinite(a.odds) ? a.odds : null };
    });
    return best;
  }

  // Successes to the next mastery level (0.47.0, user request). The game sends the level and the % of the way to the
  // next one, not the count (masteryNext/toGo went in build 2026-11-08). Every older reading fits one rule for every
  // job: level N is reached at 5 × N² successes (5, 20, 45, 80, 125, 180, 245, 320 ... 2,000 at 20), and the game's %
  // is floor(100 × (successes − 5L²) ÷ (5(L+1)² − 5L²)). When the job's successes and % agree with that, the count is
  // exact; otherwise (say mastery fell back) it's worked out from the % and marked "about".
  const MASTERY_MAX = 20;
  const masteryAt = (n) => 5 * n * n;
  function masteryNext(api) {
    const L = api && api.masteryLevel;
    if (!Number.isInteger(L) || L < 0) return null;
    if (L >= MASTERY_MAX) return { level: L, max: true };
    const from = masteryAt(L), to = masteryAt(L + 1), s = api.successes, pct = api.masteryPercent;
    if (Number.isFinite(s) && s >= from && s < to && (pct == null || Math.floor((100 * (s - from)) / (to - from)) === pct)) {
      return { level: L, toGo: to - s, got: s, need: to, exact: true };
    }
    if (!Number.isFinite(pct)) return null;
    return { level: L, toGo: Math.max(1, Math.ceil(((100 - pct) / 100) * (to - from))), pct, exact: false };
  }
  const masteryShort = (m) => (!m ? '' : m.max ? `M${m.level} (max)` : `M${m.level} · ${m.exact ? '' : '~'}${fmtInt(m.toGo)} to go`);

  // Overview: one line per job you can do, its best open place, pay and XP per nerve; ★ on the best of each.
  function drawCrimeTable() {
    // Under the job list (section.cs-ladder) before build 2026-11-08, under the street (section.cs-street) since.
    const ladder = isCrimesPage() && document.querySelector('section.cs-ladder, section.cs-street');
    const street = apiState && apiState.street;
    let box = document.getElementById('msx-crimetable');
    if (!ladder || !street) { if (box) box.remove(); return; }
    const rows = street.crimes.filter((c) => c.state !== 'locked').map((c) => {
      let best = null;
      c.places.filter((p) => p.open).forEach((p) => { const v = placeValue(c, p); if (v && (!best || v.cash > best.v.cash)) best = { p, v }; });
      return { c, best };
    });
    const top = (k) => rows.reduce((m, r) => (r.best && r.best.v[k] != null && (!m || r.best.v[k] > m.best.v[k]) ? r : m), null);
    const topCash = top('cash'), topXp = top('xp');
    const body = rows.map((r) => {
      const v = r.best && r.best.v;
      const ct = contractForCrime(r.c.id);
      const chip = ct ? `<span class="msx-ct-chip" title="Crew contract ${escHtml(ct.name)}">Crew ${fmtInt(ct.got)}/${fmtInt(ct.goal)}</span>` : '';
      const ms = masteryShort(masteryNext(apiState.crimes[norm(r.c.name)]));
      return `<tr${ct ? ' class="msx-crew-row"' : ''}><td>${escHtml(r.c.name)}${chip}</td><td>${v && v.odds != null ? v.odds + '%' : Number.isFinite(r.c.chance) ? r.c.chance + '%' : '—'}</td><td>${r.best ? escHtml(r.best.p.name) : '<i>nothing open</i>'}</td>` +
        `<td class="${r === topCash ? 'msx-best' : ''}">${v ? (r === topCash ? '★ ' : '') + fmtMoney(v.cash) : '—'}</td>` +
        `<td class="${r === topXp ? 'msx-best' : ''}">${v && v.xp != null ? (r === topXp ? '★ ' : '') + v.xp.toFixed(1) : '—'}</td><td>${ms || '—'}</td></tr>`;
    }).join('');
    const html = '<h3>Best place in each job</h3><table><thead><tr><th>Job</th><th title="The odds the game shows at the best place, with your bonuses and heat.">Success</th><th>Best place now</th>' +
      '<th title="Middle of the payout range per nerve. The safe and the clock pay once for all their steps, so it is spread over them.">$ per nerve</th><th>XP per nerve</th><th title="Mastery level, and successes to the next level (each level is +1 odds)">Mastery</th></tr></thead>' +
      `<tbody>${body}</tbody></table><small>Jobs you can do now (locked ones left out). Success is the game's odds at that place.</small>`;
    if (!box) { box = document.createElement('section'); box.id = 'msx-crimetable'; }
    if (ladder.nextElementSibling !== box) ladder.after(box);
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  // One job's page: pay and XP per nerve under the dock's numbers, the success %, the crew contract line and the heat lock.
  function drawCrimeDock() {
    const id = crimePageId();
    const dock = id && document.querySelector('.cs-dock');
    if (!dock) return;
    const crime = streetCrime(id);
    const quote = dock.querySelector('dl.cs-quote');
    let line = dock.querySelector('.msx-pernerve');
    const payM = quote && (quote.querySelector('.cs-pay, .is-pay dd')?.textContent || '').match(/\$([\d,]+)\s*[–-]\s*\$([\d,]+)/);
    const xpDd = quote && [...quote.querySelectorAll('div')].find((d) => /^XP$/i.test(d.querySelector('dt')?.textContent.trim() || ''));
    const xp = xpDd ? num(xpDd.querySelector('dd')?.textContent) : NaN;
    const costM = (dock.querySelector('button.cs-go.is-main .cs-go-cost')?.textContent || '').match(/(\d+)\s*nerve/);
    const cost = costM ? Number(costM[1]) : NaN;
    if (quote && payM && cost > 0) {
      const steps = crime ? crime.steps : 1;
      const lo = num(payM[1]) / (cost * steps), hi = num(payM[2]) / (cost * steps);
      const text = `≈ ${fmtMoney(lo)}–${fmtMoney(hi)} per nerve` + (Number.isFinite(xp) ? ` · ${(xp / cost).toFixed(1)} XP per nerve` : '') +
        (steps > 1 ? ` (pays once for all ${steps} steps: ${cost * steps} nerve)` : '');
      if (!line) { line = document.createElement('p'); line.className = 'msx-pernerve'; }
      if (quote.nextElementSibling !== line) quote.after(line);
      if (line.textContent !== text) line.textContent = text;
    } else if (line) line.remove();
    drawCrimeChance(crime, dock, quote);
    drawContractLine(id, dock);
    decorateCrimeTools(dock);
    if (crime) applyCrimeLocks(crime, dock);
  }

  // The job's tools: the game lists them in the dock (p.cs-risk > span, "Bolt cutters ×9", class is-missing at ×0;
  // p.cs-gear > span since build 2026-11-08).
  // Each becomes a plain link to that item on Whiskers & Co. (user request 2026-10-10, like the old chips in 0.18.1);
  // the click itself is handled with the old chips' click handler below.
  function decorateCrimeTools(dock) {
    dock.querySelectorAll('.cs-risk > span, .cs-gear > span').forEach((chip) => {
      if (!chip.classList.contains('msx-tool-link')) chip.classList.add('msx-tool-link');
      setTitle(chip, 'Open Whiskers & Co. at ' + toolName(chip));
    });
  }

  // The job's success % (user request 2026-10-10: the page only says Safe / Good / Fair now). It is the game's own
  // number from `crimes[]`, with your bonuses and heat in it, plus the old ▸ Odds breakdown. The word on each place
  // moves around it with the situation (a lamp on the crates, watchers awake on the bike racks, a cat-sized hole), and
  // the game sends no number for that part, so the line says so.
  function drawCrimeChance(crime, dock, quote) {
    const api = crime && apiState.crimes[norm(crime.name)];
    let box = dock.querySelector('.msx-chance');
    if (!quote || !api || !Number.isFinite(api.chance)) { if (box) box.remove(); return; }
    // Since build 2026-11-08 the page shows each place's % itself, so this is only where the job's % comes from.
    // The district's heat right here (user request 2026-11-08: "show the heat on each crime when you view it"): the
    // game's own heat, what it costs in odds, its words for it, and when it is back to 0 (`heatZeroAt`).
    const dist = apiState.street && apiState.street.districts[crime.district];
    const heat = Number.isFinite(api.heat) ? api.heat : dist ? dist.heat : null;
    let heatHtml = '';
    if (Number.isFinite(heat)) {
      const left = api.heatZeroAt - Date.now();
      const bits = [`🔥 <b>${escHtml(dist ? dist.name : 'District')} heat ${heat}</b>`];
      if (heat >= 4) bits.push(`−${Math.floor(heat / 4)} odds`);
      if (api.hot || heat >= HOT_HEAT) bits.push('80+: half XP, no clean jobs');
      if (dist && dist.line) bits.push(escHtml(dist.line));
      bits.push(heat <= 0 ? 'cool' : left > 0 ? `0 in ~${fmtClock(left)}` : 'cooling');
      heatHtml = `<div class="msx-crimeheat${api.hot || heat >= HOT_HEAT ? ' hot' : ''}">${bits.join(' · ')}</div>`;
    }
    const mn = masteryNext(api);
    const mastHtml = !mn ? '' : `<div class="msx-crimeheat">⭐ <b>Mastery ${mn.level}</b>` + (mn.max ? ' · the top level' : ` · ${mn.exact ? '' : 'about '}${fmtInt(mn.toGo)} more success${mn.toGo === 1 ? '' : 'es'} to level ${mn.level + 1}` +
      (mn.exact ? ` (${fmtInt(mn.got)} of ${fmtInt(mn.need)})` : ` (${mn.pct}% there)`) + ' · each level is +1 odds') + '</div>';
    const html = heatHtml + mastHtml + `<small>${api.chance}% for this job with your bonuses and heat${api.ceiling ? `; the most it can be here is ${api.ceiling}%` : ''}</small>` +
      oddsHtmlFromApi({ api, key: norm(crime.name) });
    if (!box) { box = document.createElement('div'); box.className = 'msx-chance'; }
    const after = dock.querySelector('.msx-pernerve') || quote;
    if (after.nextElementSibling !== box) after.after(box);
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  // The heat lock on the new buttons: only buttons that cost nerve (not "Walk out", "Next house"). The script never
  // clicks; it only blocks your own click, with "Unlock anyway" beside it. (The chain mode lock was retired in 0.34.0.)
  function applyCrimeLocks(crime, dock) {
    const btns = [...dock.querySelectorAll('button.cs-go')].filter((b) => /\b\d+ nerve\b/.test(b.getAttribute('aria-label') || ''));
    const d = apiState.street.districts[crime.district] || {};
    const heatOverrides = loadHeatOverrides();
    if (!d.hot && heatOverrides[crime.district]) { delete heatOverrides[crime.district]; GM_setValue(HEAT_OVERRIDE_KEY, JSON.stringify(heatOverrides)); }
    const heatLocked = !!d.hot && !heatOverrides[crime.district];
    btns.forEach((b) => {
      b.classList.toggle('msx-heat-locked', heatLocked);
      if (heatLocked) { if (!b.disabled) b.disabled = true; b.dataset.msxLocked = '1'; }
      else if (b.dataset.msxLocked) { delete b.dataset.msxLocked; b.disabled = false; }
    });
    const notes = [];
    if (d.hot) {
      notes.push(`<div class="msx-heatlock${heatLocked ? ' locked' : ''}">${heatLocked ? `🔒 ${escHtml(d.name || 'District')} heat ${d.heat}: locked` : '🔓 Hot, unlocked by you'}` +
        ` <button type="button" class="msx-heat-toggle" data-district="${escHtml(crime.district)}">${heatLocked ? 'Unlock anyway' : 'Lock again'}</button></div>`);
    }
    let box = dock.querySelector('.msx-croplock');
    const html = notes.join('');
    if (!html) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.className = 'msx-croplock'; dock.querySelector('.cs-deal')?.after(box); }
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  // Which history counts (0.43.2, user request): the market climbed 7–19 Oct and has gone up and down in a new, higher
  // range since ~20 Oct, so the lowest price ever seen is from before the climb. `days` keeps only the last N days (all
  // stocks); a stock's `floors[id]` is your own floor: it counts as the lowest, and prices under it are left out.
  const STOCK_RANGE_KEY = 'ms_stock_range_v1'; // { days: number|null, floors: { id: $ } }
  function stockRange() {
    const r = GM_getValue(STOCK_RANGE_KEY, null) || {};
    return { days: Number(r.days) > 0 ? Number(r.days) : null, floors: r.floors && typeof r.floors === 'object' ? r.floors : {} };
  }
  function setStockRange(change) {
    const r = { ...stockRange(), ...change };
    GM_setValue(STOCK_RANGE_KEY, r);
    schedule();
  }

  function stockStats(id, currentPrice) {
    const obs = (loadDb().stocks[id]?.obs) || [];
    const { days, floors } = stockRange();
    const floor = Number(floors[id]) > 0 ? Number(floors[id]) : null;
    const from = days ? Math.floor((Date.now() - days * 86400000) / PERIOD_MS) : -Infinity;
    // One price per price-period: keep the latest reading in each period.
    const bySlot = new Map();
    obs.forEach((o) => { const k = periodOf(o); if (k != null && k >= from && (!floor || o.price >= floor)) bySlot.set(k, o.price); });
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
    const min = floor || Math.min(...prices), max = Math.max(...prices);
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
    const pos = max > min ? Math.max(0, (currentPrice - min) / (max - min)) : 0.5;
    let verdict = 'learn';
    if (n >= MIN_TICKS_FOR_VERDICT) {
      verdict = flat ? 'flat' : (pct >= HIGH_PCT || pos >= HIGH_PCT) ? 'high' : (pct <= LOW_PCT || pos <= LOW_PCT) ? 'low' : 'mid';
    }
    return { prices, n, min, max, avg, pct, pos, trend, verdict, moves, mw: windowsOf(moves), days, floor };
  }

  const ordinal = (n) => { const r = n % 100; const sfx = r >= 11 && r <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'); return n + sfx; };
  const VERDICT_LABEL = { low: 'Looks LOW', high: 'Looks HIGH', risehigh: 'New high (market rising)', mid: 'Mid-range', flat: 'Flat so far', learn: 'Learning' };

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

  // ─── Market trend (0.32.0, user request) ──────────────────────────────────
  // Until 6 Oct every stock bounced inside its own range (the biggest 3-day move of all six together was 7%); from the
  // evening of 6 Oct all six climbed ~7%/day (API log "Stocks", 2026-10-09). A climb like that makes every price "Looks
  // HIGH", so the box measures the whole market over 3 days and says which kind of market it is. Measured fresh from
  // prices every time, never a fixed rate. Prices come from the stock page's own chart (kept in memory only), or the
  // script's own record when no chart has loaded.
  const TREND_DAYS = 3;
  const TREND_MOVE = 8; // % over 3 days for all six on average: above anything seen before the climb (7%)
  const TREND_STALL = 1.5; // % in the last day below which a climb counts as stalled
  const stockCharts = {}; // range -> { points: { id: [[ms, price], ...] } }
  function onStockChartResponse(json) {
    if (!json || !/^(1d|7d|30d)$/.test(json.range) || !json.points || typeof json.points !== 'object') return;
    stockCharts[json.range] = { points: json.points };
    schedule();
  }
  // Prices for one company as [[ms, price]], oldest first: the longest loaded chart if it reaches back 3 days and is
  // up to date (newest point within 2 hours), otherwise the script's own record.
  function priceSeries(id) {
    const now = Date.now();
    for (const r of ['7d', '30d']) {
      const pts = stockCharts[r] && stockCharts[r].points[id];
      if (Array.isArray(pts) && pts.length > 1 && now - pts[pts.length - 1][0] < 2 * 3600000 && now - pts[0][0] >= TREND_DAYS * 86400000) return pts;
    }
    const bySlot = new Map();
    ((loadDb().stocks[id] && loadDb().stocks[id].obs) || []).forEach((o) => { const k = periodOf(o); if (k != null) bySlot.set(k, o.price); });
    return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([k, p]) => [k * PERIOD_MS, p]);
  }
  // % change from the last price at or before (newest - span) to the newest; null if the record doesn't reach back.
  function changeOver(pts, span) {
    if (pts.length < 2) return null;
    const last = pts[pts.length - 1];
    let then = null;
    for (const p of pts) { if (p[0] <= last[0] - span) then = p; else break; }
    return then && then[1] > 0 && last[0] - then[0] < span + 6 * 3600000 ? (last[1] / then[1] - 1) * 100 : null;
  }
  function stockTrend(id) {
    const pts = priceSeries(id);
    return { d3: changeOver(pts, TREND_DAYS * 86400000), d1: changeOver(pts, 86400000) };
  }
  // The whole market: every company the game lists (short ids from the chart, else from recorded history).
  function marketTrend() {
    const ids = Object.keys((stockCharts['7d'] || stockCharts['30d'] || {}).points || loadDb().stocks || {});
    const all = ids.map(stockTrend).filter((t) => t.d3 != null && t.d1 != null);
    if (all.length < 3) return null;
    const avg = (k) => all.reduce((s, t) => s + t[k], 0) / all.length;
    const d3 = avg('d3'), d1 = avg('d1');
    const up = all.filter((t) => t.d3 > 0).length;
    const state = d3 >= TREND_MOVE ? (d1 >= TREND_STALL ? 'rising' : 'stalled') : d3 <= -TREND_MOVE ? 'falling' : 'flat';
    return { state, d3, d1, up, n: all.length, perDay: d3 / TREND_DAYS };
  }
  // "Looks HIGH" in a rising market is just a new high, not a warning (shown grey instead of red).
  const verdictOf = (st) => (st.verdict === 'high' && marketTrend()?.state === 'rising' ? 'risehigh' : st.verdict);
  const signed = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(Math.abs(x) < 10 ? 1 : 0) + '%';
  function trendHtml(id) {
    const m = marketTrend();
    if (!m || m.state === 'flat') return '';
    const t = stockTrend(id);
    const mine = t.d3 != null ? ` · this stock ${signed(t.d3)} in 3 days${t.d1 != null ? `, ${signed(t.d1)} in the last day` : ''}` : '';
    const text = {
      rising: `📈 <b>Market rising</b> ~${signed(m.perDay)}/day (${m.up} of ${m.n} up over 3 days)${mine}. Waiting for a dip has cost money so far.`,
      stalled: `⚠️ <b>Climb stalled</b>: ${signed(m.d3)} over 3 days but only ${signed(m.d1)} in the last day${mine}.`,
      falling: `📉 <b>Market falling</b> ~${signed(m.perDay)}/day${mine}.`,
    }[m.state];
    return `<small class="msx-mtrend ${m.state}" title="All ${m.n} stocks together over the last 3 days and the last day. Before 6 Oct the market never moved more than 7% in 3 days, so ${TREND_MOVE}% or more counts as a trend. Measured from the prices, never assumed.">${text}</small>`;
  }
  // No trade fees, and the game won't sell you more than the perk amount, so the useful number is what's left to fill.
  function perkRoomText(s) {
    if (!s.perkShares) return '';
    const co = apiState && apiState.stocks && apiState.stocks.companies.find((x) => norm(x.name) === norm(s.name));
    const held = co && Number.isFinite(co.shares) ? co.shares : null;
    if (held == null || held === 0) return ` · perk ≈ ${fmtMoney(s.perkShares * s.price)}`;
    if (held >= s.perkShares) return ' · perk full, no more to buy';
    return ` · ${held.toLocaleString('en-US')}/${s.perkShares.toLocaleString('en-US')} held, rest ≈ ${fmtMoney((s.perkShares - held) * s.price)}`;
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
    if (!box) {
      old?.remove(); box = document.createElement('div'); box.className = 'msx-stock msx-stock-card';
      box.addEventListener('change', onStockRangeChange);
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
    }
    // While typing in its own inputs, the box is left alone (a redraw would drop what's typed).
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
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
      const v = st && (verdictOf(st) === 'low' || verdictOf(st) === 'high') ? st.verdict : '';
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
      setTitle(a, v ? `MeowStreets Extra Info: looks ${v.toUpperCase()} (${Math.round(st.pos * 100)}% of range, ${st.floor ? 'your floor' : 'lowest seen'} $${st.min}, highest $${st.max})` : '');
    });
  }

  function stockBoxHtml(s, st) {
    const arrow = st.trend > 0 ? '↗' : st.trend < 0 ? '↘' : '→';
    const v = verdictOf(st);
    const label = st.verdict === 'learn'
      ? `Learning ${st.n}/${MIN_TICKS_FOR_VERDICT}`
      : `${VERDICT_LABEL[v]} · ${Math.round(st.pos * 100)}% of range · ${ordinal(Math.round(st.pct * 100))} pct`;
    const perkCost = perkRoomText(s);
    return trendHtml(s.id) + `<span class="msx-tag stk ${v}" title="% of range: how far up between the lowest and highest price recorded (0% = lowest seen, 100% = highest seen). pct: the share of recorded price periods that were lower. HIGH or LOW shows when either is within 20% of an end.">${label}</span>` +
      `<span class="msx-trend" title="Average of the last 3 price moves vs the 3 before">${st.n >= 6 ? arrow : ''}</span>` +
      `<small class="msx-moves" title="How many of the last 10 and last 25 price moves went up (↑), down (↓) or stayed the same (=). Only counts moves the script saw one after another, so a gap in the record is skipped.">${movesHtml(st.mw)}</small>` +
      `<small class="msx-range" title="Lowest / highest price this script has recorded, over ${st.n} price moves (avg $${st.avg.toFixed(1)})">` +
      `${st.floor ? 'Your floor' : 'Lowest seen'} <b>$${st.min}</b> · Highest seen <b>$${st.max}</b> · Avg $${st.avg.toFixed(0)}${st.days ? ` (last ${st.days} days)` : ''}${perkCost}</small>` +
      stockRangeHtml(s.id, st) + perkTimingHtml(s.name);
  }
  // The box's own settings line: how many days of history count, and this stock's floor. Blank = all / none.
  function stockRangeHtml(id, st) {
    return `<small class="msx-rangeset" title="Which recorded prices the verdict uses. Days: only the last N days, for every stock (blank = all). Floor: your own lowest price for this stock; prices under it are left out (blank = none). Press Enter or click away to save.">` +
      `Count the last <input class="msx-rs-days" inputmode="numeric" size="3" placeholder="all" value="${st.days || ''}"> days · ` +
      `Floor $<input class="msx-rs-floor" data-co="${escHtml(id)}" inputmode="numeric" size="5" placeholder="none" value="${st.floor || ''}"></small>`;
  }
  function onStockRangeChange(e) {
    const t = e.target;
    if (!t.classList) return;
    const v = Math.floor(Number(String(t.value).replace(/[$,\s]/g, '')));
    if (t.classList.contains('msx-rs-days')) setStockRange({ days: v > 0 ? v : null });
    else if (t.classList.contains('msx-rs-floor') && t.dataset.co) {
      const floors = { ...stockRange().floors };
      if (v > 0) floors[t.dataset.co] = v; else delete floors[t.dataset.co];
      setStockRange({ floors });
    }
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
    el.title = 'Time until the next Claw Street Ex price move (from the game data on any page, counted forward every 15 minutes)';
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
      out = 'Stocks: waiting for game data';
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
    el.title = 'Your crew: crew job, +5% bonus and this week\'s contracts (opens the Crew page)';
    // 0.28.0: no crew chain countdown any more (the game shows its own, user request); this box only holds the crew
    // job and +5% timers and is hidden while neither is running.
    el.innerHTML = '<svg class="ms-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ms-faction"></use></svg>';
    el.style.display = 'none';
    // Place it after the stocks pill, before the vitals.
    if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    updateChainPill();
  }

  // Shows the box only while it holds a crew job or +5% timer (0.28.0).
  function updateChainPill() {
    const el = document.querySelector('.msx-chain');
    if (!el) return;
    const show = !!el.querySelector('.msx-crewjob-inline, .msx-contracts');
    const want = show ? '' : 'none';
    if (el.style.display !== want) el.style.display = want;
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

  // ─── Crew contracts (user request, 0.34.0) ─────────────────────────────────
  // The crew's weekly contracts (three so far: Fish run, Crate week, Open season). `crewWeek` in /api/state on every
  // page gives id, name, goal and got. What a contract counts (crime / attack energy / ...), its rule and level, the pay
  // and your own share only come with the Crew > Contracts tab's reply (/api/crew/contracts); that is kept here for
  // the week. A contract whose id is a crime id (fish, crates) counts that crime even before the tab has been opened.
  // Shown in the sidebar crew box, on the crime it counts (blue), and as a line on the pages an attack or heist
  // contract is about. Crew things are light blue.
  const CONTRACTS_KEY = 'ms_crew_contracts_v1';
  // For the crew bot (sharing on): each contract's id, name, what it counts and the crew's cash reward for it
  // (`reward`); nothing else, nothing of yours.
  function contractPayForBot() {
    const saved = GM_getValue(CONTRACTS_KEY, null);
    if (!saved || !(saved.ends > Date.now()) || !Array.isArray(saved.list)) return null;
    const list = saved.list.filter((c) => c.pay && Number.isFinite(Number(c.pay.cash))).map((c) => ({ id: c.id, name: c.name, counts: c.counts, reward: Number(c.pay.cash) }));
    return list.length ? { ends: saved.ends, list } : null;
  }

  // Treasury payments to members (0.44.3, user request: tick contract pay off by itself). The Crew page's own reply
  // (/api/crew) carries the crew's treasury ledger; payments to a member are reason crew_pay, actor = who got it
  // (crew job cuts too; the bot only uses ones that match what's owed). Kept: the last 60 of those, nothing else.
  const TREASURY_PAYS_KEY = 'ms_treasury_pays_v1';
  function onCrewResponse(json) {
    if (!json || !Array.isArray(json.ledger)) return;
    const list = json.ledger.filter((l) => l && l.reason === 'crew_pay' && typeof l.actor === 'string' && Number(l.amount) > 0 && Number(l.at) > 0)
      .slice(0, 60).map((l) => ({ name: l.actor, amount: Number(l.amount), at: Number(l.at) }));
    GM_setValue(TREASURY_PAYS_KEY, { at: Date.now(), list });
    shareCrew();
  }
  // For the crew bot (sharing on): the last week of them.
  function treasuryPaysForBot() {
    const saved = GM_getValue(TREASURY_PAYS_KEY, null);
    const list = saved && Array.isArray(saved.list) ? saved.list.filter((p) => p.at > Date.now() - 8 * 86400000) : [];
    return list.length ? list : null;
  }

  // 💰 Each member's share of a crime contract's cash reward, right in the contract on Crew → Contracts (0.44.2, user
  // request). The leaders set the crew's cut on the crew bot (it comes back in the bot's replies while sharing is
  // on); the rest is split by everyone's count toward it: floor((reward − cut) × count ÷ all counts), the same sum
  // the bot's 💰 Contract pay uses. ✅ = a leader marked it paid. Counts as of the last time this tab loaded.
  function drawContractPay() {
    const cards = location.pathname.replace(/\/+$/, '') === '/crew' ? document.querySelectorAll('li.tf-kc') : [];
    const saved = GM_getValue(CONTRACTS_KEY, null);
    const cfg = GM_getValue(CONTRACT_CUT_KEY, null);
    const usd = (n) => '$' + n0(n);
    cards.forEach((li) => {
      const name = ((li.querySelector('h4') || {}).textContent || '').trim();
      const c = saved && saved.ends > Date.now() && Array.isArray(saved.list) ? saved.list.find((x) => x.name === name) : null;
      const cash = c && c.pay ? Number(c.pay.cash) : NaN;
      let box = li.querySelector(':scope > .msx-kpay');
      if (!c || c.counts !== 'crime' || !Number.isFinite(cash) || !cfg || !Array.isArray(c.shares) || !c.shares.length) { if (box) box.remove(); return; }
      const pool = Math.floor((cash * (100 - cfg.cut)) / 100);
      const paid = new Set(cfg.ends === saved.ends && Array.isArray(cfg.paid[c.id]) ? cfg.paid[c.id] : []);
      // 🚫 Skipped (and not already paid): their crimes count for nobody, as on the bot.
      const skip = new Set(Array.isArray(cfg.skip) ? cfg.skip : []);
      const out = (s) => skip.has(s.id) && !paid.has(s.id);
      const total = c.shares.reduce((a, s) => a + (out(s) ? 0 : s.got), 0);
      const word = (id) => (paid.has(id) ? 'paid' : c.done ? 'owed' : 'so far');
      const rows = c.shares.filter((s) => s.got > 0).sort((a, b) => b.got - a.got).map((s) => ({ ...s, skip: out(s), owed: out(s) || !total ? 0 : Math.floor((pool * s.got) / total) }));
      const me = rows.find((s) => apiState && s.id === apiState.myId);
      const line = (s) => (s.skip ? `🚫 ${escHtml(s.name)} ${n0(s.got)} <span>skipped</span>` : `${paid.has(s.id) ? '✅ ' : ''}${escHtml(s.name)} ${n0(s.got)} → ${usd(s.owed)} <span>${word(s.id)}</span>`);
      const html = `<div class="msx-kpay-h">💰 Crew keeps ${cfg.cut}% (${usd(cash - pool)}) · <b>${usd(pool)}</b> split by contribution</div>` +
        (me ? `<div class="msx-kpay-me">${me.skip ? `You: ${n0(me.got)} · 🚫 skipped (your share goes to the others)` : `You: ${n0(me.got)} → <b>${usd(me.owed)}</b> ${paid.has(me.id) ? '✅ paid' : word(me.id)}`}</div>` : '') +
        `<details class="msx-kpay-all"><summary>Everyone's share (${rows.length})</summary>` +
        rows.map((s) => `<div>${line(s)}</div>`).join('') + '</details>';
      if (!box) { box = document.createElement('div'); box.className = 'msx-kpay'; }
      const after = li.querySelector(':scope > .tf-kwho') || li.lastElementChild;
      if (after && after.nextElementSibling !== box && after !== box) after.after(box);
      if (box.__msxHtml !== html) { const open = box.querySelector('details') && box.querySelector('details').open; box.innerHTML = html; box.__msxHtml = html; if (open) box.querySelector('details').open = true; }
    });
  }
  function onCrewContractsResponse(json) {
    if (!json || !Array.isArray(json.contracts)) return;
    GM_setValue(CONTRACTS_KEY, {
      ends: Number(json.ends) || 0, at: Date.now(),
      list: json.contracts.filter((c) => c && c.id).map((c) => ({
        id: String(c.id), name: c.name || String(c.id), counts: typeof c.counts === 'string' ? c.counts : null, task: c.task || '', rule: c.rule || '',
        level: Number.isFinite(c.level) ? c.level : null, goal: Number(c.goal) || 0, got: Number(c.got) || 0, done: !!c.done,
        mine: Number.isFinite(c.mine) ? c.mine : null, pay: c.pay && typeof c.pay === 'object' ? c.pay : null,
        // Everyone's count toward it (0.44.2): for each member's share of the reward on this tab.
        shares: Array.isArray(c.shares) ? c.shares.filter((s) => s && Number.isFinite(Number(s.id))).map((s) => ({ id: Number(s.id), name: String(s.name || '?'), got: Number(s.got) || 0 })) : [],
      })),
    });
    schedule();
  }

  function crewContracts() {
    if (!apiState || !apiState.crew) return null;
    const week = apiState.crewWeek;
    const saved = GM_getValue(CONTRACTS_KEY, null);
    const ends = week ? week.ends : saved && saved.ends;
    if (!ends || ends <= Date.now()) return null;
    const extra = saved && saved.ends === ends && Array.isArray(saved.list) ? saved.list : [];
    const crimes = (apiState.street && apiState.street.crimes) || [];
    const list = (week ? week.contracts : extra).map((c) => {
      const x = extra.find((e) => e.id === c.id) || {};
      let crime = crimes.find((k) => k.id === c.id) || null;
      if (!crime && x.task) crime = crimes.find((k) => x.task.toLowerCase().includes(String(k.name).toLowerCase())) || null;
      const counts = x.counts || (crime ? 'crime' : null);
      const kind = counts === 'crime' ? 'crime' : /attack/.test(counts || '') ? 'attack' : /heist/.test(counts || '') ? 'heist' : counts ? 'other' : null;
      return {
        id: c.id, name: c.name, goal: c.goal, got: c.got, done: c.done, kind, counts,
        crimeId: kind === 'crime' && crime ? crime.id : null, crimeName: kind === 'crime' && crime ? crime.name : null,
        task: x.task || '', rule: x.rule || '', level: x.level ?? null, mine: x.mine ?? null, mineAt: saved && saved.at, pay: x.pay || null,
      };
    });
    return { ends, list };
  }

  function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function fmtLeft(ms) {
    const h = Math.max(0, Math.floor(ms / 3600000));
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h >= 1 ? `${h}h ${Math.floor((ms % 3600000) / 60000)}m` : `${Math.max(1, Math.round(ms / 60000))}m`;
  }
  const contractUnit = (c) => (/energy/.test(c.counts || '') ? ' energy' : '');
  const contractLabel = (c) => (c.crimeName || (c.kind === 'attack' ? 'Attacks outside crew' : c.kind === 'heist' ? 'Heists' : c.name));
  function contractTitle(c) {
    const pay = c.pay ? `Pays ${[c.pay.respect ? c.pay.respect + ' respect' : '', c.pay.cash ? fmtMoney(c.pay.cash) : '', c.pay.item ? `${c.pay.quantity || 1} ${c.pay.item}` : ''].filter(Boolean).join(', ')}.` : '';
    const mine = c.mine != null ? ` You: ${fmtInt(c.mine)} (when you last opened Crew > Contracts).` : '';
    return `${c.name}: ${c.task || contractLabel(c)}. ${c.rule ? c.rule + ' ' : ''}${pay}${mine}`.replace(/\.\./g, '.').trim();
  }
  const contractOff = (c) => c.level != null && apiState && Number.isFinite(apiState.playerLevel) && apiState.playerLevel < c.level;

  // Sidebar: the list inside the crew box (the box itself is the old crew job / +5% box, now always shown in a crew).
  function updateContractsPill() {
    const box = document.querySelector('.msx-chain');
    if (!box) return;
    const cc = crewContracts();
    let el = box.querySelector('.msx-contracts');
    if (!cc || !cc.list.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'msx-contracts'; box.appendChild(el); }
    const rows = cc.list.map((c) => `<span class="msx-ct${c.done ? ' done' : ''}${contractOff(c) ? ' off' : ''}" title="${escHtml(contractTitle(c))}">` +
      `<span>${c.done ? '✅ ' : ''}${escHtml(contractLabel(c))}${contractOff(c) ? ` (L${c.level}+)` : ''}</span><b>${fmtInt(c.got)}/${fmtInt(c.goal)}${contractUnit(c)}</b></span>`).join('');
    const html = `<span class="msx-ct-head">Crew contracts · ${fmtLeft(cc.ends - Date.now())} left</span>${rows}`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  // ⚔️ Reminder under the crew contracts (0.49.4, user request): alliance members with sharing on who don't share
  // their battle stats get a link to the Account page, where the switch (and a switch for this reminder) is.
  // A plain link the player clicks; it opens the page and nothing else.
  function updateStatsNudge() {
    const box = document.querySelector('.msx-chain');
    let el = document.querySelector('.msx-statsnudge');
    const want = !!box && inShareCrew() && sharingOn() && !settings.shareStats && !settings.statsNudgeOff;
    if (!want) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('a');
      el.className = 'msx-statsnudge';
      el.href = '/account#msx-stats';
      el.textContent = '⚔️ Share your battle stats with the alliance →';
      setTitle(el, 'Opens the Account page: turn on Share my battle stats, or turn this reminder off.');
    }
    const after = box.querySelector('.msx-contracts');
    if (after) { if (after.nextElementSibling !== el) after.after(el); } else if (el.parentElement !== box) box.appendChild(el);
  }

  // Crimes overview: a blue ring on the contract's crime in the ladder and on the street map.
  function markContractCrimes() {
    const cc = crewContracts();
    const byCrime = new Map();
    ((cc && cc.list) || []).forEach((c) => { if (c.crimeId && !c.done) byCrime.set(c.crimeId, c); });
    document.querySelectorAll('a.cs-step, a.cs-spot, a.cs-li, a.cs-door, a.cs-place, a.cs-jobtab, a.msx-crew-ct').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/^\/crimes\/([a-z]+)\/?$/);
      const c = m ? byCrime.get(m[1]) : null;
      if (a.classList.contains('msx-crew-ct') !== !!c) a.classList.toggle('msx-crew-ct', !!c);
      if (c) setTitle(a, `Crew contract ${c.name}: ${fmtInt(c.got)}/${fmtInt(c.goal)}`);
      else if (a.title && a.title.startsWith('Crew contract ')) a.removeAttribute('title');
    });
  }

  // The contract counting this crime, if any (for the overview table and the job's page).
  function contractForCrime(id) {
    const cc = crewContracts();
    return (cc && cc.list.find((c) => c.crimeId === id && !c.done)) || null;
  }

  // A job's page: a blue ring on the dock and a line under the odds.
  function drawContractLine(id, dock) {
    const c = contractForCrime(id);
    let line = dock.querySelector('.msx-ct-line');
    dock.classList.toggle('msx-crew-dock', !!c);
    if (!c) { if (line) line.remove(); return; }
    const cc = crewContracts();
    const html = `🤝 <b>Crew contract · ${escHtml(c.name)}</b>: ${fmtInt(c.got)}/${fmtInt(c.goal)}` +
      `${c.mine != null ? ` (you ${fmtInt(c.mine)})` : ''} · ${fmtLeft(cc.ends - Date.now())} left` +
      (c.rule ? ` <small>${escHtml(c.rule)}</small>` : '');
    if (!line) { line = document.createElement('div'); line.className = 'msx-ct-line'; }
    const after = dock.querySelector('.msx-chance') || dock.querySelector('.msx-pernerve') || dock.querySelector('dl.cs-quote');
    if (after && after.nextElementSibling !== line) after.after(line);
    if (line.dataset.html !== html) { line.innerHTML = html; line.dataset.html = html; }
    setTitle(line, contractTitle(c));
  }

  // Attack and heist contracts: a line at the top of the pages they are about (Players, a cat's profile, fights;
  // Heists). Other kinds only show in the sidebar until we see what they count.
  function drawContractBanner() {
    const path = location.pathname.replace(/\/+$/, '');
    const want = /^\/(players|cat\/\d+|fight\/[^/]+)$/.test(path) ? 'attack' : path === '/heists' ? 'heist' : null;
    const cc = want && crewContracts();
    const c = cc && cc.list.find((x) => x.kind === want && !x.done);
    let el = document.getElementById('msx-ct-banner');
    const host = document.querySelector('.main-content') || document.querySelector('main');
    if (!c || !host) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'msx-ct-banner'; }
    if (host.firstElementChild !== el) host.prepend(el);
    const html = `🤝 <b>Crew contract · ${escHtml(c.name)}</b>: ${fmtInt(c.got)}/${fmtInt(c.goal)}${contractUnit(c)}` +
      `${c.mine != null ? ` (you ${fmtInt(c.mine)})` : ''} · ${fmtLeft(cc.ends - Date.now())} left` +
      (c.task ? ` <small>${escHtml(c.task)}${c.rule ? '. ' + escHtml(c.rule) : ''}</small>` : '');
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

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
      chainEl.insertBefore(seg, chainEl.querySelector('.msx-contracts'));
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
      if (job) job.before(seg); else chainEl.insertBefore(seg, chainEl.querySelector('.msx-contracts'));
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

  // ─── Cat Café pet and brush (sidebar, every page, 0.41.0, user request) ────
  // A countdown for each until it can be done again, then "ready". From the game's own `cafe.pet/brush.readyAt`.
  // A plain link to the Cat Café; it never pets or brushes anything itself.
  const CAFE_ICON = '<svg viewBox="0 0 48 48" class="msx-item-icon" aria-hidden="true"><path d="M9 18h26v11c0 6-5 10-11 10h-4c-6 0-11-4-11-10Z" fill="#E7EDE1"/><path d="M35 21c6 0 7 3 6 6s-4 4-7 4" fill="none" stroke="#E7EDE1" stroke-width="3.2" stroke-linecap="round"/><ellipse cx="22" cy="18" rx="13" ry="3.4" fill="#8A6A4A"/><path d="M17 12c-2-3 2-4 0-7M26 12c-2-3 2-4 0-7" fill="none" stroke="#8A8F86" stroke-width="1.5" stroke-linecap="round"/><ellipse cx="22" cy="41" rx="16" ry="3" fill="#8A8F86"/></svg>';
  function updateCafePill() {
    const c = apiState && apiState.cafe;
    let el = document.querySelector('.msx-cafe');
    if (!c || !(c.petAt || c.brushAt)) { if (el) el.remove(); return; }
    if (!el) {
      const anchor = document.querySelector('.msx-chain') || document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
      if (!anchor || !anchor.parentNode) return;
      el = document.createElement('a');
      el.href = '/cat-cafe';
      el.className = 'msx-ticker msx-cafe msx-pill-link';
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    const now = Date.now();
    const part = (label, at) => (at > now ? `${label} ${fmtClock(at - now)}` : `${label} <b>ready</b>`);
    const html = `${CAFE_ICON}${part('Pet', c.petAt)} · ${part('Brush', c.brushAt)}`;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('soon', c.petAt <= now || c.brushAt <= now);
    const when = (at) => (at > now ? `ready at ${fmtTime(at)}` : 'ready now');
    const gives = (g, p, what) => (Number.isFinite(g) && Number.isFinite(p) ? `, +${g} ${what} for $${n0(p)}` : '');
    setTitle(el, `Cat Café. Pet a cat: ${when(c.petAt)}${gives(c.petGain, c.petPrice, 'happiness')}. ` +
      `Brush a cat: ${when(c.brushAt)}${gives(c.brushGain, c.brushPrice, 'nerve')}. Figures as of your last page load.`);
  }

  // ─── Pier Nine (sidebar + catch log, 0.42.0, user request) ─────────────────
  // From the game's own `pier` (every page): casts used today of 10 (back at 00:00 UTC), the bucket (fish, grams,
  // value, `off` = when it goes off, 3 days after the catch) and the fish book ({ kind: [count, best grams] }). The
  // Pier page's own /api/pier adds the week's biggest. A plain link; it never casts anything itself.
  function readPier(p) {
    if (!Number.isFinite(p.today) || !Number.isFinite(p.limit)) return null;
    const book = {}, best = {};
    Object.entries(p.book && typeof p.book === 'object' ? p.book : {}).forEach(([k, v]) => { if (Array.isArray(v)) { book[k] = Number(v[0]) || 0; best[k] = Number(v[1]) || 0; } });
    return {
      today: p.today, limit: p.limit, spot: p.spot || null, hook: p.hook || null, tide: p.tide || null, hour: p.hour || null, book, best,
      bait: Object.fromEntries(Object.entries(p.bait && typeof p.bait === 'object' ? p.bait : {}).filter(([, n]) => Number.isFinite(n))),
      bucket: (Array.isArray(p.bucket) ? p.bucket : []).filter((f) => f && f.f && Number(f.at) > 0)
        .map((f) => ({ f: f.f, g: Number(f.g) || 0, v: Number(f.v) || 0, at: Number(f.at), off: Number(f.off) || 0 })),
      // The game's own notes on where each fish bites: { kind: [{ spot, tide: [...] }] } (only kinds it has notes for).
      // Since 2026-11-07 a spot can name tides: bass at The end on "high" and "mid" (the game's words, not `tide`'s).
      notes: Object.fromEntries(Object.entries(p.notes && typeof p.notes === 'object' ? p.notes : {})
        .map(([k, n]) => [k, ((n && Array.isArray(n.at)) ? n.at : []).filter((a) => a && a.spot)
          .map((a) => ({ spot: a.spot, tide: Array.isArray(a.tide) ? a.tide.filter((t) => typeof t === 'string') : [] }))]).filter(([, s]) => s.length)),
      rawNotes: p.notes && typeof p.notes === 'object' ? p.notes : null,
      // Harbour sense, the fishing level: { level, done, toGo (fish to keep for the next), percent, reads ("junk" at 3+) }.
      sense: p.sense && Number.isFinite(p.sense.level) ? { level: p.sense.level, done: !!p.sense.done, toGo: Number(p.sense.toGo) || 0, percent: Number(p.sense.percent) || 0, reads: p.sense.reads || null } : null,
    };
  }
  // The game's own names (Fish book, 2026-11-06). Over the fence is marked Risky in the game.
  const PIER_SPOTS = { boards: 'Under the boards', outflow: 'The outflow', end: 'The end', fence: 'Over the fence' };
  const spotName = (s) => PIER_SPOTS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : '?');
  // The game's own names (Fish book, 2026-11-06); a kind not listed is its id, capitalised.
  const FISH_NAMES = { bass: 'Sea bass', mullet: 'Grey mullet', goldfish: 'Flushed goldfish', crab: 'Shore crab', carp: 'Three-eyed carp', conger: 'Conger eel', boot: 'Old boot', can: 'Tin can', cone: 'Traffic cone' };
  const fishName = (f) => FISH_NAMES[f] || (f ? f.charAt(0).toUpperCase() + f.slice(1) : '?');
  const kg = (g) => (g / 1000).toFixed(1) + ' kg';
  // Over a day: "2d 10h"; under: the usual h:mm:ss.
  const fmtLong = (ms) => (ms >= 86400000 ? `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h` : fmtClock(ms));
  // Casts left now: the count in the data is for the UTC day it was sent; a new UTC day means all 10 again.
  function pierCastsLeft(p, at) {
    return utcDay(at) === utcDay(Date.now()) ? Math.max(0, p.limit - p.today) : p.limit;
  }
  const PIER_ICON = '<svg viewBox="0 0 48 48" class="msx-item-icon" aria-hidden="true"><path d="M8 6 40 6" stroke="#8A8F86" stroke-width="3" stroke-linecap="round"/><path d="M36 6v20" stroke="#E7EDE1" stroke-width="1.6"/><path d="M36 26c0 5-4 7-7 5" fill="none" stroke="#E7EDE1" stroke-width="2.2" stroke-linecap="round"/><path d="M6 36c6-6 16-6 22 0-6 6-16 6-22 0Z" fill="#7FB3C8"/><path d="M28 36l7-5v10Z" fill="#7FB3C8"/><circle cx="12" cy="35" r="1.4" fill="#182316"/></svg>';
  let pierBoard = null; // [{ name, fish, grams, me }] from the Pier page's own /api/pier
  function updatePierPill() {
    const p = apiState && apiState.pier;
    let el = document.querySelector('.msx-pier');
    if (!p) { if (el) el.remove(); return; }
    if (!el) {
      const anchor = document.querySelector('.msx-chain') || document.querySelector('.msx-ticker') || document.querySelector('.sidebar .rail-vitals');
      if (!anchor || !anchor.parentNode) return;
      el = document.createElement('a');
      el.href = '/pier-nine';
      el.className = 'msx-ticker msx-pier msx-pill-link';
      if (anchor.classList.contains('msx-ticker')) anchor.after(el); else anchor.parentNode.insertBefore(el, anchor);
    }
    const now = Date.now();
    const left = pierCastsLeft(p, apiState.at);
    const fresh = p.bucket.filter((f) => f.off > now).sort((a, b) => a.off - b.off);
    const worth = fresh.reduce((s, f) => s + f.v, 0);
    const reset = Date.parse(utcDay(now) + 'T00:00:00Z') + 86400000;
    // The 10 a day are fish KEPT, not casts: a fish that gets away doesn't count or use bait, and past 10 the game
    // says "the rest go back" (2026-11-06 log).
    const casts = left > 0 ? `<b>${left}</b> to keep` : `New day in ${fmtClock(reset - now)}`;
    const next = fresh[0];
    const soonOff = next && next.off - now < 24 * 3600000 ? ` · 1st off ${fmtClock(next.off - now)}` : '';
    const td = tideNow();
    const tideTag = td && td.at && td.at > now ? ` · ${td.next} ${fmtClock(td.at - now)}` : '';
    const html = `${PIER_ICON}${casts}${fresh.length ? ` · ${fmtMoney(worth)}` : ''}${soonOff}${tideTag}`;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('soon', left > 0);
    const lines = [`Pier Nine. ${left} of ${p.limit} fish left to keep today; after that they go back (new day at 00:00 UTC, ${fmtTime(reset)} your time).`];
    if (fresh.length) {
      lines.push(`Bucket: ${fresh.length} fish worth ${fmtMoney(worth)}.`);
      lines.push(`Next to go off: ${fishName(next.f)} ${kg(next.g)} (${fmtMoney(next.v)}), goes off at ${seenAt(next.off)}`);
    }
    const mine = pierBoard ? pierBoard.findIndex((b) => b.me) : -1;
    if (mine >= 0) lines.push(`This week's biggest: you are #${mine + 1} (${fishName(pierBoard[mine].fish)} ${kg(pierBoard[mine].grams)}).`);
    if (td) lines.push(`Tide: ${tideLine(now)}.`);
    if (p.sense) lines.push(`Harbour sense ${p.sense.level}${p.sense.done ? '' : `: ${p.sense.toGo} more fish to keep for level ${p.sense.level + 1} (${p.sense.percent}%)`}.`);
    lines.push('Figures as of your last page load.');
    setTitle(el, lines.join('\n'));
  }
  // The weekly board, as the Pier page's noticeboard shows it (the top 5 only).
  function onPierResponse(json) {
    if (json && Array.isArray(json.board)) {
      const me = apiState && apiState.myId;
      pierBoard = json.board.filter((b) => b && b.fish).map((b) => ({ name: b.name || '', fish: b.fish, grams: Number(b.grams) || 0, me: b.id === me }));
    }
    // A reply that carries the pier itself (a cast's reply may) counts like a state.
    const p = json && (json.pier || (Array.isArray(json.bucket) && Number.isFinite(json.today) ? json : null));
    const pier = p && readPier(p);
    if (pier && apiState) { apiState.pier = pier; notePierCasts(pier, Date.now()); noteFish(pier); }
    schedule();
  }

  // Catch log: each time the cast count goes up by exactly one between two replies the same UTC day, that one cast
  // happened under the spot, bait, tide and hour of the newer reply. What it brought up = the fish-book kind whose
  // count rose (junk too: boots, cans), with weight and value from the bucket fish caught since. Two or more casts
  // between replies can't be told apart, so they are not logged.
  const PIER_LOG_KEY = 'ms_pier_log_v1'; // { last: { day, today, book, bucketAts }, casts: [{ at, spot, hook, tide, hour, f, g, v }] }
  const PIER_LOG_MAX = 3000;
  function notePierCasts(p, at) {
    const log = GM_getValue(PIER_LOG_KEY, null) || { last: null, casts: [] };
    const last = log.last;
    const day = utcDay(at);
    const ats = p.bucket.map((f) => f.at);
    if (last && last.day === day && p.today === last.today + 1) {
      const rose = Object.keys(p.book).filter((k) => p.book[k] > (last.book[k] || 0));
      const fish = p.bucket.filter((f) => !last.bucketAts.includes(f.at)).sort((a, b) => b.at - a.at)[0];
      const f = rose.length === 1 ? rose[0] : fish ? fish.f : null;
      const c = { at, spot: p.spot, hook: p.hook, tide: p.tide, hour: p.hour, f };
      if (fish && fish.f === f) { c.g = fish.g; c.v = fish.v; }
      // Bait used = what went down since the last reply (a thrown prawn counts too). If the bait on the hook didn't go
      // down (bought more in between), one of it is assumed. Cost at the tackle hut's price (baitPrices).
      const used = {};
      Object.keys(p.bait).forEach((k) => { const d = ((last.bait || {})[k] || 0) - p.bait[k]; if (d > 0) used[k] = d; });
      if (p.hook && !used[p.hook] && last.bait) used[p.hook] = 1;
      if (Object.keys(used).length) { c.used = used; c.cost = Object.entries(used).reduce((s, [k, n]) => s + n * (baitPrices()[k] || 0), 0); }
      log.casts.push(c);
      if (log.casts.length > PIER_LOG_MAX) log.casts.splice(0, log.casts.length - PIER_LOG_MAX);
    }
    if (!last || last.day !== day || last.today !== p.today || JSON.stringify(last.book) !== JSON.stringify(p.book) || JSON.stringify(last.bait) !== JSON.stringify(p.bait)) {
      log.last = { day, today: p.today, book: p.book, bait: p.bait, bucketAts: ats };
      GM_setValue(PIER_LOG_KEY, log);
    }
  }
  // Bait prices, each: from your Mews ("5 squid strips for $200.", kind pier_buy_bait) whenever one passes by; until then
  // the ones seen on 2026-11-04 (worms $5, squid strips $40, prawns $50).
  const BAIT_KEY = 'ms_bait_prices_v1';
  const BAIT_NAMES = { worm: 'worms', worms: 'worms', 'squid strip': 'squid', 'squid strips': 'squid', squid: 'squid', prawn: 'prawns', prawns: 'prawns' };
  function baitPrices() { return { worms: 5, squid: 40, prawns: 50, ...(GM_getValue(BAIT_KEY, null) || {}) }; }
  function noteBaitPrices(events) {
    const m = { ...(GM_getValue(BAIT_KEY, null) || {}) };
    let changed = false;
    (events || []).forEach((e) => {
      const x = e && e.kind === 'pier_buy_bait' && String(e.body).match(/^(\d+) ([a-z ]+?) for \$([\d,]+)\./i);
      const k = x && BAIT_NAMES[x[2].toLowerCase()];
      const each = x && Number(x[3].replace(/,/g, '')) / Number(x[1]);
      if (k && each > 0 && m[k] !== each) { m[k] = each; changed = true; }
    });
    if (changed) GM_setValue(BAIT_KEY, m);
  }
  let pierNotedAt = null;
  function notePierFromState() {
    if (!apiState || !apiState.pier || apiState.at === pierNotedAt) return;
    pierNotedAt = apiState.at;
    noteBaitPrices(apiState.events);
    notePierCasts(apiState.pier, apiState.at);
    noteFish(apiState.pier);
    noteTide(apiState.pier.tide, apiState.at);
  }

  // Tide clock (0.43.1, user request): the tide goes Low tide → Coming in → High tide → Going out. Each time a reading
  // shows a new tide less than 30 min after the last one, the change is logged at the midpoint. A stage's length is
  // measured when both its start and its end were seen that way with no gap over 2 h in between. The next change is
  // then: this stage's start + its average length; or, once all four lengths are known, a past change into this
  // tide moved forward by whole cycles. Nothing is guessed before there is data.
  const TIDE_KEY = 'ms_pier_tide_v1'; // { run: { tide, lastAt, start }, changes: [{ from, to, at }], stages: [{ tide, ms }] }
  const TIDES = ['Low tide', 'Coming in', 'High tide', 'Going out'];
  const TIDE_GAP = 30 * 60000, TIDE_BREAK = 2 * 3600000, TIDE_MAX = 200;
  function noteTide(tide, at) {
    if (!tide || !at) return;
    const t = GM_getValue(TIDE_KEY, null) || { run: null, changes: [], stages: [] };
    const cur = t.run;
    if (cur && cur.tide === tide && at - cur.lastAt < TIDE_BREAK) {
      if (at <= cur.lastAt) return;
      cur.lastAt = at;
    } else {
      let start = null;
      if (cur && cur.tide !== tide && at > cur.lastAt && at - cur.lastAt <= TIDE_GAP) {
        start = Math.round((cur.lastAt + at) / 2);
        t.changes.push({ from: cur.tide, to: tide, at: start });
        if (cur.start) t.stages.push({ tide: cur.tide, ms: start - cur.start });
        ['changes', 'stages'].forEach((k) => { if (t[k].length > TIDE_MAX) t[k].splice(0, t[k].length - TIDE_MAX); });
      }
      t.run = { tide, lastAt: at, start };
    }
    GM_setValue(TIDE_KEY, t);
  }
  // { tide, next, at (expected change time or null), start, lens: { tide: [avg ms, count] }, changes }
  function tideNow() {
    const t = GM_getValue(TIDE_KEY, null);
    if (!t || !t.run) return null;
    const lens = {};
    t.stages.forEach((s) => { const l = lens[s.tide] || (lens[s.tide] = [0, 0]); l[0] += s.ms; l[1]++; });
    Object.values(lens).forEach((l) => { l[0] /= l[1]; });
    const tide = t.run.tide, i = TIDES.indexOf(tide);
    const next = i >= 0 ? TIDES[(i + 1) % 4] : null;
    let start = t.run.start, at = null;
    if (start && lens[tide]) at = start + lens[tide][0];
    else if (next && TIDES.every((x) => lens[x])) {
      const cycle = TIDES.reduce((s, x) => s + lens[x][0], 0);
      const into = t.changes.filter((c) => c.to === tide).pop();
      if (into) { start = into.at + Math.floor((t.run.lastAt - into.at) / cycle) * cycle; at = start + lens[tide][0]; }
    }
    return { tide, next, at, start, lens, changes: t.changes.length };
  }
  function tideLine(now) {
    const td = tideNow();
    if (!td) return '';
    if (!td.at) return `${td.tide} (tide clock: ${td.changes} change${td.changes === 1 ? '' : 's'} seen, needs more)`;
    return `${td.tide}, ${td.next} ${td.at > now ? `expected ~${fmtTime(td.at)} (in ~${fmtClock(td.at - now)})` : 'any time now'}`;
  }

  // Fish values (0.42.0, user request): every fish seen in your bucket, once each (kind + catch time), with its weight
  // and value. From your 14 fish on 2026-11-04 the value is weight x a fixed price per kind, rounded to $10 (carp
  // ~$100/kg, mullet ~$90/kg, conger ~$55/kg).
  const FISH_KEY = 'ms_fish_seen_v1'; // { 'kind:at': { f, g, v, at } }
  const FISH_MAX = 5000;
  function noteFish(p) {
    const m = GM_getValue(FISH_KEY, null) || {};
    let changed = false;
    p.bucket.forEach((f) => { const k = f.f + ':' + f.at; if (!m[k] && f.g > 0) { m[k] = { f: f.f, g: f.g, v: f.v, at: f.at }; changed = true; } });
    if (!changed) return;
    const keys = Object.keys(m);
    if (keys.length > FISH_MAX) keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - FISH_MAX).forEach((k) => delete m[k]);
    GM_setValue(FISH_KEY, m);
  }
  // Your catches (0.46.0): each bucket fish once (kind, grams, value, catch time), with the spot, tide and day/night of
  // the logged cast that landed it (same kind and weight), plus logged casts that brought up junk (no weight).
  function fishRecords() {
    const casts = (GM_getValue(PIER_LOG_KEY, null) || { casts: [] }).casts;
    const where = {};
    casts.forEach((c) => { if (c.f && c.g > 0) where[c.f + ':' + c.g] = c; });
    const out = Object.values(GM_getValue(FISH_KEY, null) || {}).map((x) => {
      const c = where[x.f + ':' + x.g];
      const r = { f: x.f, at: x.at, g: x.g, v: x.v };
      if (c) { if (c.spot) r.spot = c.spot; if (c.tide) r.tide = c.tide; if (c.hour) r.hour = c.hour; }
      return r;
    });
    casts.forEach((c) => { if (c.f && !(c.g > 0)) out.push({ f: c.f, at: c.at, spot: c.spot || undefined, tide: c.tide || undefined, hour: c.hour || undefined }); });
    return out.sort((a, b) => a.at - b.at);
  }
  // { kind: { n, w, minG, maxG, sumV, spots, tides, hours } }, the same as the crew bot's summary (bot/lib/fish.js).
  function fishSummary(rows) {
    const by = {};
    rows.forEach((c) => {
      const k = by[c.f] || (by[c.f] = { n: 0, w: 0, minG: 0, maxG: 0, sumV: 0, spots: {}, tides: {}, hours: {} });
      k.n++;
      if (c.g > 0 && Number.isFinite(c.v)) { k.minG = k.w ? Math.min(k.minG, c.g) : c.g; k.maxG = Math.max(k.maxG, c.g); k.sumV += c.v; k.w++; }
      if (c.spot) k.spots[c.spot] = (k.spots[c.spot] || 0) + 1;
      if (c.tide) k.tides[c.tide] = (k.tides[c.tide] || 0) + 1;
      if (c.hour) k.hours[c.hour] = (k.hours[c.hour] || 0) + 1;
    });
    return by;
  }
  // The game's notes as { kind: { spot: [tide, ...] } } (the bot's shape), from `pier.notes`.
  const notesOf = (p) => {
    const m = {};
    Object.entries(p.notes || {}).forEach(([k, at]) => at.forEach((a) => { const t = ((m[k] = m[k] || {})[a.spot] = m[k][a.spot] || []); a.tide.forEach((x) => { if (!t.includes(x)) t.push(x); }); }));
    return m;
  };

  // Crew pool (0.46.0, user request "make sure we are sharing fishing info"; sharing on): send your new catches and the
  // game's notes, get back the crew's summary per kind. The bot keeps each catch once and never who sent it.
  const FISH_POOL_URL = 'http://168.138.79.225:3001/v1/fish';
  const FISH_SYNC_KEY = 'ms_fish_sync_v1'; // { sentTo: newest catch time sent }
  const FISH_CREW_KEY = 'ms_fish_crew_v1'; // { at, n, kinds, notes } the bot's last reply
  const FISH_SEND_GAP_MS = 65000, FISH_REFRESH_MS = 10 * 60000, FISH_SEND_MAX = 500;
  let fishSyncAt = 0, fishSyncBusy = false;
  function syncFish() {
    if (!sharingOn() || fishSyncBusy || typeof GM_xmlhttpRequest !== 'function' || !apiState.pier) return;
    noteSenseText(); // the Fish book's line, if it's open, goes with this send
    const sync = GM_getValue(FISH_SYNC_KEY, null) || {};
    const sentTo = Number(sync.sentTo) || 0;
    const fresh = fishRecords().filter((r) => r.at > sentTo);
    const gap = Date.now() - fishSyncAt;
    const onPier = location.pathname.replace(/\/+$/, '') === '/pier-nine';
    const sense = senseOut();
    const senseNew = JSON.stringify(sense) !== (sync.sense || 'null');
    if (gap < FISH_SEND_GAP_MS || (!fresh.length && !senseNew && !(onPier && gap >= FISH_REFRESH_MS))) return;
    const send = fresh.slice(0, FISH_SEND_MAX);
    fishSyncAt = Date.now(); fishSyncBusy = true;
    GM_xmlhttpRequest({
      method: 'POST', url: FISH_POOL_URL, timeout: 20000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 1, sender: shareId(), crew: shareCrewRef(), catches: send, notes: apiState.pier.rawNotes || null, sense }),
      onload: (r) => {
        fishSyncBusy = false;
        let j = null;
        try { j = JSON.parse(r.responseText); } catch (e) { return; }
        if (!j || !j.ok) return;
        GM_setValue(FISH_SYNC_KEY, { sentTo: send.length ? send[send.length - 1].at : sentTo, sense: JSON.stringify(sense) });
        if (sharingOn()) GM_setValue(FISH_CREW_KEY, { at: Date.now(), n: Number(j.n) || 0, kinds: j.kinds || {}, notes: j.notes || {}, sense: j.sense || {} });
        schedule();
        if (fresh.length > FISH_SEND_MAX) setTimeout(syncFish, FISH_SEND_GAP_MS + 1000);
      },
      onerror: () => { fishSyncBusy = false; },
      ontimeout: () => { fishSyncBusy = false; },
    });
  }

  // Pier page (0.46.0, user request: "more organized ... types of fishes that can be caught in what areas and what
  // times, and avg price/weight range"): one line for the bucket and the tide, then one table row per fish. With
  // sharing on it is the crew's catches; otherwise yours. Where = spots it was caught at, most first, plus the spots
  // in the game's notes (with their tides). When = tides it was caught on, most first, and day or night when only one.
  const TIDE_SHORT = { 'Low tide': 'Low', 'High tide': 'High' };
  function pierFishTable(p) {
    const crew = sharingOn() ? GM_getValue(FISH_CREW_KEY, null) : null;
    const kinds = crew ? crew.kinds : fishSummary(fishRecords());
    const notes = notesOf(p);
    if (crew) Object.entries(crew.notes || {}).forEach(([k, s]) => Object.entries(s).forEach(([spot, t]) => { const m = (notes[k] = notes[k] || {}); m[spot] = [...new Set([...(m[spot] || []), ...t])]; }));
    const all = [...new Set([...Object.keys(kinds), ...Object.keys(p.book), ...Object.keys(notes)])];
    const isJunk = (f) => !(kinds[f] && kinds[f].w) && !(p.best[f] > 0) && (kinds[f] || p.book[f]);
    const most = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const gOrKg = (g) => (g < 1000 ? `${n0(g)} g` : kg(g));
    const weight = (k) => (k.minG === k.maxG ? gOrKg(k.maxG) : k.maxG < 1000 ? `${n0(k.minG)}–${n0(k.maxG)} g` : `${(k.minG / 1000).toFixed(1)}–${kg(k.maxG)}`);
    const avg = (f) => (kinds[f] && kinds[f].w ? kinds[f].sumV / kinds[f].w : -1);
    // ✓ Probably biting now (user request 2026-11-08), from what we know: the game's notes name a spot with no tide, or
    // with this tide (its words: high, low, mid = Coming in / Going out); or catches at this tide, or on all 4. Then
    // day/night: left out only if 3+ catches all came at the other one. Ticked fish go first, best paying first.
    const tide = p.tide, hour = p.hour;
    const word = tide === 'High tide' ? 'high' : tide === 'Low tide' ? 'low' : tide ? 'mid' : null;
    const biting = (f) => {
      if (!tide) return null;
      const k = kinds[f] || { tides: {}, hours: {} };
      const nt = notes[f] || {};
      const noted = Object.entries(nt).filter(([, t]) => !t.length || t.includes(word)).map(([s]) => s);
      const caught = Object.keys(k.tides || {});
      if (!noted.length && !(k.tides && k.tides[tide]) && caught.length < 4) return null;
      const hrs = k.hours || {}, other = Object.keys(hrs).filter((h) => h !== hour);
      if (hour && !hrs[hour] && other.reduce((s, h) => s + hrs[h], 0) >= 3) return null;
      return noted;
    };
    const bite = Object.fromEntries(all.map((f) => [f, biting(f)]));
    const rows = all.filter((f) => !isJunk(f)).sort((a, b) => !!bite[b] - !!bite[a] || avg(b) - avg(a) || (p.book[b] || 0) - (p.book[a] || 0)).map((f) => {
      const k = kinds[f] || { spots: {}, tides: {}, hours: {} };
      const nt = notes[f] || {};
      const tick = bite[f] ? ` <span class="msx-pf-now" title="Probably biting now (${escHtml(tide)}${hour ? ', ' + escHtml(hour) : ''})${bite[f].length ? ': the game\'s notes say ' + escHtml(bite[f].map(spotName).join(', ')) : ': caught at this tide before'}">✓</span>` : '';
      const spots = [...new Set([...most(k.spots), ...Object.keys(nt)])]
        .map((s) => escHtml(spotName(s)) + (nt[s] && nt[s].length ? ` <span class="msx-pf-dim">(${escHtml(nt[s].join('/'))})</span>` : ''));
      const tides = most(k.tides);
      const hours = Object.keys(k.hours);
      const when = [tides.length >= 4 ? 'any tide' : tides.map((t) => TIDE_SHORT[t] || t).join(', '), hours.length === 1 ? hours[0] : ''].filter(Boolean).join(' · ');
      return `<tr${bite[f] ? ' class="now"' : ''}><td><b>${escHtml(fishName(f))}</b>${tick}</td><td>${spots.join(', ') || '?'}</td><td>${escHtml(when) || '?'}</td>` +
        `<td>${avg(f) >= 0 ? '$' + n0(Math.round(avg(f))) : '?'}</td><td>${k.w ? weight(k) : p.best[f] > 0 ? 'best ' + gOrKg(p.best[f]) : '?'}</td></tr>`;
    });
    const junk = all.filter(isJunk).map(fishName);
    const n = crew ? crew.n : Object.values(kinds).reduce((s, k) => s + k.n, 0);
    return {
      title: crew ? `🎣 Pier fish · the crew's ${n0(n)} catches` : `🎣 Pier fish · your ${n0(n)} catches${inShareCrew() ? ' (turn on crew sharing to see the crew\'s)' : ''}`,
      html: (rows.length ? `<table class="msx-pf"><thead><tr><th>Fish</th><th>Where</th><th>When</th><th>Avg</th><th>Weight</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<div>No fish yet.</div>') +
        (rows.length && tide ? `<div class="msx-pf-dim">✓ = probably biting now (${escHtml(tide)}${hour ? ', ' + escHtml(hour) : ''}), from the game's notes and past catches. Ticked fish are listed first, best paying first.</div>` : '') +
        (junk.length ? `<div class="msx-pf-dim">Junk: ${junk.map(escHtml).join(', ')}</div>` : ''),
    };
  }
  // Harbour sense, the fishing level (user request 2026-11-08: "display our fishing level, and look into if it effects
  // anything"). From `pier.sense`: each fish KEPT counts toward the next level (a crew member checked: nothing past the
  // 10 a day). Levels seen: 2 took 25 fish, 3 takes 35. What it does, as far as the game says: at level 3 "Junk gives
  // itself away in the water" (`reads: "junk"`). The Feats page has a ladder for it: Wet paws 5, Regular 10, Old salt
  // 15, Harbourmaster's nightmare 20.
  const SENSE_FEATS = [[5, 'Wet paws'], [10, 'Regular'], [15, 'Old salt'], [20, 'Harbourmaster\'s nightmare']];
  const SENSE_READS = { junk: 'junk shows itself in the water' };
  const SENSE_TITLE = 'Harbour sense is your fishing level. Every fish you keep counts toward the next (fish past the 10 a day don\'t). ' +
    'Level 3: "Junk gives itself away in the water." What later levels do isn\'t known yet. Feats at levels 5, 10, 15 and 20.';
  // What the crew bot is told about your Harbour sense (sharing on): level, what it reads, toGo/percent (so the bot can
  // work out how many fish each level takes), and the game's line under it on the Fish book, if you opened it at this
  // level. The bot keeps it per level, never who sent it, and sends every level back.
  const SENSE_TEXT_KEY = 'ms_sense_text_v1'; // { level, text } the Fish book's line, last seen
  function senseOut() {
    const s = apiState.pier && apiState.pier.sense;
    if (!s) return null;
    const t = GM_getValue(SENSE_TEXT_KEY, null);
    const out = { level: s.level, reads: s.reads, toGo: s.toGo, percent: s.percent };
    if (t && t.level === s.level && t.text) out.text = t.text;
    return out;
  }
  // The Fish book tab (div.pl-sense: "Harbour sense 3" and its line), read when it is open on the page you're on.
  function noteSenseText() {
    const box = document.querySelector('.pl-sense');
    const m = box && (box.querySelector('.pl-sense-top b')?.textContent || '').match(/Harbour sense (\d+)/i);
    const text = box && (box.querySelector('p')?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!m || !text) return;
    const old = GM_getValue(SENSE_TEXT_KEY, null);
    if (!old || old.level !== Number(m[1]) || old.text !== text) GM_setValue(SENSE_TEXT_KEY, { level: Number(m[1]), text });
  }
  // The next levels as the crew has seen them (sharing on): what each does and how many fish it took.
  function senseNextHtml(p) {
    const s = p.sense;
    if (!s || s.done) return '';
    if (!sharingOn()) return inShareCrew() ? '<div class="msx-pf-dim">Turn on crew sharing to see what the next levels do, from crewmates who reached them.</div>' : '';
    const crew = (GM_getValue(FISH_CREW_KEY, null) || {}).sense || {};
    const what = (l) => {
      const c = crew[l];
      if (!c) return null;
      const said = (c.text && c.text[0]) || (c.reads && c.reads.length ? c.reads.map((r) => SENSE_READS[r] || 'reads ' + r).join(', ') : '');
      return said || null;
    };
    const lines = [];
    for (let l = s.level + 1; l <= s.level + 5; l++) {
      const c = crew[l];
      if (!c) { if (l === s.level + 1) lines.push(`<b>Level ${l}:</b> nobody in the crew has reached it yet`); break; }
      const takes = c.fish ? `; then ${c.fish} fish to level ${l + 1}` : '';
      const w = what(l);
      lines.push(`<b>Level ${l}:</b> ${w ? escHtml(w) : 'reached in the crew; what it does isn\'t known yet (open the Fish book at that level to share it)'}${takes}`);
    }
    return lines.length ? `<div class="msx-pf-dim">Next (from the crew): ${lines.join(' · ')}</div>` : '';
  }
  function senseLine(p) {
    const s = p.sense;
    if (!s) return '';
    const bits = [`<b>🎯 Harbour sense ${s.level}</b>`];
    if (s.done) bits.push('top level');
    else {
      const left = pierCastsLeft(p, apiState.at);
      const days = Math.max(0, Math.ceil((s.toGo - left) / p.limit)); // today's fish left to keep, then 10 a day
      bits.push(`${s.percent}% to level ${s.level + 1}: ${s.toGo} more fish to keep` + (s.toGo > left ? ` (~${days} more day${days === 1 ? '' : 's'} at ${p.limit} a day)` : ''));
    }
    if (s.reads) bits.push(escHtml(SENSE_READS[s.reads] || 'reads ' + s.reads));
    const feat = SENSE_FEATS.find(([at]) => at > s.level);
    if (feat) bits.push(`feat "${escHtml(feat[1])}" at ${feat[0]}`);
    return bits.join(' · ');
  }
  function drawPierLog() {
    const host = location.pathname.replace(/\/+$/, '') === '/pier-nine' && document.querySelector('section.pl');
    let box = document.getElementById('msx-pierlog');
    const p = apiState && apiState.pier;
    if (!host || !p) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'msx-pierlog'; }
    if (host.nextElementSibling !== box) host.after(box);
    syncFish();
    const now = Date.now();
    const fresh = p.bucket.filter((f) => f.off > now).sort((a, b) => a.off - b.off);
    const top = [];
    if (fresh.length) top.push(`<b>Bucket:</b> ${fresh.length} fish, ${fmtMoney(fresh.reduce((s, f) => s + f.v, 0))} · next goes off in ${fmtLong(fresh[0].off - now)}`);
    if (tideNow()) top.push(`<b>Tide:</b> ${escHtml(tideLine(now))}`);
    const t = pierFishTable(p);
    const sense = senseLine(p);
    const html = `<div class="msx-pierlog-t">${escHtml(t.title)}</div>${top.length ? `<div>${top.join(' · ')}</div>` : ''}${sense ? `<div title="${escHtml(SENSE_TITLE)}">${sense}</div>${senseNextHtml(p)}` : ''}${t.html}`;
    if (box.innerHTML !== html) box.innerHTML = html;
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
  // Whiskers & Co. price under each item (user request, 0.38.0). Tuna and catnip change price every hour within a range;
  // the game sends price, range and the next change on every page (`items[]`). Shown at the NORMAL price and range
  // (user: players see the normal range here, and their own discounted price in the store), so the discount is undone
  // (`base`, `baseMin`, `baseMax`); the position in the range is the same either way. Where the price
  // sits in its range (0% = the lowest it can be) picks the colour: top quarter black, then red, yellow, and the lowest
  // quarter green. Gold bags for the very lowest: 1 in the lowest 10%, 2 in the lowest 5%, 3 at the lowest price.
  const GOLDBAG_SVG = '<svg class="msx-goldbag" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M9 2.5h6l-1.7 3.4h-2.6Z" fill="#c9a227"/>' +
    '<path d="M10.3 5.9h3.4c3.9 2.1 6.5 5.7 6.5 9.4 0 3.7-3.3 5.7-8.2 5.7s-8.2-2-8.2-5.7c0-3.7 2.6-7.3 6.5-9.4Z" fill="#e9c46a" stroke="#9a7a12" stroke-width="1"/>' +
    '<text x="12" y="17.6" font-size="8.5" font-weight="700" text-anchor="middle" fill="#4a3a06" font-family="sans-serif">$</text></svg>';
  function shopPriceInfo(id) {
    const raw = apiState && apiState.storeItems && apiState.storeItems[id];
    if (!raw) return null;
    const pick = (normal, game) => (Number.isFinite(normal) ? normal : game);
    const it = { ...raw, price: pick(raw.base, raw.price), min: pick(raw.baseMin, raw.min), max: pick(raw.baseMax, raw.max) };
    if (!Number.isFinite(it.price) || !Number.isFinite(it.min) || !Number.isFinite(it.max) || it.max <= it.min) return null;
    // Position from the game's own (discounted) figures when they are there: exact, no rounding from undoing it.
    const gp = Number.isFinite(raw.price) && Number.isFinite(raw.min) && Number.isFinite(raw.max) && raw.max > raw.min;
    const pos = Math.min(1, Math.max(0, gp ? (raw.price - raw.min) / (raw.max - raw.min) : (it.price - it.min) / (it.max - it.min)));
    const lowest = gp ? raw.price <= raw.min : it.price <= it.min;
    const band = pos > 0.75 ? 'top' : pos > 0.5 ? 'high' : pos > 0.25 ? 'mid' : 'low';
    const bags = lowest ? 3 : pos <= 0.05 ? 2 : pos <= 0.10 ? 1 : 0;
    return { it, pos, band, bags, old: it.until > 0 && it.until <= Date.now() };
  }
  function shopPriceHtml(f) {
    const s = shopPriceInfo(f.family);
    if (!s) return '';
    const { it } = s;
    const word = { top: 'top 25% (dear)', high: 'upper middle', mid: 'lower middle', low: 'lowest 25% (cheap)' }[s.band];
    const title = `${f.label} at Whiskers & Co. now: ${fmtMoney(it.price)} (normal price${it.disc ? '; your discount takes some off in the store' : ''}). ` +
      `It moves every hour between ${fmtMoney(it.min)} and ${fmtMoney(it.max)}; now at ${Math.round(s.pos * 100)}% of that (0% = lowest): ${word}.` +
      (s.bags === 3 ? ' This is the lowest it can be.' : s.bags ? ` In the lowest ${s.bags === 2 ? '5' : '10'}%.` : '') +
      (it.until ? (s.old ? ` The price changed at ${fmtTime(it.until)}; it updates on your next page load.` : ` Next price at ${fmtTime(it.until)}.`) : '');
    // The game's own Whiskers & Co. icon (sidebar nav: <use href="#ms-market">), user request 0.38.1.
    const shopIcon = '<svg class="ms-icon msx-shopico" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ms-market"></use></svg>';
    return `<span class="msx-shopprice${s.old ? ' old' : ''}" title="${escHtml(title)}">${shopIcon}<b class="msx-pq msx-pq-${s.band}">${fmtMoney(it.price)}</b>` +
      `<small>${fmtMoney(it.min)}–${fmtMoney(it.max)}</small>${GOLDBAG_SVG.repeat(s.bags)}</span>`;
  }

  function updateConsumablesPill() {
    if (!apiState) { document.querySelector('.msx-consumable')?.remove(); return; }
    const now = Date.now();
    let anyCapped = false;
    const uses = loadUses();
    const cap = apiState.dailyCap || 12;
    const bits = CONSUMABLE_FAMILIES.map((f) => {
      const expires = apiState.cooldowns[f.family];
      const capped = apiState.usedUp.includes(f.family);
      const full = apiState.caps && apiState.caps[f.resource] != null && apiState[f.resource] >= apiState.caps[f.resource];
      let text;
      if (capped) { anyCapped = true; text = 'capped'; }
      else if (expires && expires > now) text = fmtClock(expires - now);
      else text = full ? `${f.resource} full` : 'ready';
      const used = capped ? cap : Math.min(cap, uses[f.family].length); // 0.30.0: uses today out of the daily cap
      return `<span class="msx-itemcol"><span class="msx-item" title="${f.label}: ${used} of ${cap} used today (resets 00:00 UTC)">${ITEM_ICONS[f.family] || ''}${text} <small class="msx-uses${used >= cap ? ' full' : ''}">${used}/${cap}</small></span>` +
        `${shopPriceHtml(f)}</span>`;
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
    setTitle(el, 'Premium tuna and Catnip tea: cooldown, uses today and the Whiskers & Co. price now, from the game’s own data');
    el.classList.toggle('soon', anyCapped);
    const html = bits.join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ─── One timer box under the vitals (sidebar, every page, 0.29.0) ────────
  // User request: the stock tick, tuna/catnip, companion and the other timers sit in one box right under the game's
  // money/energy/nerve/life/happy box (and above Overview), joined to it like part of the same box, with a line
  // between each timer. The pills keep being built where they always were; this moves them into the box each run.
  // The box copies the vitals box's own background, border and corners at run time (its exact style is the game's).
  const RAIL_ORDER = ['.msx-ticker:not(.msx-chain):not(.msx-companion):not(.msx-consumable):not(.msx-heist):not(.msx-pvp):not(.msx-bank):not(.msx-cafe):not(.msx-pier)',
    '.msx-consumable', '.msx-companion', '.msx-cafe', '.msx-pier', '.msx-chain', '.msx-heist', '.msx-pvp', '.msx-bank'];
  function arrangeRail() {
    const vitals = document.querySelector('.sidebar .rail-vitals');
    if (!vitals || !vitals.parentNode) return;
    let rail = document.querySelector('.msx-rail');
    if (!rail) { rail = document.createElement('div'); rail.className = 'msx-rail'; }
    if (vitals.nextElementSibling !== rail) vitals.after(rail);
    RAIL_ORDER.forEach((sel, i) => {
      const el = [...document.querySelectorAll('.sidebar ' + sel)].find((x) => !x.closest('.msx-rail') || x.parentElement === rail);
      if (!el) return;
      const kids = [...rail.children];
      // keep the listed order: put it after the last box that comes before it in RAIL_ORDER
      const before = kids.filter((k) => RAIL_ORDER.slice(0, i).some((s2) => k.matches(s2)));
      const want = before.length ? before[before.length - 1].nextElementSibling : rail.firstElementChild;
      if (el !== want) rail.insertBefore(el, want);
    });
    // Join it to the vitals box: same look, no gap, square corners where they meet.
    if (!vitals.dataset.msxRail) {
      const cs = getComputedStyle(vitals);
      vitals.dataset.msxRail = '1';
      rail.style.marginBottom = cs.marginBottom;
      const bw = parseFloat(cs.borderBottomWidth) || 0;
      const border = bw ? `${cs.borderBottomWidth} ${cs.borderBottomStyle} ${cs.borderBottomColor}` : '1px solid var(--ms-line, rgba(231,237,225,.15))';
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') rail.style.background = cs.backgroundColor;
      rail.style.border = border;
      rail.style.borderTop = border; // the line between the vitals and the first timer
      const corner = (v) => v || (cs.borderRadius || '').split(' ')[0] || '0';
      rail.style.borderBottomRightRadius = corner(cs.borderBottomRightRadius);
      rail.style.borderBottomLeftRadius = corner(cs.borderBottomLeftRadius);
      rail.style.setProperty('--msx-rail-line', bw ? cs.borderBottomColor : 'var(--ms-line, rgba(231,237,225,.15))');
      if (bw) rail.style.borderTop = '0'; // the vitals box's own bottom border already draws that line
      vitals.style.marginBottom = '0';
      vitals.style.borderBottomLeftRadius = '0';
      vitals.style.borderBottomRightRadius = '0';
    }
  }

  // ─── Cat clock (next to the sidebar logo, every page) ─────────────────────
  // The game runs on UTC: the Whiskers daily limit, the 12-a-day tuna/catnip uses and contracts all reset at
  // 00:00 UTC (the Whiskers page says "Resets 00:00 UTC"; the game's own `contractResetAt` lands exactly there).
  // A cat-face clock goes beside the logo (`.sidebar .brand`, seen in a dev-tools capture, Screenshot 335) and a
  // short line under that row counts down to the reset. The weekly reset is in the tooltip only.
  const UTC_DAY_MS = 86400000;
  // ─── XP to the next level (sidebar, every page, user request 0.37.0) ─────
  // The game's XP bar only shows "Lv 15" and "86%", but its screen-reader label has the exact numbers:
  // aria-valuetext "2,519 of 2,900 XP, 86% of the way to level 16". A small line under the bar shows them:
  // "2,519 / 2,900 XP · 381 to go". Read from the bar each time, so it follows the game's own number.
  function ensureXpLine() {
    const line = document.querySelector('.sidebar .xp-line');
    const bar = line && line.querySelector('[role="progressbar"][aria-valuetext]');
    const m = bar && bar.getAttribute('aria-valuetext').match(/([\d,]+)\s+of\s+([\d,]+)\s+XP(?:.*?level\s+(\d+))?/i);
    let el = document.querySelector('.sidebar .msx-xpline');
    if (!m) { if (el) el.remove(); return; }
    const have = num(m[1]), need = num(m[2]);
    const text = `${have.toLocaleString('en-US')} / ${need.toLocaleString('en-US')} XP · ${Math.max(0, need - have).toLocaleString('en-US')} to go`;
    if (!el) { el = document.createElement('div'); el.className = 'msx-xpline'; }
    if (line.nextElementSibling !== el) line.after(el);
    if (el.textContent !== text) el.textContent = text;
    setTitle(el, m[3] ? `XP to level ${m[3]} (from the game's own XP bar)` : 'XP to the next level (from the game\'s own XP bar)');
  }

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
    updateCatClock(); ensureXpLine(); updateTicker(); updateCrewJobPill(); updateCrewBuffPill(); updateContractsPill(); updateStatsNudge(); updateChainPill(); updateHeistPill(); updateCompanionPill(); updatePvpPill(); updateConsumablesPill(); updateBankPill(); updateCafePill(); updatePierPill(); arrangeRail(); }, 1000);

  // ─── Reading page text ─────────────────────────────────────────────────────
  // Page text without our own additions and without the chat column.
  function readMainText(cap) {
    const root = document.querySelector('.main-content') || document.querySelector('main');
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.msx-info, .msx-stock, .msx-heat, .msx-ticker, #msx-gymlock, #msx-ct-banner, .msx-ct-line, #msx-invest, #msx-heists, #msx-crewjobs, #msx-trading, script, style').forEach((n) => n.remove());
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
      if (Number.isFinite(apiState.crewPerkCrime)) { mods.crewPerkCrime = apiState.crewPerkCrime; found = true; touch('perks'); }
      if (apiState.education) {
        mods.eduCrimePoints = apiState.education.eduCrimePoints;
        mods.coursesTaken = apiState.education.coursesTaken;
        mods.eduLandsAt = apiState.education.eduLandsAt;
        found = true; touch('education');
      }
      mods.apiAt = apiState.at;
    }

    // Page reads below are only fallbacks for when the game data hasn't arrived: /api/state carries all of it on every page.
    const apiHas = (k) => !!(apiState && (k === 'merits' ? Object.keys(apiState.meritLines || {}).length : apiState[k]));
    if (path === '/merits' && !apiHas('merits')) {
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

    // The Crew page is no longer read (0.34.0): its blocks were rebuilt on 2026-10-19, and the chain, the +5% window
    // (crew.buff_until) and the Inside line ranks (crewPerks) all come with /api/state on every page.

    if (path === '/mews' && !apiHas('crew')) {
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

    if (path.startsWith('/education') && !apiHas('education')) {
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

  // ─── Cat Tree: stat locks (user request 0.15.8; rebuilt 0.34.0 for the new gym page) ──────
  // Read-only: this never trains or clicks anything. It only blocks YOUR click on the game's Train button while the
  // stat you have picked is locked. The page (so since at least 2026-10-10) has stat chips
  // `button.gy-seg-b[aria-pressed]` (aria-label "Dexterity, 14.39. ...") and ONE Train button `button.gy-go`
  // ("Train dexterity 5 times"). A stat is locked when you lock it, or by auto-lock (on unless turned off): any stat
  // the gym you're at trains slower than its best. At the Ironworks Strength and Defense are x1.6 and Speed and
  // Dexterity x1.0, so Speed and Dexterity lock. The multipliers are the game's own (`gyms[].gains`, the one with
  // state 'here'). Clicking a chip flips it, auto-locked ones too (kept per gym). Stored in this browser only.
  const GYM_LOCK_KEY = 'ms_gym_locks_v1'; // { strength: true, ..., unlock: { <gymId>: { speed: true } } }
  const GYM_AUTO_KEY = 'ms_gym_autolock_v1'; // '1' (default) or '0'
  const GYM_STATS = ['strength', 'defense', 'speed', 'dexterity'];
  function loadGymLocks() { try { return JSON.parse(GM_getValue(GYM_LOCK_KEY, '{}')) || {}; } catch (e) { return {}; } }
  function saveGymLocks(locks) { GM_setValue(GYM_LOCK_KEY, JSON.stringify(locks)); }
  const gymAutoOn = () => GM_getValue(GYM_AUTO_KEY, '1') !== '0';
  const onCatTree = () => location.pathname.replace(/\/+$/, '') === '/cat-tree';

  // For each stat: 'you' (your own lock), 'auto' (slower here than this gym's best) or null.
  function gymLockReasons() {
    const locks = loadGymLocks();
    const gym = apiState && apiState.gym;
    const gains = gym && gym.gains;
    const best = gains ? Math.max(...GYM_STATS.map((k) => Number(gains[k]) || 0)) : 0;
    const freed = (gym && locks.unlock && locks.unlock[gym.id]) || {};
    const out = {};
    GYM_STATS.forEach((k) => {
      const slower = gymAutoOn() && best > 0 && (Number(gains[k]) || 0) < best;
      out[k] = locks[k] === true ? 'you' : slower && !freed[k] ? 'auto' : null;
    });
    return out;
  }

  function pickedStat() {
    const chip = document.querySelector('button.gy-seg-b[aria-pressed="true"]');
    const m = chip && (chip.getAttribute('aria-label') || chip.textContent || '').match(/^\s*(strength|defense|speed|dexterity)\b/i);
    if (m) return m[1].toLowerCase();
    const go = document.querySelector('button.gy-go');
    const g = go && go.textContent.match(/\bTrain\s+(strength|defense|speed|dexterity)\b/i);
    return g ? g[1].toLowerCase() : null;
  }

  // Click on a chip: a locked stat unlocks (your lock dropped; an auto lock is lifted for this gym only), an unlocked
  // one locks (a lifted auto lock goes back to auto, otherwise it becomes your own lock).
  function toggleGymLock(stat) {
    const locks = loadGymLocks();
    const gymId = apiState && apiState.gym && apiState.gym.id;
    const freed = gymId && locks.unlock && locks.unlock[gymId];
    if (gymLockReasons()[stat]) {
      delete locks[stat];
      saveGymLocks(locks);
      if (gymLockReasons()[stat] === 'auto' && gymId) {
        locks.unlock = locks.unlock || {};
        (locks.unlock[gymId] = locks.unlock[gymId] || {})[stat] = true;
      }
    } else if (freed && freed[stat]) delete freed[stat];
    else locks[stat] = true;
    saveGymLocks(locks);
    applyGymLocks();
  }

  function applyGymLocks() {
    let bar = document.getElementById('msx-gymlock');
    const go = onCatTree() && document.querySelector('button.gy-go');
    const seg = go && document.querySelector('.gy-seg');
    if (!go || !seg) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'msx-gymlock';
      bar.addEventListener('click', (e) => {
        const chip = e.target.closest && e.target.closest('button[data-stat]');
        if (chip) { e.preventDefault(); toggleGymLock(chip.dataset.stat); }
      });
      bar.addEventListener('change', (e) => {
        if (e.target.matches && e.target.matches('input.msx-gymauto')) { GM_setValue(GYM_AUTO_KEY, e.target.checked ? '1' : '0'); applyGymLocks(); }
      });
    }
    if (seg.nextElementSibling !== bar) seg.after(bar);
    const why = gymLockReasons();
    const gym = apiState && apiState.gym;
    const gains = gym && gym.gains;
    const best = gains ? Math.max(...GYM_STATS.map((k) => Number(gains[k]) || 0)) : 0;
    const x = (k) => (gains && Number.isFinite(Number(gains[k])) ? ` ×${Number(gains[k]).toFixed(1)}` : '');
    const picked = pickedStat();
    const blocked = picked && why[picked];
    const chips = GYM_STATS.map((k) => `<button type="button" data-stat="${k}" class="msx-gl-chip${why[k] ? ' locked' : ''}" title="${
      why[k] === 'auto' ? `Locked: this gym trains ${statAbbr(k)} slower than its best. Click to allow it here.`
        : why[k] === 'you' ? 'Locked by you. Click to unlock.' : 'Click to lock: the Train button is blocked while this stat is picked.'
    }">${why[k] ? '🔒' : '🔓'} ${statAbbr(k)}${x(k)}</button>`).join('');
    const auto = `<label title="Lock every stat this gym trains slower than its best (the game's own multipliers). Never trains or clicks anything.">` +
      `<input type="checkbox" class="msx-gymauto"${gymAutoOn() ? ' checked' : ''}> Auto-lock slower stats${best ? ` (best here ×${best.toFixed(1)})` : ''}</label>`;
    const note = blocked ? `<span class="msx-gl-note">Train is blocked: ${statAbbr(picked)} is locked${
      blocked === 'auto' && gains ? ` (×${Number(gains[picked]).toFixed(1)} here, best ×${best.toFixed(1)})` : ''}. Click its chip to unlock.</span>` : '';
    const html = `<span>Locks:</span>${chips}${auto}${note}`;
    if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
    if (go.disabled !== !!blocked) go.disabled = !!blocked;
    go.classList.toggle('msx-train-locked', !!blocked);
    setTitle(go, blocked ? `${statAbbr(picked)} is locked by MeowStreets Extra Info. Unlock it in the Locks row above.` : '');
  }

  // Backup for the moment between picking a stat and the next redraw: a click on Train while the picked stat is
  // locked is stopped before the game sees it. Only ever blocks; it never clicks anything.
  window.addEventListener('click', (e) => {
    const go = e.target && e.target.closest && e.target.closest('button.gy-go');
    if (!go || !onCatTree()) return;
    const stat = pickedStat();
    if (stat && gymLockReasons()[stat]) {
      e.preventDefault(); e.stopImmediatePropagation();
      toast(`${statAbbr(stat)} is locked (MeowStreets Extra Info). Unlock it in the Locks row above Train.`);
      applyGymLocks();
    }
  }, true);

  // ─── Cat Tree: energy trained towards the next gym (0.40.0, user request) ──────
  // The game only draws a bar for this (the numbers sit in its screen-reader text), so the script writes them out:
  // a line under the gym's description in the training view, "x to go" on each next gym's door in the Switch gyms
  // hall, and the exact figures on that gym's card. From the game's own data (`gymEnergySpent`, and `required` on
  // the gyms in state 'next'), sent with every page and after every training session.
  function drawGymProgress() {
    const spent = apiState && apiState.gymSpent;
    const next = (apiState && apiState.gymsNext) || [];
    const on = onCatTree() && Number.isFinite(spent);
    // Training view: one line under the description.
    const say = on && document.querySelector('p.gy-say');
    let line = document.getElementById('msx-gymnext');
    if (!say) { if (line) line.remove(); } else {
      if (!line) { line = document.createElement('div'); line.id = 'msx-gymnext'; }
      if (say.nextElementSibling !== line) say.after(line);
      const groups = {};
      next.forEach((g) => { (groups[g.required] = groups[g.required] || []).push(g); });
      const parts = Object.keys(groups).map(Number).sort((a, b) => a - b).map((req) => {
        const names = groups[req].map((g) => g.short).join(' & ');
        const left = req - spent;
        return left > 0 ? `${names} open at ${n0(req)} · <b>${n0(left)} to go</b>` : `${names}: <b>ready to join</b>`;
      });
      const html = `⚡ ${n0(spent)} energy trained${parts.length ? ' · ' + parts.join(' · ') : ''}`;
      if (line.dataset.html !== html) { line.innerHTML = html; line.dataset.html = html; }
      const prices = next.filter((g) => g.price).map((g) => `${g.name} $${n0(g.price)}`);
      setTitle(line, prices.length ? `Membership once open: ${prices.join(', ')}. From the game's own data.` : 'Energy you have spent training, from the game\'s own data.');
    }
    // Switch gyms hall: "x to go" on each next gym's door, exact figures on the picked gym's card.
    const byName = (name) => next.find((g) => g.name === name || g.short === name);
    document.querySelectorAll('.co-door.st-next .co-plate').forEach((plate) => {
      const g = on && byName((plate.querySelector('b') || {}).textContent);
      let tag = plate.querySelector('.msx-gymtogo');
      if (!g) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('small'); tag.className = 'msx-gymtogo'; plate.appendChild(tag); }
      const text = g.required > spent ? `${n0(g.required - spent)} to go` : 'ready';
      if (tag.textContent !== text) tag.textContent = text;
    });
    const card = document.querySelector('.gy-panel .co-card');
    const g = on && card && card.querySelector('.gy-chip.st-next') && byName((card.querySelector('.gy-room-head h3') || {}).textContent);
    let fig = document.getElementById('msx-gymfig');
    if (!g) { if (fig) fig.remove(); return; }
    const doBox = card.querySelector('.co-do');
    if (!doBox) return;
    if (!fig) { fig = document.createElement('div'); fig.id = 'msx-gymfig'; }
    const bar = doBox.querySelector('.progress');
    if (bar ? bar.nextElementSibling !== fig : fig.parentNode !== doBox) { if (bar) bar.after(fig); else doBox.prepend(fig); }
    const left = g.required - spent;
    const text = `${n0(Math.min(spent, g.required))} of ${n0(g.required)} energy trained · ${left > 0 ? `${n0(left)} to go` : 'ready to join'}`;
    if (fig.textContent !== text) fig.textContent = text;
  }

  // ─── Crew Info tab: members sorted by last action (0.40.0, user request) ──────
  // The game lists members by rank. This puts the most recently active first, from each row's own "Last action"
  // time (`td.tf-seen time[datetime]`). Click the Last action header to switch back to the game's order (its own #
  // column) and again to sort. Only moves the rows on screen; it clicks and sends nothing.
  const CREW_SORT_KEY = 'ms_crew_sort_v1'; // '1' (default) = last action first, '0' = the game's order
  const crewSortOn = () => GM_getValue(CREW_SORT_KEY, '1') !== '0';
  function sortCrewMembers() {
    const table = document.querySelector('.tf-members table.tf-table');
    const body = table && table.tBodies[0];
    if (!body) return;
    const head = [...table.querySelectorAll('thead th')].find((th) => /^\s*Last action/i.test(th.textContent));
    if (head) {
      head.classList.add('msx-sorthead');
      let mark = head.querySelector('.msx-sortmark');
      if (!mark) { mark = document.createElement('span'); mark.className = 'msx-sortmark'; head.appendChild(mark); }
      const text = crewSortOn() ? ' ▼' : '';
      if (mark.textContent !== text) mark.textContent = text;
      setTitle(head, crewSortOn() ? 'Sorted by last action (MeowStreets Extra Info). Click for the game\'s order.' : 'Click to sort by last action (MeowStreets Extra Info).');
    }
    const rows = [...body.rows];
    const gameNo = (tr) => { const v = parseInt((tr.querySelector('td.tf-q') || {}).textContent, 10); return Number.isFinite(v) ? v : 1e9; };
    const seen = (tr) => { const t = tr.querySelector('td.tf-seen time[datetime]'); const v = t ? Date.parse(t.getAttribute('datetime')) : NaN; return Number.isFinite(v) ? v : -Infinity; };
    const want = rows.slice().sort(crewSortOn() ? (a, b) => (seen(b) - seen(a)) || (gameNo(a) - gameNo(b)) : (a, b) => gameNo(a) - gameNo(b));
    if (want.every((tr, i) => tr === rows[i])) return;
    want.forEach((tr) => body.appendChild(tr));
  }
  window.addEventListener('click', (e) => {
    const th = e.target && e.target.closest && e.target.closest('.tf-members th.msx-sorthead');
    if (!th) return;
    GM_setValue(CREW_SORT_KEY, crewSortOn() ? '0' : '1');
    sortCrewMembers();
  });

  // The "Script data" checklist (which pages to open) was removed in 0.34.0: merits, education, crew, crew perks and
  // stock prices all come with /api/state on every page now, so there is nothing to go and open. (Its crew row went
  // red after 20 minutes; the crew chain window is 15 minutes since 2026-10-19 and every page refreshes it anyway.)

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
      panel.innerHTML = '<h2>Crew jobs: respect, XP/nerve and $/nerve</h2><div class="msx-calc-body"></div>';
      host.appendChild(panel);
    }
    const body = panel.querySelector('.msx-calc-body');
    const tiers = apiState?.crewJobTiers || [];
    if (!tiers.length) { body.innerHTML = '<p class="msx-inv-note">Waiting for the game’s own crew job data (open this page once it has loaded).</p>'; return; }
    let h = '<p class="msx-inv-note">The $ you personally get ("cut") is fixed per member, the same for every role. This assumes a bust pays nothing personally, only the crew’s treasury ("take") and respect are separate from your own cut.</p>';
    // Respect for the crew (user request 2026-11-10, "the best way to farm respect"): per cat-hour = respect ÷ (run
    // hours × cats in it), with the fewest cats the job takes (the most it can be) and, smaller, with a full team.
    // Per 100 nerve = respect ÷ (nerve × cats), if every cat in it spends the nerve. Both are for a job that comes off;
    // the chance is the game's base chance, and the team's stats raise it, so it isn't multiplied in.
    const perHour = (t, n) => (t.duration > 0 && n > 0 ? t.respect / ((t.duration / 3600000) * n) : null);
    const perNerve = (t, n) => (t.nerve > 0 && n > 0 ? (100 * t.respect) / (t.nerve * n) : null);
    const bestHour = Math.max(...tiers.map((t) => perHour(t, t.minMembers) || 0));
    const bestNerve = Math.max(...tiers.map((t) => perNerve(t, t.minMembers) || 0));
    const fmtR = (v, best) => (v == null ? '—' : (v >= best - 1e-9 && best > 0 ? `<b>${v.toFixed(2)} ★</b>` : v.toFixed(2)));
    h += '<p class="msx-inv-note"><b>Respect / cat-hour</b>: the crew\'s respect for each hour each cat spends in the job, with the fewest cats it takes (with a full team below it). <b>Respect / 100 nerve</b>: for every 100 nerve the team spends, if each cat in it spends the job\'s nerve. Both count a job that comes off; ★ = best.</p>';
    h += '<table class="msx-inv-table"><thead><tr><th>Job</th><th>Chance</th><th>Nerve</th><th>Your cut</th><th>To treasury</th><th>Respect</th><th>Cats</th><th>Respect / cat-hour</th><th>Respect / 100 nerve</th><th>XP/nerve</th><th>$/nerve</th><th>Run</th></tr></thead><tbody>';
    tiers.forEach((t) => {
      const c = t.chance / 100;
      const xpEv = c * t.xp + (1 - c) * t.xpFail;
      const dollarEv = c * t.cut;
      const full = t.maxMembers > t.minMembers;
      const hourFull = full ? perHour(t, t.maxMembers) : null;
      const nerveFull = full ? perNerve(t, t.maxMembers) : null;
      h += `<tr><td>${escHtml(t.name)}<br><small>tier ${t.tier} · level ${t.level}+</small></td><td>${t.chance}%</td><td>${t.nerve}</td>` +
        `<td>${money0(t.cut)}</td><td>${money0(t.take)}</td><td>${t.respect}</td>` +
        `<td>${t.minMembers}${full ? '–' + t.maxMembers : ''}</td>` +
        `<td>${fmtR(perHour(t, t.minMembers), bestHour)}${hourFull != null ? `<br><small>${hourFull.toFixed(2)} with ${t.maxMembers}</small>` : ''}</td>` +
        `<td>${fmtR(perNerve(t, t.minMembers), bestNerve)}${nerveFull != null ? `<br><small>${nerveFull.toFixed(2)} with ${t.maxMembers}</small>` : ''}</td>` +
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
      const html = it ? whiskersHtml(it) : '';
      if (!html) { if (box) box.remove(); return; }
      if (!box) { box = document.createElement('div'); box.className = 'msx-ws'; text.appendChild(box); }
      if (box.__msxHtml !== html) { box.innerHTML = html; box.__msxHtml = html; }
    });
  }

  // The Account page switch and the card below both turn sharing on or off this way.
  function setSharing(on) {
    settings.shareOff = !on;
    saveSettings();
    if (on) { shareCrew(); syncStocks(true); }
  }

  // ─── Crime mastery unlocks shared across the alliance (0.49.0, user request) ───
  // The game only says what a mastery unlock ("rung", at mastery 3/6/10/15/20) does once you reach it. With sharing on,
  // the ones you have reached (name and text, from the game's own data) go to the bot, and every one the alliance has
  // reached comes back: shown on a job's page under a rung you haven't reached yet, and on its peg's tooltip.
  const RUNGS_URL = 'http://168.138.79.225:3001/v1/rungs';
  const RUNG_POOL_KEY = 'ms_rung_pool_v1'; // { crimeId: { at: { name, text } } }
  const RUNG_SYNC_KEY = 'ms_rung_sync_v1'; // { sig, at } of the last send
  const RUNG_SYNC_GAP_MS = 30 * 60000;
  let rungBusy = false;
  function syncRungs() {
    if (!sharingOn() || rungBusy || typeof GM_xmlhttpRequest !== 'function' || !apiState || !apiState.street) return;
    const mine = [];
    apiState.street.crimes.forEach((c) => (c.rungs || []).forEach((r) => { if (r.got && r.text) mine.push([c.id, r.at, r.name, r.text]); }));
    const sig = JSON.stringify(mine);
    const last = GM_getValue(RUNG_SYNC_KEY, null) || {};
    if (last.sig === sig && Date.now() - (last.at || 0) < RUNG_SYNC_GAP_MS) return;
    GM_setValue(RUNG_SYNC_KEY, { sig, at: Date.now() });
    rungBusy = true;
    const done = () => { rungBusy = false; };
    GM_xmlhttpRequest({
      method: 'POST', url: RUNGS_URL, timeout: 15000, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ v: 1, sender: shareId(), crew: shareCrewRef(), rungs: mine }),
      onload: (r) => { done(); let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* not json */ } if (j && j.ok && sharingOn() && j.rungs && typeof j.rungs === 'object') { GM_setValue(RUNG_POOL_KEY, j.rungs); schedule(); } },
      onerror: done, ontimeout: done,
    });
  }
  // A job's page: "🔓 Found by the alliance: …" under the rung line while it shows one you haven't reached, and the same
  // text on each such peg's tooltip.
  function drawRungTips() {
    const id = crimePageId();
    const climb = id && document.querySelector('.cs-climb');
    let tip = document.querySelector('.msx-rungtip');
    const pool = (climb && sharingOn() && (GM_getValue(RUNG_POOL_KEY, null) || {})[id]) || null;
    if (!pool) { if (tip) tip.remove(); return; }
    const c = streetCrime(id);
    const got = new Set(((c && c.rungs) || []).filter((r) => r.got).map((r) => r.at));
    const atOf = (peg) => { const m = (peg.getAttribute('aria-label') || '').match(/^Mastery (\d+):/); return m ? Number(m[1]) : null; };
    let shownAt = null;
    climb.querySelectorAll('.cs-peg').forEach((peg) => {
      const at = atOf(peg);
      const known = at != null && !peg.classList.contains('is-got') && !got.has(at) && pool[at];
      if (known) setTitle(peg, `🔓 Found by the alliance: ${known.text}`);
      if (peg.getAttribute('aria-pressed') === 'true') shownAt = at;
    });
    const line = climb.querySelector('.cs-rung');
    const known = line && shownAt != null && !got.has(shownAt) && pool[shownAt];
    if (!known) { if (tip) tip.remove(); return; }
    if (!tip) { tip = document.createElement('p'); tip.className = 'msx-rungtip'; }
    if (line.nextElementSibling !== tip) line.after(tip);
    const txt = `🔓 Found by the alliance: ${known.text}`;
    if (tip.textContent !== txt) tip.textContent = txt;
    setTitle(tip, 'What this unlock does, from an alliance member who has reached it (crew sharing). The game only shows it once you get there.');
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
      '<p class="msx-acc-sub">Settings for the userscript. It also reads (never requests) the JSON the game\'s own pages fetch from their own API, for exact crime, merit and crew numbers; only specific known fields are kept, never your email or other players\' data. Everything it records stays on this computer. It only sends or asks for anything through the sharing switch below (on unless you turn it off) or a game API key you save below.</p>' +
      '<h3>Recording</h3>' +
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-events"> Log my Mews events (crime results, trades, training)</label>' +
      '<div id="msx-acc-outbox" hidden><button type="button" id="msx-acc-outbtn"></button></div>' +
      '<div id="msx-acc-sharebox" hidden><h3>Crew Discord bot</h3>' +
      '<p class="msx-acc-sub" id="msx-acc-allynote" hidden>Your crew is in the Cataclysm alliance. With sharing on, only the pooled parts below go to The Purrfessionals\' bot and come back pooled from the whole alliance: stock prices, the feats you have earned, other cats\' gear from your fights, your own level and worn gear (so the alliance sees them on your profile; your battle stats only with Share my battle stats on), the crime mastery unlocks you have reached, the newest cat id from the Players page, your Pier Nine catches with the fish book\'s notes and your Harbour sense. Nothing about your own crew (chain, jobs, contracts, treasury, deposits) is sent, and there are no Discord posts. Your cat id goes with each, so the bot can check you are on your crew\'s member list.</p>' +
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-share"> Share with The Purrfessionals\' Discord bot<span id="msx-acc-sharewhat"> (with your cat id, checked against the crew\'s member list): crew chain, crew jobs, stock prices, the feats you have earned, other cats\' gear from your fights, your own level and worn gear (battle stats only with Share my battle stats on), the crime mastery unlocks you have reached, the newest cat id from the Players page, the crew contracts\' cash rewards and the treasury\'s payments to members from the Crew page, the crew\'s finished chains (each cat\'s links, crimes and fights) from the chain history, the results of heists you were in (each member\'s payout), your Pier Nine catches (fish, weight, price, spot, tide, day or night) and the fish book\'s notes and your Harbour sense, and only if the leaders entered a 💳 bank loan for you, your open bank deposits (amount, rate, end time) (for chain and job posts, the crew\'s shared stock lows/highs, how to get hidden feats, what mastery unlocks do, other cats\' ⚔️ gear and the battle stats alliance members chose to share, the leaders\' recruiting list, contract payouts, the crew\'s fish table, chain reports and heist results; nothing else, never sent to MeowStreets)</span></label></div>' +
      '<div id="msx-acc-statsbox" hidden><h3 id="msx-stats">Battle stats</h3>' +
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-stats"> Share my battle stats</label>' +
      '<p class="msx-acc-sub">Off unless you turn it on. Your base strength, defense, speed and dexterity (no temporary boosts) go to The Purrfessionals\' bot and show on your profile and the Players list for the Cataclysm alliance\'s script users, and nobody else. Turn it off and they are taken back. Only cats who turn this on show stats; nobody else\'s are ever kept. Needs sharing on.</p>' +
      '<label class="msx-acc-check"><input type="checkbox" id="msx-acc-statsnudge"> Remind me in the sidebar (under the crew contracts) while I\'m not sharing them</label></div>' +
      '<h3>Game API key (optional)</h3>' +
      '<p class="msx-acc-sub">Make a <b>Public</b> key under Account in the game, named after this script, and paste it here. The script then reads one thing with it: the game\'s own shield time for lying-low cats on the Players list (🛡️ ready), at most one cat every 3 seconds. The key stays in this browser, goes only to meowstreets.com and never to the crew bot. Remove it here and revoke it in the game when you stop using it.</p>' +
      '<div class="msx-acc-key"><input type="password" id="msx-acc-key" autocomplete="off" spellcheck="false"> <button type="button" id="msx-acc-keysave">Save</button> <button type="button" id="msx-acc-keydel">Remove</button> <span id="msx-acc-keystate"></span></div>';
    host.appendChild(box);
    box.querySelector('#msx-acc-keysave').addEventListener('click', () => {
      const v = box.querySelector('#msx-acc-key').value.trim();
      if (!/^ms_[\w-]{20,}$/.test(v)) { apiKeyState = { ok: false, text: 'That doesn\'t look like a key (they start with ms_).' }; updateAccountPanel(); return; }
      GM_setValue(API_KEY_KEY, v);
      box.querySelector('#msx-acc-key').value = '';
      catApiWaitUntil = 0; catApi.clear();
      apiKeyState = { ok: true, text: 'Checking…' };
      updateAccountPanel();
      apiGet('key', (j, status) => {
        const d = j && j.ok && j.data;
        apiKeyState = d
          ? { ok: true, text: `✅ Works: "${d.label}", ${d.level} level, ${d.owner && d.owner.name}'s key.${d.level !== 'public' ? ' (A Public key is all this script needs.)' : ''}` }
          : { ok: false, text: `The game refused it (${(j && j.error && j.error.code) || status || 'no answer'}).` };
        updateAccountPanel();
      });
    });
    box.querySelector('#msx-acc-keydel').addEventListener('click', () => {
      GM_setValue(API_KEY_KEY, '');
      catApi.clear(); catApiQueue.length = 0;
      apiKeyState = { ok: true, text: 'Removed. Revoke it in the game too.' };
      updateAccountPanel();
    });

    box.querySelector('#msx-acc-events').addEventListener('change', (e) => { settings.events = e.target.checked; saveSettings(); });
    box.querySelector('#msx-acc-share').addEventListener('change', (e) => setSharing(e.target.checked));
    box.querySelector('#msx-acc-stats').addEventListener('change', (e) => { settings.shareStats = e.target.checked; saveSettings(); noteSelfGear(); syncGear(); updateStatsNudge(); });
    box.querySelector('#msx-acc-statsnudge').addEventListener('change', (e) => { settings.statsNudgeOff = !e.target.checked; saveSettings(); updateStatsNudge(); });
    box.querySelector('#msx-acc-outbtn').addEventListener('click', () => { setSharing(!!settings.shareOff); updateAccountPanel(); });
    updateAccountPanel();
  }

  function updateAccountPanel() {
    const box = document.getElementById('msx-account');
    if (!box) return;
    const ev = box.querySelector('#msx-acc-events');
    const sh = box.querySelector('#msx-acc-share');
    const shBox = box.querySelector('#msx-acc-sharebox');
    if (shBox.hidden === inShareCrew()) shBox.hidden = !inShareCrew(); // the alliance: the switch and what it sends
    const allyNote = box.querySelector('#msx-acc-allynote');
    if (allyNote.hidden === !inOwnCrew()) allyNote.hidden = inOwnCrew(); // allies: what they share instead
    // Outside the alliance (0.49.2, user request): only a button to turn it off (or back on).
    const outBox = box.querySelector('#msx-acc-outbox');
    const outside = !!(apiState && apiState.myId) && !inShareCrew();
    if (outBox.hidden === outside) outBox.hidden = !outside;
    const outLabel = settings.shareOff ? 'Turn sharing data on' : 'Turn sharing data off';
    const outBtn = box.querySelector('#msx-acc-outbtn');
    if (outBtn.textContent !== outLabel) outBtn.textContent = outLabel;
    const what = box.querySelector('#msx-acc-sharewhat');
    if (what.hidden === inOwnCrew()) what.hidden = !inOwnCrew(); // the full list is crew 2's
    if (sh.checked !== !settings.shareOff) sh.checked = !settings.shareOff;
    if (ev.checked !== settings.events) ev.checked = settings.events;
    // Battle stats: the alliance crews only (user request); opened from the sidebar reminder, scrolled into view.
    const stBox = box.querySelector('#msx-acc-statsbox');
    if (stBox.hidden === inShareCrew()) {
      stBox.hidden = !inShareCrew();
      if (!stBox.hidden && location.hash === '#msx-stats' && stBox.scrollIntoView) stBox.scrollIntoView({ block: 'center' });
    }
    const stn = box.querySelector('#msx-acc-statsnudge');
    if (stn.checked !== !settings.statsNudgeOff) stn.checked = !settings.statsNudgeOff;
    if (stn.disabled !== !!(settings.shareOff || settings.shareStats)) stn.disabled = !!(settings.shareOff || settings.shareStats);
    const stx = box.querySelector('#msx-acc-stats');
    if (stx.checked !== !!settings.shareStats) stx.checked = !!settings.shareStats;
    if (stx.disabled !== !!settings.shareOff) stx.disabled = !!settings.shareOff;
    // The key itself is never shown again once saved.
    const ki = box.querySelector('#msx-acc-key');
    const ph = apiKey() ? 'Key saved (hidden). Paste a new one to replace it.' : 'ms_…';
    if (ki && ki.placeholder !== ph) ki.placeholder = ph;
    const ks = box.querySelector('#msx-acc-keystate');
    const kt = apiKeyState ? apiKeyState.text : '';
    if (ks && ks.textContent !== kt) { ks.textContent = kt; ks.className = apiKeyState && !apiKeyState.ok ? 'msx-bad' : ''; }
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
      drawGymProgress();
      sortCrewMembers();
      readTraining();
      // The rebuilt Crimes pages (0.33.0): overview table, per-nerve line and the locks on each job's page.
      const onCrimes = isCrimesPage() || !!crimePageId();
      drawCrimeTable();
      if (onCrimes) drawCrimeDock();
      syncRungs(); // mastery unlocks: at most every 30 minutes unless yours changed, sharing on only
      drawRungTips();
      markContractCrimes();
      drawContractBanner();
      if (isStockPage()) syncNextMove();
      ensureCatClock();
      ensureXpLine();
      ensureTicker();
      document.querySelector('.msx-legend')?.remove();
      syncChain();
      ensureChainPill();
      updateCrewJobPill();
      updateCrewBuffPill();
      updateContractsPill(); updateStatsNudge();
      updateChainPill();
      updateHeistPill();
      updateCompanionPill();
      updatePvpPill();
      updateConsumablesPill();
      updateBankPill();
      arrangeRail(); // all the timers into one box under the vitals (0.29.0)
      drawHiddenFeats();
      noteMyMugs();
      noteMyAttacks();
      ensureNoCrewPanel();
      markMuggableRows();
      drawProfileHalfXp();
      drawProfileGear();
      updateCafePill();
      updatePierPill();
      drawPierLog();
      drawContractPay();
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
        const own = (m) => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('.msx-ticker, .msx-legend, #msx-toast, #msx-sharepop, .msx-rungtip, #msx-invest, #msx-heists, #msx-crewjobs, #msx-trading, #msx-crimetable, #msx-gymlock, #msx-ct-banner, .msx-muggable, .msx-lowtag, .msx-halfxp, .msx-geartag, #msx-catgear, #msx-pierlog, .msx-kpay, .msx-xpline, .msx-ct-line, .msx-pernerve, .msx-chance, .msx-croplock, .msx-players, .msx-stock, .msx-ws, .msx-clock, .msx-clock-row, .msx-feat-how, .msx-rail');
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
    });
    GM_addValueChangeListener(CHAIN_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      try { chainState = JSON.parse(newValue); } catch (e) { /* ignore */ }
    });
    GM_addValueChangeListener(SETTINGS_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(newValue) }; } catch (e) { return; }
      updateAccountPanel();
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
