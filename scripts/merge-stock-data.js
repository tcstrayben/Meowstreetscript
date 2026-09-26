'use strict';
// Merges a stock-price submission (a GitHub issue) into data/stocks.json.
//
// Submissions are untrusted text from anyone, so nothing here trusts the input:
//  - only known stock ids are accepted (the ids already in data/stocks.json)
//  - periods must be whole numbers inside a recent window, prices whole numbers in a sane range
//  - a price that jumps far from its neighbours or from the stock's usual level is thrown out
//  - each contributor gets one vote per price period, and the most-voted price wins
// The issue text is only ever parsed as JSON. It is never run, never put in a shell command.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PERIOD_MS = 15 * 60 * 1000;
const LIMITS = {
  maxBodyChars: 70000,
  maxPeriodsPerStock: 1500, // about 15 days of 15-minute prices
  maxAgeDays: 30, // older periods are not accepted
  maxFutureUnits: 2, // periods more than 30 minutes ahead are not accepted
  maxPrice: 1000000,
  maxStep: 0.25, // a price may differ from a neighbouring period by at most 25%
  maxFromMedian: 0.5, // with no stored price nearby, it may differ from the stock's recent level by at most 50%
  minPointsForMedian: 20,
  nearbyUnits: 96, // look up to 24 hours either side for a stored price to compare with
};

const hashVoter = (login) => crypto.createHash('sha256').update(String(login).toLowerCase()).digest('hex').slice(0, 10);
const isPlainInt = (n) => typeof n === 'number' && Number.isInteger(n);

// The JSON block from an issue body: prefers a ```json fence, otherwise the first { ... last }.
function extractPayload(body) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('The issue is empty.');
  if (body.length > LIMITS.maxBodyChars) throw new Error('The issue is too large.');
  let text = null;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) text = fence[1].trim();
  if (!text) {
    const a = body.indexOf('{');
    const b = body.lastIndexOf('}');
    if (a !== -1 && b > a) text = body.slice(a, b + 1);
  }
  if (!text) throw new Error('No JSON data found. Paste the copied data between the two ``` lines.');
  try { return JSON.parse(text); } catch (e) { throw new Error('The data is not valid JSON (it may have been cut off when pasting).'); }
}

const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Returns { accepted: { id: { period: price } }, rejected: [ { stock, period?, reason } ] }
function validate(payload, store, nowMs) {
  const rejected = [];
  const accepted = {};
  const fail = (stock, reason, period) => rejected.push(period === undefined ? { stock, reason } : { stock, period, reason });
  if (!payload || typeof payload !== 'object' || payload.format !== 1) throw new Error('Unexpected data format (expected format 1).');
  if (!payload.stocks || typeof payload.stocks !== 'object' || Array.isArray(payload.stocks)) throw new Error('No stocks found in the data.');

  const nowUnit = Math.round(nowMs / PERIOD_MS);
  const oldest = nowUnit - LIMITS.maxAgeDays * 96;
  const newest = nowUnit + LIMITS.maxFutureUnits;
  const known = new Set(Object.keys(store.stocks));

  for (const [id, entry] of Object.entries(payload.stocks)) {
    if (!known.has(id)) { fail(id, 'unknown stock id'); continue; }
    if (!entry || typeof entry !== 'object' || !entry.prices || typeof entry.prices !== 'object' || Array.isArray(entry.prices)) { fail(id, 'no prices object'); continue; }
    const items = Object.entries(entry.prices);
    if (items.length > LIMITS.maxPeriodsPerStock) { fail(id, `too many periods (max ${LIMITS.maxPeriodsPerStock})`); continue; }

    // First pass: shape checks.
    const clean = new Map();
    for (const [key, price] of items) {
      if (!/^\d{1,9}$/.test(key)) { fail(id, 'bad period key', key); continue; }
      const period = Number(key);
      if (period < oldest || period > newest) { fail(id, 'period outside the accepted window', period); continue; }
      if (!isPlainInt(price) || price < 1 || price > LIMITS.maxPrice) { fail(id, 'price is not a sane whole number', period); continue; }
      clean.set(period, price);
    }

    // Second pass: is the price believable? Only prices already in the data file count as trusted references, so one
    // bad price in a submission can never get a good neighbour thrown out.
    const existing = store.stocks[id].prices;
    const recent = Object.keys(existing).map(Number).sort((x, y) => y - x).slice(0, 100).map((k) => existing[String(k)][0]);
    const usual = recent.length >= LIMITS.minPointsForMedian ? median(recent) : null;
    const nearestExisting = (period) => {
      for (let d = 1; d <= LIMITS.nearbyUnits; d++) {
        const before = existing[String(period - d)];
        if (before) return { price: before[0], d };
        const after = existing[String(period + d)];
        if (after) return { price: after[0], d };
      }
      return null;
    };
    const good = {};
    for (const [period, price] of clean) {
      let reason = null;
      const near = nearestExisting(period);
      if (near) {
        // The further away the nearest stored price is, the more the stock may have drifted.
        const tolerance = Math.min(0.75, LIMITS.maxStep + 0.02 * (near.d - 1));
        if (Math.abs(price / near.price - 1) > tolerance) reason = 'price is out of line with the stored prices around it';
      } else if (usual !== null && Math.abs(price / usual - 1) > LIMITS.maxFromMedian) {
        reason = 'price is far from the stock\'s recent level';
      }
      // A lone spike inside the submission: its two neighbours agree with each other but it does not.
      const left = clean.get(period - 1), right = clean.get(period + 1);
      if (!reason && left !== undefined && right !== undefined && Math.abs(left / right - 1) <= LIMITS.maxStep &&
          Math.abs(price / left - 1) > LIMITS.maxStep && Math.abs(price / right - 1) > LIMITS.maxStep) reason = 'lone spike between two agreeing prices';
      if (reason) fail(id, reason, period); else good[period] = price;
    }
    if (Object.keys(good).length) accepted[id] = good;
  }
  return { accepted, rejected };
}

// Adds one contributor's votes. A contributor counts once per period (across all stocks).
function merge(store, voters, accepted, voter, nowMs) {
  const stats = { newPeriods: 0, confirmed: 0, conflicts: 0, duplicates: 0 };
  const periods = new Set();
  for (const id of Object.keys(accepted)) for (const p of Object.keys(accepted[id])) periods.add(p);

  for (const p of periods) {
    const seen = Array.isArray(voters[p]) ? voters[p] : [];
    if (seen.includes(voter)) { stats.duplicates++; continue; }
    for (const id of Object.keys(accepted)) {
      if (!Object.prototype.hasOwnProperty.call(accepted[id], p)) continue;
      const price = accepted[id][p];
      const prices = store.stocks[id].prices;
      const cur = Object.prototype.hasOwnProperty.call(prices, p) ? prices[p] : null;
      if (!cur) { prices[p] = [price, 1]; stats.newPeriods++; continue; }
      if (cur[0] === price) { cur[1] += 1; stats.confirmed++; continue; }
      // A different price for a period we already have: keep a tally and let the majority win.
      stats.conflicts++;
      const alt = cur[2] && typeof cur[2] === 'object' ? cur[2] : (cur[2] = {});
      alt[price] = (alt[price] || 0) + 1;
      if (alt[price] > cur[1]) { // the newcomer now has more votes: swap
        const oldPrice = cur[0], oldVotes = cur[1];
        cur[0] = price; cur[1] = alt[price];
        delete alt[price];
        alt[oldPrice] = oldVotes;
      }
    }
    voters[p] = [...seen, voter];
  }

  // Votes older than the accepted window can never be needed again.
  const oldest = Math.round(nowMs / PERIOD_MS) - LIMITS.maxAgeDays * 96 - 4;
  for (const p of Object.keys(voters)) if (Number(p) < oldest) delete voters[p];
  store.updated = new Date(nowMs).toISOString();
  return stats;
}

function summarize(stats, rejected, error) {
  if (error) return `Thanks for trying, but nothing was added.\n\n**Why:** ${error}\n\nUse the "Contribute stock data" button in the script again and paste the copied data between the two \`\`\` lines.`;
  const lines = ['Thanks! Your stock prices were processed.', ''];
  lines.push(`- New price periods added: **${stats.newPeriods}**`);
  lines.push(`- Periods that matched what we already had (confirmed): **${stats.confirmed}**`);
  if (stats.conflicts) lines.push(`- Periods where your price differed from the stored one (the majority wins): **${stats.conflicts}**`);
  if (stats.duplicates) lines.push(`- Periods you had already contributed (not counted twice): **${stats.duplicates}**`);
  if (rejected.length) {
    const reasons = {};
    for (const r of rejected) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    lines.push(`- Rejected entries: **${rejected.length}**`, ...Object.entries(reasons).map(([r, n]) => `  - ${r}: ${n}`));
  }
  return lines.join('\n');
}

// Whole submission: returns { store, voters, message, changed }
function processSubmission({ body, login, nowMs, store, voters }) {
  let payload;
  try { payload = extractPayload(body); } catch (e) { return { store, voters, message: summarize(null, [], e.message), changed: false }; }
  let result;
  try { result = validate(payload, store, nowMs); } catch (e) { return { store, voters, message: summarize(null, [], e.message), changed: false }; }
  const stats = merge(store, voters, result.accepted, hashVoter(login), nowMs);
  const changed = stats.newPeriods + stats.confirmed + stats.conflicts > 0;
  return { store, voters, message: summarize(stats, result.rejected), changed };
}

// One price per line, so changes read clearly in GitHub's history.
function formatStore(store) {
  const lines = ['{', ` "format": ${store.format},`, ` "periodMinutes": ${store.periodMinutes},`, ` "updated": ${JSON.stringify(store.updated)},`, ' "stocks": {'];
  const ids = Object.keys(store.stocks);
  ids.forEach((id, i) => {
    const st = store.stocks[id];
    lines.push(`  ${JSON.stringify(id)}: {`, `   "name": ${JSON.stringify(st.name)},`, '   "prices": {');
    const keys = Object.keys(st.prices).sort((a, b) => Number(a) - Number(b));
    keys.forEach((k, j) => lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(st.prices[k])}${j < keys.length - 1 ? ',' : ''}`));
    lines.push('   }', `  }${i < ids.length - 1 ? ',' : ''}`);
  });
  lines.push(' }', '}', '');
  return lines.join('\n');
}

function main() {
  const root = path.resolve(__dirname, '..');
  const storeFile = path.join(root, 'data', 'stocks.json');
  const votersFile = path.join(root, 'data', 'voters.json');
  const args = process.argv.slice(2);
  let body, login, title;
  if (args[0] === '--file') { // local test run: node scripts/merge-stock-data.js --file body.txt someone
    body = fs.readFileSync(args[1], 'utf8'); login = args[2] || 'local'; title = '[stock-data] local';
  } else {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const issue = event.issue;
    if (!issue) throw new Error('This is not an issue event.');
    body = issue.body; login = issue.user && issue.user.login; title = issue.title;
    if (issue.user && issue.user.type === 'Bot') { console.log('Ignoring a bot.'); process.exit(0); }
  }
  if (!String(title).startsWith('[stock-data]')) { console.log('Not a stock-data submission.'); process.exit(0); }
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const voters = fs.existsSync(votersFile) ? JSON.parse(fs.readFileSync(votersFile, 'utf8')) : {};
  const out = processSubmission({ body, login, nowMs: Date.now(), store, voters });
  if (out.changed) {
    fs.writeFileSync(storeFile, JSON.stringify(out.store) + '\n');
    fs.writeFileSync(votersFile, JSON.stringify(out.voters) + '\n');
  }
  fs.writeFileSync(path.join(root, 'result.md'), out.message + '\n');
  console.log(out.message);
}

module.exports = { LIMITS, formatStore, hashVoter, extractPayload, validate, merge, summarize, processSubmission, PERIOD_MS };
if (require.main === module) main();
