/**
 * CMVNG SIGNALVAULT — PAYMENT API v2.1
 *
 * Multi-product: signals + sports.
 *
 * NEW in v2.1:
 *   - 3 Odds tier (20 USDC) added
 *   - Sports free tier: 1 code per DAY (was 1/week)
 */

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ─── Database Setup ──────────────────────────────────────────

const db = new Database(path.join(__dirname, "subscriptions.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    tier INTEGER DEFAULT 0,
    tier_name TEXT DEFAULT 'Free',
    wallet_address TEXT,
    expires_at TEXT,
    signals_today INTEGER DEFAULT 0,
    last_signal_date TEXT,
    total_paid_usdc REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sports_subscriptions (
    telegram_id TEXT PRIMARY KEY,
    tier INTEGER DEFAULT 0,
    tier_name TEXT DEFAULT 'Free',
    wallet_address TEXT,
    expires_at TEXT,
    codes_today INTEGER DEFAULT 0,
    last_code_date TEXT,
    total_paid_usdc REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migrate: if old weekly columns exist, ignore them. New schema uses daily.
try { db.exec(`ALTER TABLE sports_subscriptions ADD COLUMN codes_today INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE sports_subscriptions ADD COLUMN last_code_date TEXT`); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT,
    product TEXT DEFAULT 'signals',
    tier INTEGER,
    amount_usdc REAL,
    wallet_address TEXT,
    tx_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
try { db.exec(`ALTER TABLE payments ADD COLUMN product TEXT DEFAULT 'signals'`); } catch(e) {}

// ─── Tier Configs ────────────────────────────────────────────

const SIGNAL_TIERS = {
  0: { name: "Free",           price: 0,   daily_limit: 2    },
  1: { name: "Pro",            price: 15,  daily_limit: null },
  2: { name: "Elite",          price: 50,  daily_limit: null },
  3: { name: "Institutional",  price: 150, daily_limit: null },
};

const SPORTS_TIERS = {
  0: { name: "Free",        price: 0,   daily_limit: 1    },   // 1 code per day (rotating)
  1: { name: "2 Odds",      price: 15,  daily_limit: null },
  2: { name: "3 Odds",      price: 20,  daily_limit: null },
  3: { name: "5 Odds",      price: 30,  daily_limit: null },
  4: { name: "10 Odds",     price: 60,  daily_limit: null },
  5: { name: "100 Odds",    price: 100, daily_limit: null },
  6: { name: "Grand Audit", price: 150, daily_limit: null },
};

const CHECKOUT_URL = process.env.CHECKOUT_URL || "https://cmvng-checkout-3.vercel.app";

// ─── Helpers ─────────────────────────────────────────────────

function today() { return new Date().toISOString().split("T")[0]; }

function isExpired(row) {
  if (!row || !row.expires_at) return true;
  return new Date(row.expires_at) < new Date();
}

function getSignalUser(id) { return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(id); }
function getOrCreateSignalUser(id) {
  let u = getSignalUser(id);
  if (!u) { db.prepare("INSERT INTO users (telegram_id) VALUES (?)").run(id); u = getSignalUser(id); }
  return u;
}
function getSportsUser(id) { return db.prepare("SELECT * FROM sports_subscriptions WHERE telegram_id = ?").get(id); }
function getOrCreateSportsUser(id) {
  let u = getSportsUser(id);
  if (!u) { db.prepare("INSERT INTO sports_subscriptions (telegram_id) VALUES (?)").run(id); u = getSportsUser(id); }
  return u;
}

// ═════════════════════════════════════════════════════════════
// SIGNALS ENDPOINTS
// ═════════════════════════════════════════════════════════════

app.get("/can-send", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.json({ allowed: false, reason: "missing_user_id" });

  const user = getOrCreateSignalUser(userId);
  const tier = isExpired(user) && user.tier > 0 ? 0 : user.tier;
  const config = SIGNAL_TIERS[tier];

  if (tier >= 1) {
    return res.json({ allowed: true, tier, tier_name: config.name });
  }

  const todayDate = today();
  let signalsToday = user.signals_today || 0;
  if (user.last_signal_date !== todayDate) {
    signalsToday = 0;
    db.prepare("UPDATE users SET signals_today = 0, last_signal_date = ? WHERE telegram_id = ?")
      .run(todayDate, userId);
  }

  if (signalsToday >= config.daily_limit) {
    return res.json({
      allowed: false, tier: 0, tier_name: "Free",
      reason: "daily_limit_reached", remaining: 0,
      upgrade_url: `${CHECKOUT_URL}?tgid=${userId}&product=signals`,
    });
  }
  return res.json({ allowed: true, tier: 0, tier_name: "Free", remaining: config.daily_limit - signalsToday });
});

app.post("/signal-sent", (req, res) => {
  const userId = req.body.user_id;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });
  const todayDate = today();
  const user = getOrCreateSignalUser(userId);
  let s = user.signals_today || 0;
  if (user.last_signal_date !== todayDate) s = 0;
  db.prepare("UPDATE users SET signals_today = ?, last_signal_date = ?, updated_at = datetime('now') WHERE telegram_id = ?")
    .run(s + 1, todayDate, userId);
  return res.json({ ok: true, signals_today: s + 1 });
});

app.get("/status", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });
  const user = getOrCreateSignalUser(userId);
  const expired = isExpired(user);
  const activeTier = expired && user.tier > 0 ? 0 : user.tier;
  const config = SIGNAL_TIERS[activeTier];
  return res.json({
    ok: true, user_id: userId, product: "signals",
    tier: activeTier, tier_name: config.name,
    is_paid: activeTier >= 1, is_expired: expired && user.tier > 0,
    expires_at: user.expires_at, total_paid_usdc: user.total_paid_usdc,
    signals_today: user.last_signal_date === today() ? user.signals_today : 0,
    daily_limit: config.daily_limit,
  });
});

app.get("/subscribe", (req, res) => {
  const userId = req.query.user_id;
  const tier = parseInt(req.query.tier) || 1;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });
  if (!SIGNAL_TIERS[tier] || tier === 0) return res.json({ ok: false, reason: "invalid_tier" });
  const config = SIGNAL_TIERS[tier];
  const link = `${CHECKOUT_URL}?tgid=${userId}&product=signals&tier=${tier}&price=${config.price}`;
  return res.json({ ok: true, product: "signals", checkout_url: link, tier, tier_name: config.name, price_usdc: config.price });
});

app.get("/plans", (req, res) => {
  const plans = Object.entries(SIGNAL_TIERS).map(([id, c]) => ({
    tier: parseInt(id), name: c.name, price_usdc: c.price, daily_limit: c.daily_limit || "unlimited",
  }));
  return res.json({ ok: true, product: "signals", plans });
});

// ═════════════════════════════════════════════════════════════
// SPORTS ENDPOINTS
// ═════════════════════════════════════════════════════════════

app.get("/sports/can-send", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.json({ allowed: false, reason: "missing_user_id" });

  const user = getOrCreateSportsUser(userId);
  const tier = isExpired(user) && user.tier > 0 ? 0 : user.tier;
  const config = SPORTS_TIERS[tier];

  if (tier >= 1) {
    return res.json({ allowed: true, tier, tier_name: config.name });
  }

  // Free tier: 1 code per DAY
  const todayDate = today();
  let codesToday = user.codes_today || 0;
  if (user.last_code_date !== todayDate) {
    codesToday = 0;
    db.prepare("UPDATE sports_subscriptions SET codes_today = 0, last_code_date = ? WHERE telegram_id = ?")
      .run(todayDate, userId);
  }

  if (codesToday >= config.daily_limit) {
    return res.json({
      allowed: false, tier: 0, tier_name: "Free",
      reason: "daily_limit_reached", remaining: 0,
      upgrade_url: `${CHECKOUT_URL}?tgid=${userId}&product=sports`,
    });
  }
  return res.json({ allowed: true, tier: 0, tier_name: "Free", free_remaining: config.daily_limit - codesToday });
});

app.post("/sports/code-sent", (req, res) => {
  const userId = req.body.user_id;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });
  const user = getOrCreateSportsUser(userId);
  if (user.tier > 0 && !isExpired(user)) {
    return res.json({ ok: true, paid: true });
  }
  const todayDate = today();
  let c = user.codes_today || 0;
  if (user.last_code_date !== todayDate) c = 0;
  db.prepare("UPDATE sports_subscriptions SET codes_today = ?, last_code_date = ?, updated_at = datetime('now') WHERE telegram_id = ?")
    .run(c + 1, todayDate, userId);
  return res.json({ ok: true, codes_today: c + 1 });
});

app.get("/sports/status", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });
  const user = getOrCreateSportsUser(userId);
  const expired = isExpired(user);
  const activeTier = expired && user.tier > 0 ? 0 : user.tier;
  const config = SPORTS_TIERS[activeTier];
  const todayDate = today();
  const codesToday = user.last_code_date === todayDate ? (user.codes_today || 0) : 0;
  const freeRemaining = activeTier === 0 ? Math.max(0, config.daily_limit - codesToday) : null;
  return res.json({
    ok: true, user_id: userId, product: "sports",
    tier: activeTier, tier_name: config.name,
    is_paid: activeTier >= 1, is_expired: expired && user.tier > 0,
    expires_at: user.expires_at, total_paid_usdc: user.total_paid_usdc,
    codes_today: codesToday, daily_limit: config.daily_limit, free_remaining: freeRemaining,
  });
});

app.get("/sports/subscribe", (req, res) => {
  const userId = req.query.user_id;
  const tier = parseInt(req.query.tier) || 1;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });
  if (!SPORTS_TIERS[tier] || tier === 0) return res.json({ ok: false, reason: "invalid_tier" });
  const config = SPORTS_TIERS[tier];
  const link = `${CHECKOUT_URL}?tgid=${userId}&product=sports&tier=${tier}&price=${config.price}`;
  return res.json({ ok: true, product: "sports", checkout_url: link, tier, tier_name: config.name, price_usdc: config.price });
});

app.get("/sports/plans", (req, res) => {
  const plans = Object.entries(SPORTS_TIERS).map(([id, c]) => ({
    tier: parseInt(id), name: c.name, price_usdc: c.price, daily_limit: c.daily_limit || "unlimited",
  }));
  return res.json({ ok: true, product: "sports", plans });
});

// ═════════════════════════════════════════════════════════════
// UNIFIED /activate
// ═════════════════════════════════════════════════════════════

app.post("/activate", (req, res) => {
  const { user_id, product, tier, wallet_address, tx_hash, amount_usdc } = req.body;
  if (!user_id || tier === undefined) return res.json({ ok: false, reason: "missing_fields" });

  const productKey = (product || "signals").toLowerCase();

  if (productKey === "sports") {
    if (!SPORTS_TIERS[tier] || tier === 0) return res.json({ ok: false, reason: "invalid_tier" });
    const config = SPORTS_TIERS[tier];
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    getOrCreateSportsUser(user_id);
    db.prepare(`UPDATE sports_subscriptions SET tier=?, tier_name=?, wallet_address=?, expires_at=?, total_paid_usdc = total_paid_usdc + ?, updated_at = datetime('now') WHERE telegram_id = ?`)
      .run(tier, config.name, wallet_address || "", expiresAt.toISOString(), amount_usdc || 0, user_id);
    db.prepare(`INSERT INTO payments (telegram_id, product, tier, amount_usdc, wallet_address, tx_hash) VALUES (?, 'sports', ?, ?, ?, ?)`)
      .run(user_id, tier, amount_usdc || 0, wallet_address || "", tx_hash || "");
    return res.json({ ok: true, product: "sports", tier, tier_name: config.name, expires_at: expiresAt.toISOString() });
  }

  // Signals (default)
  if (!SIGNAL_TIERS[tier]) return res.json({ ok: false, reason: "invalid_tier" });
  const config = SIGNAL_TIERS[tier];
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  getOrCreateSignalUser(user_id);
  db.prepare(`UPDATE users SET tier=?, tier_name=?, wallet_address=?, expires_at=?, total_paid_usdc = total_paid_usdc + ?, updated_at = datetime('now') WHERE telegram_id = ?`)
    .run(tier, config.name, wallet_address || "", expiresAt.toISOString(), amount_usdc || 0, user_id);
  db.prepare(`INSERT INTO payments (telegram_id, product, tier, amount_usdc, wallet_address, tx_hash) VALUES (?, 'signals', ?, ?, ?, ?)`)
    .run(user_id, tier, amount_usdc || 0, wallet_address || "", tx_hash || "");
  return res.json({ ok: true, product: "signals", tier, tier_name: config.name, expires_at: expiresAt.toISOString() });
});

// ─── Health ───────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    service: "Cmvng SignalVault Payment API v2.1",
    status: "running",
    products: ["signals", "sports"],
    sports_tiers: Object.fromEntries(Object.entries(SPORTS_TIERS).map(([k,v]) => [k, { name: v.name, price: v.price }])),
    note: "Sports free tier: 1 code per day, rotating tier by weekday",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Cmvng SignalVault Payment API v2.1 — port " + PORT);
});
