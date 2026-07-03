/* ============================================================================
   KRAKEN ADAPTIVE BOT — single-file, zero-dependency Node.js (>=20)
   ----------------------------------------------------------------------------
   HONESTY NOTES (read these):
   - No bot can be guaranteed profitable. This one manages risk and adapts,
     but it can and will lose money in bad regimes. Paper-trade it first.
   - "Whale sentiment" here = Kraken's own large-trade tape + order book
     imbalance. It is exchange-local flow, NOT on-chain whale tracking.
   - Ships in PAPER mode (LIVE=false). Paper fills use last price with
     slippage + taker-fee estimates so results aren't flattered.
   - Spot, long-only. No margin, no shorting, no withdrawals — ever.

   ENV VARS (set in Railway → Variables):
     KRAKEN_API_KEY      required for LIVE only
     KRAKEN_API_SECRET   required for LIVE only
     LIVE                "true" to trade real money (default false = paper)
     HALT                "true" = manage exits only, no new entries
     PAIRS               default "XBTUSD,ETHUSD"
     PAPER_EQUITY        paper starting cash, default 1000
     RISK_PER_TRADE      default 0.01  (1% of equity risked per trade)
     DAILY_MAX_LOSS      default 0.03  (halt entries after -3% day)
     MAX_POSITIONS       default 2
     WHALE_USD           default 50000 (min USD size to count as whale print)
     FEE_PCT             default 0.004 (0.40% taker estimate per side)
     PORT                set automatically by Railway
   ============================================================================ */

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

const API = 'https://api.kraken.com';
const STATE_FILE = './state.json';

const CFG = {
  key: process.env.KRAKEN_API_KEY || '',
  secret: process.env.KRAKEN_API_SECRET || '',
  live: process.env.LIVE === 'true',
  haltEnv: process.env.HALT === 'true',
  pairs: (process.env.PAIRS || 'XBTUSD,ETHUSD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  paperEquity: num(process.env.PAPER_EQUITY, 1000),
  riskPerTrade: num(process.env.RISK_PER_TRADE, 0.01),
  dailyMaxLoss: num(process.env.DAILY_MAX_LOSS, 0.03),
  maxPositions: int(process.env.MAX_POSITIONS, 2),
  whaleUsd: num(process.env.WHALE_USD, 50000),
  feePct: num(process.env.FEE_PCT, 0.004),
  slipPct: 0.0005,
  candleInterval: 5,          // minutes
  loopMs: 20000,              // main loop cadence
  whaleWindowMs: 30 * 60_000, // whale flow lookback
  cooldownMs: 15 * 60_000,    // per-pair cooldown after closing a trade
  port: int(process.env.PORT, 3000),
};

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function utcDay() { return new Date().toISOString().slice(0, 10); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------ logging ---------------------------------- */
const LOGS = [];
function log(msg, level = 'info') {
  const line = `[${nowIso()}] ${msg}`;
  console.log(line);
  LOGS.push({ t: Date.now(), level, msg });
  if (LOGS.length > 200) LOGS.splice(0, LOGS.length - 200);
}

/* ------------------------------ state ------------------------------------ */
let state = {
  positions: {},        // pair -> {vol, entry, stop, high, mode, openedAt, riskUsd, adopted}
  closedTrades: [],     // trade records, newest last
  adapt: { riskScale: 1, flowMin: 0.05, rsiOB: 68, rsiOS: 32, stopMult: 2.0, trailMult: 2.5 },
  paper: { cash: CFG.paperEquity },
  tradesSince: {},      // pair -> kraken 'since' cursor
  day: { date: utcDay(), startEquity: null, halted: false },
  lastCloseAt: {},      // pair -> ts (cooldown)
};

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { log('state save failed: ' + e.message, 'warn'); }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...s, adapt: { ...state.adapt, ...(s.adapt || {}) } };
      log('state restored from disk (' + Object.keys(state.positions).length + ' open positions, ' + state.closedTrades.length + ' closed trades)');
    }
  } catch (e) { log('state load failed, starting fresh: ' + e.message, 'warn'); }
}

/* --------------------------- kraken REST --------------------------------- */
let lastNonce = 0;
function nextNonce() {
  lastNonce = Math.max(Date.now() * 1000, lastNonce + 1);
  return String(lastNonce);
}

async function httpJson(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    return await res.json();
  } finally { clearTimeout(t); }
}

async function pub(method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const j = await httpJson(`${API}/0/public/${method}${qs ? '?' + qs : ''}`);
  if (j.error && j.error.length) throw new Error('kraken ' + method + ': ' + j.error.join(','));
  return j.result;
}

async function priv(method, params = {}) {
  if (!CFG.key || !CFG.secret) throw new Error('no API credentials set');
  const path = `/0/private/${method}`;
  const nonce = nextNonce();
  const post = new URLSearchParams({ nonce, ...params }).toString();
  const sha = crypto.createHash('sha256').update(nonce + post).digest();
  const mac = crypto.createHmac('sha512', Buffer.from(CFG.secret, 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'utf8'), sha])).digest('base64');
  const j = await httpJson(API + path, {
    method: 'POST',
    headers: { 'API-Key': CFG.key, 'API-Sign': mac, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: post,
  });
  if (j.error && j.error.length) throw new Error('kraken ' + method + ': ' + j.error.join(','));
  return j.result;
}

/* --------------------------- indicators ---------------------------------- */
function emaSeries(vals, p) {
  const k = 2 / (p + 1); const out = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsiSeries(closes, p = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; out[i] = 100 - 100 / (1 + (l === 0 ? 1e9 : g / l)); } }
    else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; out[i] = 100 - 100 / (1 + (l === 0 ? 1e9 : g / l)); }
  }
  return out;
}
function atrSeries(c, p = 14) {
  const out = new Array(c.length).fill(null);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i <= p) { a += tr; if (i === p) out[i] = a / p; }
    else { a = out[i - 1] !== null ? (out[i - 1] * (p - 1) + tr) / p : tr; out[i] = a; }
  }
  return out;
}
function macdLast(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const sig = emaSeries(line, 9);
  const n = closes.length - 1;
  return { hist: line[n] - sig[n], histPrev: line[n - 1] - sig[n - 1] };
}
function bollingerLast(closes, p = 20, m = 2) {
  const n = closes.length;
  const win = closes.slice(n - p);
  const mid = win.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
  return { mid, upper: mid + m * sd, lower: mid - m * sd };
}

/* --------------------------- market data --------------------------------- */
const MKT = {};   // pair -> live market snapshot
const META = {};  // pair -> {restName, base, lotDec, ordermin}

async function loadPairMeta() {
  const r = await pub('AssetPairs');
  for (const p of CFG.pairs) {
    const alt = p.replace(/^BTC/, 'XBT');
    const entry = Object.entries(r).find(([, v]) => v.altname === p || v.altname === alt || v.wsname === p.slice(0, -3) + '/' + p.slice(-3));
    if (!entry) throw new Error(`pair ${p} not found on Kraken — check PAIRS env var`);
    const [restKey, v] = entry;
    META[p] = { restKey, restName: v.altname, base: v.base, lotDec: v.lot_decimals, ordermin: parseFloat(v.ordermin || '0') };
    MKT[p] = { candles: [], whale: [], price: null, flow: null, ind: null, regime: null, err: null };
    log(`pair ready: ${p} (base ${v.base}, min order ${v.ordermin} ${v.base})`);
  }
}

async function refreshCandles(pair) {
  const r = await pub('OHLC', { pair: META[pair].restName, interval: CFG.candleInterval });
  const key = Object.keys(r).find(k => k !== 'last');
  MKT[pair].candles = r[key].map(c => ({ t: c[0] * 1000, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[6] })).slice(-400);
  MKT[pair].price = MKT[pair].candles.at(-1).c;
}

async function refreshWhaleTape(pair) {
  const params = { pair: META[pair].restName };
  if (state.tradesSince[pair]) params.since = state.tradesSince[pair];
  const r = await pub('Trades', params);
  const key = Object.keys(r).find(k => k !== 'last');
  state.tradesSince[pair] = r.last;
  const cutoff = Date.now() - CFG.whaleWindowMs;
  for (const t of (r[key] || [])) {
    const usd = +t[0] * +t[1];
    if (usd >= CFG.whaleUsd) MKT[pair].whale.push({ t: +t[2] * 1000, usd, side: t[3], price: +t[0] });
  }
  MKT[pair].whale = MKT[pair].whale.filter(w => w.t >= cutoff).slice(-100);
}

async function refreshBook(pair) {
  const r = await pub('Depth', { pair: META[pair].restName, count: 50 });
  const key = Object.keys(r)[0];
  const { bids, asks } = r[key];
  const mid = (+bids[0][0] + +asks[0][0]) / 2;
  const within = 0.01;
  const bidVol = bids.filter(b => +b[0] >= mid * (1 - within)).reduce((a, b) => a + (+b[0] * +b[1]), 0);
  const askVol = asks.filter(a2 => +a2[0] <= mid * (1 + within)).reduce((a, b) => a + (+b[0] * +b[1]), 0);
  const imb = (bidVol + askVol) > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0;

  const wBuy = MKT[pair].whale.filter(w => w.side === 'b').reduce((a, w) => a + w.usd, 0);
  const wSell = MKT[pair].whale.filter(w => w.side === 's').reduce((a, w) => a + w.usd, 0);
  const gross = wBuy + wSell;
  const whaleBias = gross > 0 ? (wBuy - wSell) / gross : 0;

  MKT[pair].flow = {
    score: clamp(0.6 * whaleBias + 0.4 * imb, -1, 1),
    whaleBias, bookImb: imb,
    whaleBuyUsd: wBuy, whaleSellUsd: wSell, whalePrints: MKT[pair].whale.length,
  };
}

function computeAnalytics(pair) {
  const m = MKT[pair];
  if (m.candles.length < 60) { m.ind = null; m.regime = 'warming-up'; return; }
  const closes = m.candles.map(c => c.c);
  const price = closes.at(-1);
  const e20 = emaSeries(closes, 20).at(-1);
  const e50 = emaSeries(closes, 50).at(-1);
  const rsiArr = rsiSeries(closes);
  const atrArr = atrSeries(m.candles);
  const atr = atrArr.at(-1);
  const atrHist = atrArr.filter(a => a !== null).slice(-100).map(a => a / price);
  const atrPct = atr / price;
  const rank = atrHist.filter(a => a <= atrPct).length / Math.max(atrHist.length, 1);
  const { hist, histPrev } = macdLast(closes);
  const bb = bollingerLast(closes);

  m.ind = { price, e20, e50, rsi: rsiArr.at(-1), atr, atrPctile: rank, macdHist: hist, macdHistPrev: histPrev, bb };

  const spread = (e20 - e50) / price;
  if (rank > 0.9) m.regime = 'storm';
  else if (spread > 0.0015) m.regime = 'uptrend';
  else if (spread < -0.0015) m.regime = 'downtrend';
  else m.regime = 'range';
}

/* ------------------------- equity & balances ----------------------------- */
let liveBalances = {};
async function refreshLiveBalances() { liveBalances = await priv('Balance'); }
function baseBalance(pair) {
  const b = META[pair].base;
  return parseFloat(liveBalances[b] ?? liveBalances[b.replace(/^[XZ]/, '')] ?? '0');
}
function quoteCash() {
  return parseFloat(liveBalances['ZUSD'] ?? liveBalances['USD'] ?? '0');
}
function equity() {
  if (CFG.live) {
    let eq = quoteCash();
    for (const p of CFG.pairs) if (MKT[p].price) eq += baseBalance(p) * MKT[p].price;
    return eq;
  }
  let eq = state.paper.cash;
  for (const [p, pos] of Object.entries(state.positions)) if (MKT[p]?.price) eq += pos.vol * MKT[p].price;
  return eq;
}

/* --------------------------- adaptive engine ----------------------------- */
function updateAdaptive() {
  const recent = state.closedTrades.slice(-8);
  if (recent.length < 5) return;
  const wins = recent.filter(t => t.pnlUsd > 0);
  const grossW = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const grossL = Math.abs(recent.filter(t => t.pnlUsd <= 0).reduce((a, t) => a + t.pnlUsd, 0));
  const pf = grossL === 0 ? (grossW > 0 ? 99 : 1) : grossW / grossL;
  const a = state.adapt;
  if (pf < 1) {
    a.riskScale = clamp(a.riskScale * 0.7, 0.25, 1.25);
    a.flowMin = clamp(a.flowMin + 0.05, 0, 0.3);
    a.rsiOS = clamp(a.rsiOS - 2, 22, 38);
    a.rsiOB = clamp(a.rsiOB - 2, 60, 78);
    a.stopMult = clamp(a.stopMult + 0.2, 1.2, 3.5);
    log(`ADAPT ▼ profit factor ${pf.toFixed(2)} over last ${recent.length} → risk ${(a.riskScale * 100).toFixed(0)}%, flowMin ${a.flowMin.toFixed(2)}, stops wider`);
  } else if (pf > 1.3) {
    a.riskScale = clamp(a.riskScale * 1.15, 0.25, 1.25);
    a.flowMin = clamp(a.flowMin - 0.02, 0, 0.3);
    a.stopMult = clamp(a.stopMult - 0.1, 1.2, 3.5);
    log(`ADAPT ▲ profit factor ${pf.toFixed(2)} → risk ${(a.riskScale * 100).toFixed(0)}%`);
  }
  saveState();
}

function perfStats() {
  const t = state.closedTrades.slice(-20);
  if (!t.length) return { trades: state.closedTrades.length, winRate: null, pf: null, netUsd: state.closedTrades.reduce((a, x) => a + x.pnlUsd, 0) };
  const w = t.filter(x => x.pnlUsd > 0);
  const gw = w.reduce((a, x) => a + x.pnlUsd, 0);
  const gl = Math.abs(t.filter(x => x.pnlUsd <= 0).reduce((a, x) => a + x.pnlUsd, 0));
  return {
    trades: state.closedTrades.length,
    winRate: w.length / t.length,
    pf: gl === 0 ? null : gw / gl,
    netUsd: state.closedTrades.reduce((a, x) => a + x.pnlUsd, 0),
  };
}

/* ------------------------------ execution -------------------------------- */
async function marketOrder(pair, side, vol) {
  const meta = META[pair];
  const volStr = vol.toFixed(meta.lotDec);
  if (!CFG.live) {
    const raw = MKT[pair].price;
    const px = side === 'buy' ? raw * (1 + CFG.slipPct) : raw * (1 - CFG.slipPct);
    const fee = px * vol * CFG.feePct;
    if (side === 'buy') state.paper.cash -= px * vol + fee;
    else state.paper.cash += px * vol - fee;
    log(`PAPER ${side.toUpperCase()} ${volStr} ${pair} @ ~${px.toFixed(2)} (fee est $${fee.toFixed(2)})`);
    return { px, fee };
  }
  const r = await priv('AddOrder', { pair: meta.restName, type: side, ordertype: 'market', volume: volStr });
  const px = MKT[pair].price;
  const fee = px * vol * CFG.feePct;
  log(`LIVE ${side.toUpperCase()} ${volStr} ${pair} → txid ${(r.txid || []).join(',')} (fill est @ ${px.toFixed(2)})`);
  return { px, fee };
}

function entriesHalted() {
  return CFG.haltEnv || state.day.halted;
}

async function openLong(pair, mode, reason) {
  const m = MKT[pair], a = state.adapt, meta = META[pair];
  const eq = equity();
  const regimeMult = m.regime === 'range' ? 0.9 : 1;
  const stopDist = a.stopMult * regimeMult * m.ind.atr;
  const riskUsd = eq * CFG.riskPerTrade * a.riskScale;
  let vol = riskUsd / stopDist;
  const cash = CFG.live ? quoteCash() : state.paper.cash;
  vol = Math.min(vol, (cash * 0.95) / m.price);
  vol = parseFloat(vol.toFixed(meta.lotDec));
  if (vol < meta.ordermin || vol <= 0) { log(`${pair}: signal but size ${vol} below Kraken min ${meta.ordermin} — skipped`, 'warn'); return; }

  const { px, fee } = await marketOrder(pair, 'buy', vol);
  state.positions[pair] = {
    vol, entry: px, stop: px - stopDist, high: px, mode,
    openedAt: Date.now(), riskUsd, entryFee: fee, adopted: false,
  };
  log(`OPEN ${pair} [${mode}] ${reason} | entry ${px.toFixed(2)} stop ${(px - stopDist).toFixed(2)} risk $${riskUsd.toFixed(2)}`);
  saveState();
}

async function closeLong(pair, reason) {
  const pos = state.positions[pair];
  if (!pos) return;
  const { px, fee } = await marketOrder(pair, 'sell', pos.vol);
  const pnlUsd = (px - pos.entry) * pos.vol - fee - (pos.entryFee || 0);
  const rec = {
    pair, mode: pos.mode, vol: pos.vol, entry: pos.entry, exit: px,
    pnlUsd, pnlPct: (px - pos.entry) / pos.entry, reason,
    openedAt: pos.openedAt, closedAt: Date.now(), adopted: !!pos.adopted,
  };
  state.closedTrades.push(rec);
  if (state.closedTrades.length > 500) state.closedTrades.splice(0, state.closedTrades.length - 500);
  delete state.positions[pair];
  state.lastCloseAt[pair] = Date.now();
  log(`CLOSE ${pair} ${reason} | pnl $${pnlUsd.toFixed(2)} (${(rec.pnlPct * 100).toFixed(2)}%)`);
  updateAdaptive();
  saveState();
}

/* --------------------------- strategy core ------------------------------- */
async function managePosition(pair) {
  const pos = state.positions[pair];
  const m = MKT[pair];
  if (!pos || !m.ind) return;
  const { price, atr, e20, e50, bb, rsi } = m.ind;
  const a = state.adapt;

  pos.high = Math.max(pos.high, price);
  const oneR = pos.entry + (pos.entry - pos.stop);
  if (price >= oneR) {
    const trail = pos.high - a.trailMult * (m.regime === 'storm' ? 0.7 : 1) * atr;
    const breakeven = pos.entry * (1 + 2 * CFG.feePct);
    pos.stop = Math.max(pos.stop, trail, breakeven);
  }

  if (price <= pos.stop) return closeLong(pair, 'stop/trail hit');
  if (pos.mode === 'trend' && e20 < e50) return closeLong(pair, 'trend flipped (EMA cross down)');
  if (pos.mode === 'range' && (price >= bb.mid || rsi >= 58)) return closeLong(pair, 'mean-reversion target');
  if (m.flow && m.flow.score < -0.45 && price > pos.entry) return closeLong(pair, 'heavy sell flow — banking profit');
  saveState();
}

async function maybeEnter(pair) {
  const m = MKT[pair];
  if (!m.ind || state.positions[pair]) return;
  if (entriesHalted()) return;
  if (Object.keys(state.positions).length >= CFG.maxPositions) return;
  if (Date.now() - (state.lastCloseAt[pair] || 0) < CFG.cooldownMs) return;
  if (m.regime === 'storm' || m.regime === 'downtrend' || m.regime === 'warming-up') return;

  const a = state.adapt;
  const { rsi, e20, e50, macdHist, macdHistPrev, bb, price } = m.ind;
  const flow = m.flow ? m.flow.score : 0;

  if (m.regime === 'uptrend'
    && e20 > e50 && macdHist > 0 && macdHist > macdHistPrev
    && rsi < a.rsiOB && flow > a.flowMin) {
    return openLong(pair, 'trend', `EMA↑ MACD↑ RSI ${rsi.toFixed(0)} flow ${flow.toFixed(2)}`);
  }
  if (m.regime === 'range'
    && rsi < a.rsiOS && price < bb.lower && flow > -0.1) {
    return openLong(pair, 'range', `RSI ${rsi.toFixed(0)} < ${a.rsiOS} at lower band, flow ${flow.toFixed(2)}`);
  }
}

/* ------------------------- daily circuit breaker ------------------------- */
function checkDay() {
  const eq = equity();
  if (state.day.date !== utcDay()) {
    state.day = { date: utcDay(), startEquity: eq, halted: false };
    log(`new UTC day — baseline equity $${eq.toFixed(2)}`);
  }
  if (state.day.startEquity === null) state.day.startEquity = eq;
  if (!state.day.halted && eq < state.day.startEquity * (1 - CFG.dailyMaxLoss)) {
    state.day.halted = true;
    log(`⛔ DAILY CIRCUIT BREAKER: equity down ${(CFG.dailyMaxLoss * 100).toFixed(1)}%+ today. New entries halted until next UTC day. Exits still managed.`, 'warn');
  }
  saveState();
}

/* --------------------------- live reconcile ------------------------------ */
async function reconcileLive() {
  await refreshLiveBalances();
  for (const p of CFG.pairs) {
    const bal = baseBalance(p);
    const meta = META[p];
    if (bal >= meta.ordermin && !state.positions[p]) {
      const px = MKT[p].price;
      const atr = MKT[p].ind ? MKT[p].ind.atr : px * 0.01;
      state.positions[p] = {
        vol: parseFloat(bal.toFixed(meta.lotDec)), entry: px, stop: px - state.adapt.stopMult * atr,
        high: px, mode: 'trend', openedAt: Date.now(), riskUsd: 0, entryFee: 0, adopted: true,
      };
      log(`ADOPTED existing ${p} balance (${bal} ${meta.base}) as a managed position — real entry price unknown, PnL for this one is from adoption point only`, 'warn');
    }
    if (state.positions[p] && bal < meta.ordermin && !state.positions[p].justOpened) {
      log(`${p}: tracked position but balance is gone (sold outside the bot?) — dropping it`, 'warn');
      delete state.positions[p];
    }
  }
  saveState();
}

/* ------------------------------ main loop -------------------------------- */
let loopCount = 0;
let lastLoopErr = null;

async function loop() {
  loopCount++;
  try {
    if (CFG.live) await refreshLiveBalances();
    for (const pair of CFG.pairs) {
      try {
        await refreshCandles(pair);
        await refreshWhaleTape(pair);
        await refreshBook(pair);
        computeAnalytics(pair);
        MKT[pair].err = null;
        await managePosition(pair);
        await maybeEnter(pair);
        await sleep(1200); // stay polite with Kraken rate limits
      } catch (e) {
        MKT[pair].err = e.message;
        log(`${pair} loop error: ${e.message}`, 'warn');
      }
    }
    checkDay();
    lastLoopErr = null;
  } catch (e) {
    lastLoopErr = e.message;
    log('loop error: ' + e.message, 'warn');
  }
}

/* ------------------------------ dashboard -------------------------------- */
function snapshot() {
  const eq = equity();
  const stats = perfStats();
  return {
    mode: CFG.live ? 'LIVE' : 'PAPER',
    halted: entriesHalted(),
    haltReason: CFG.haltEnv ? 'HALT env var' : (state.day.halted ? 'daily loss breaker' : null),
    equity: eq,
    dayStart: state.day.startEquity,
    dayPnl: state.day.startEquity != null ? eq - state.day.startEquity : null,
    cash: CFG.live ? quoteCash() : state.paper.cash,
    pairs: CFG.pairs.map(p => ({
      pair: p,
      price: MKT[p].price,
      regime: MKT[p].regime,
      err: MKT[p].err,
      ind: MKT[p].ind ? {
        rsi: MKT[p].ind.rsi, e20: MKT[p].ind.e20, e50: MKT[p].ind.e50,
        atrPct: MKT[p].ind.atr / MKT[p].ind.price, macdHist: MKT[p].ind.macdHist,
      } : null,
      flow: MKT[p].flow,
      whaleTape: MKT[p].whale.slice(-8).reverse(),
    })),
    positions: Object.entries(state.positions).map(([pair, pos]) => ({
      pair, ...pos,
      mark: MKT[pair].price,
      uPnl: MKT[pair].price ? (MKT[pair].price - pos.entry) * pos.vol : null,
    })),
    closed: state.closedTrades.slice(-15).reverse(),
    stats,
    adapt: state.adapt,
    cfg: { pairs: CFG.pairs, riskPerTrade: CFG.riskPerTrade, dailyMaxLoss: CFG.dailyMaxLoss, whaleUsd: CFG.whaleUsd, maxPositions: CFG.maxPositions, feePct: CFG.feePct },
    logs: LOGS.slice(-40).reverse(),
    loopCount, lastLoopErr,
    ts: Date.now(),
  };
}

const DASH_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>KRAKEN ADAPTIVE BOT</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0b0d;--panel:#101216;--line:#1e2229;--fg:#d6dae1;--dim:#6b7280;--grn:#2fd66f;--red:#ff4d5e;--amb:#f5b83d;--acc:#7aa7ff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 'IBM Plex Mono',monospace;padding:14px;padding-bottom:40px}
h1{font-size:13px;font-weight:600;letter-spacing:.14em;color:var(--dim)}
.top{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:14px}
.badge{font-size:11px;font-weight:600;letter-spacing:.1em;padding:3px 10px;border:1px solid}
.badge.paper{color:var(--amb);border-color:var(--amb)}
.badge.live{color:var(--grn);border-color:var(--grn)}
.badge.halt{color:var(--red);border-color:var(--red)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);padding:14px}
.lbl{font-size:10px;letter-spacing:.14em;color:var(--dim);text-transform:uppercase;margin-bottom:6px}
.big{font-size:22px;font-weight:600}
.pos{color:var(--grn)}.neg{color:var(--red)}.dim{color:var(--dim)}
.row{display:flex;justify-content:space-between;gap:8px;padding:3px 0;font-size:13px}
.bar{height:6px;background:#15181d;position:relative;margin:8px 0}
.bar i{position:absolute;top:0;bottom:0;left:50%;background:var(--acc)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:var(--dim);font-weight:500;text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);font-size:10px;letter-spacing:.1em;text-transform:uppercase}
td{padding:5px 6px;border-bottom:1px solid var(--line)}
.logs{font-size:11px;color:var(--dim);max-height:260px;overflow:auto;white-space:pre-wrap}
.section{margin-top:14px}
.whale{font-size:11px;display:flex;justify-content:space-between;padding:2px 0}
@media(max-width:640px){body{padding:10px}.big{font-size:19px}}
</style></head><body>
<div class="top">
  <h1>KRAKEN ADAPTIVE BOT</h1>
  <div id="badges"></div>
</div>
<div class="grid" id="summary"></div>
<div class="grid section" id="pairs"></div>
<div class="card section"><div class="lbl">Open positions</div><div id="positions"></div></div>
<div class="card section"><div class="lbl">Closed trades (last 15) · real fills only, fees estimated</div><div id="closed"></div></div>
<div class="grid section">
  <div class="card"><div class="lbl">Adaptive engine</div><div id="adapt"></div></div>
  <div class="card"><div class="lbl">Config</div><div id="cfg"></div></div>
</div>
<div class="card section"><div class="lbl">Log</div><div class="logs" id="logs"></div></div>
<script>
function f(n,d){return (n==null||isNaN(n))?'–':Number(n).toFixed(d==null?2:d)}
function usd(n){return (n==null||isNaN(n))?'–':(n<0?'-$':'$')+Math.abs(n).toFixed(2)}
function cls(n){return n==null?'dim':(n>=0?'pos':'neg')}
function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
async function tick(){
 try{
  var r=await fetch('/api/status');var s=await r.json();
  var b='<span class="badge '+(s.mode==='LIVE'?'live':'paper')+'">'+s.mode+'</span>';
  if(s.halted)b+=' <span class="badge halt">ENTRIES HALTED'+(s.haltReason?' · '+esc(s.haltReason):'')+'</span>';
  document.getElementById('badges').innerHTML=b;
  var sm='';
  sm+='<div class="card"><div class="lbl">Equity ('+(s.mode==='PAPER'?'paper':'live')+')</div><div class="big">'+usd(s.equity)+'</div></div>';
  sm+='<div class="card"><div class="lbl">Day P&L</div><div class="big '+cls(s.dayPnl)+'">'+usd(s.dayPnl)+'</div></div>';
  sm+='<div class="card"><div class="lbl">Cash</div><div class="big">'+usd(s.cash)+'</div></div>';
  var st=s.stats;
  sm+='<div class="card"><div class="lbl">Last 20 trades</div><div class="row"><span>Win rate</span><span>'+(st.winRate==null?'–':f(st.winRate*100,0)+'%')+'</span></div><div class="row"><span>Profit factor</span><span>'+f(st.pf)+'</span></div><div class="row"><span>Total closed</span><span>'+st.trades+'</span></div><div class="row"><span>Net P&L all-time</span><span class="'+cls(st.netUsd)+'">'+usd(st.netUsd)+'</span></div></div>';
  document.getElementById('summary').innerHTML=sm;
  var ph='';
  s.pairs.forEach(function(p){
   var fl=p.flow, w=(fl&&fl.score!=null)?fl.score:null;
   ph+='<div class="card"><div class="row"><b>'+p.pair+'</b><span>'+f(p.price)+'</span></div>';
   ph+='<div class="row"><span class="dim">Regime</span><span>'+esc(p.regime||'–')+'</span></div>';
   if(p.ind){ph+='<div class="row"><span class="dim">RSI</span><span>'+f(p.ind.rsi,0)+'</span></div><div class="row"><span class="dim">MACD hist</span><span>'+f(p.ind.macdHist)+'</span></div>'}
   ph+='<div class="row"><span class="dim">Flow</span><span class="'+cls(w)+'">'+f(w)+'</span></div>';
   if(p.whaleTape.length)ph+='<div class="lbl" style="margin-top:8px">Whale tape (last 8)</div>'+p.whaleTape.map(x=>'<div class="whale"><span>'+x.side+'</span><span>$'+f(x.usd,0)+'</span><span class="dim">'+f(x.price)+'</span></div>').join('');
   if(p.err)ph+='<div style="color:var(--red);margin-top:6px;font-size:11px">⚠ '+esc(p.err)+'</div>';
   ph+='</div>';
  });
  document.getElementById('pairs').innerHTML=ph;
  var pos='';
  if(!s.positions.length)pos='<div class="dim">none</div>';
  else pos+='<table><tr><th>Pair</th><th>Entry</th><th>Mark</th><th>Vol</th><th>P&L</th></tr>'+s.positions.map(p=>'<tr><td>'+p.pair+'</td><td>'+f(p.entry)+'</td><td>'+f(p.mark)+'</td><td>'+f(p.vol,4)+'</td><td class="'+cls(p.uPnl)+'">'+usd(p.uPnl)+'</td></tr>').join('')+'</table>';
  document.getElementById('positions').innerHTML=pos;
  var cls_tbl='';
  if(!s.closed.length)cls_tbl='<div class="dim">none</div>';
  else cls_tbl+='<table><tr><th>Pair</th><th>Mode</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>'+s.closed.map(t=>'<tr><td>'+t.pair+'</td><td>'+t.mode+'</td><td>'+f(t.entry)+'</td><td>'+f(t.exit)+'</td><td class="'+cls(t.pnlUsd)+'">'+usd(t.pnlUsd)+'</td><td>'+esc(t.reason)+'</td></tr>').join('')+'</table>';
  document.getElementById('closed').innerHTML=cls_tbl;
  var adp='';
  adp+='<div class="row"><span>Risk scale</span><span>'+f(s.adapt.riskScale*100,0)+'%</span></div>';
  adp+='<div class="row"><span>RSI O/S</span><span>'+f(s.adapt.rsiOS,0)+'</span></div>';
  adp+='<div class="row"><span>RSI O/B</span><span>'+f(s.adapt.rsiOB,0)+'</span></div>';
  adp+='<div class="row"><span>Flow min</span><span>'+f(s.adapt.flowMin,2)+'</span></div>';
  adp+='<div class="row"><span>Stop mult</span><span>'+f(s.adapt.stopMult,1)+'</span></div>';
  adp+='<div class="row"><span>Trail mult</span><span>'+f(s.adapt.trailMult,2)+'</span></div>';
  document.getElementById('adapt').innerHTML=adp;
  var cfg='';
  cfg+='<div class="row"><span>Pairs</span><span>'+esc(s.cfg.pairs.join(', '))+'</span></div>';
  cfg+='<div class="row"><span>Risk/trade</span><span>'+f(s.cfg.riskPerTrade*100,1)+'%</span></div>';
  cfg+='<div class="row"><span>Max loss/day</span><span>'+f(s.cfg.dailyMaxLoss*100,1)+'%</span></div>';
  cfg+='<div class="row"><span>Max positions</span><span>'+s.cfg.maxPositions+'</span></div>';
  cfg+='<div class="row"><span>Whale $</span><span>'+usd(s.cfg.whaleUsd)+'</span></div>';
  cfg+='<div class="row"><span>Taker fee</span><span>'+f(s.cfg.feePct*100,2)+'%</span></div>';
  document.getElementById('cfg').innerHTML=cfg;
  var lg='';
  s.logs.forEach(function(l){lg+='['+new Date(l.t).toISOString().replace('T',' ').slice(0,19)+'] '+esc(l.msg)+'\n'});
  document.getElementById('logs').innerHTML=lg;
 }
 catch(e){console.error(e);document.body.innerHTML='<div style="color:red;padding:20px">Dashboard error: '+esc(e.message)+'</div>'}
}
tick();setInterval(tick,3000);
</script>
</body></html>`;

let server;

async function start() {
  await loadPairMeta();
  loadState();
  if (CFG.live) await reconcileLive();

  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASH_HTML);
      return;
    }

    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot()));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(CFG.port, '0.0.0.0', () => {
    log(`dashboard listening on :${CFG.port}`);
  });

  log('starting trading loop…');
  setInterval(loop, CFG.loopMs);
  await loop();
}

start().catch(e => {
  log('fatal: ' + e.message, 'error');
  process.exit(1);
});
