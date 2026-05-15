/**
 * CMVNG SIGNALVAULT — PAYMENT API
 * 
 * One server that does everything:
 *   /can-send?user_id=123        → Can this user receive a signal?
 *   /activate                     → Checkout page calls this after payment
 *   /status?user_id=123          → What plan is this user on?
 *   /subscribe?user_id=123       → Generate checkout link
 * 
 * Deploy on Railway. Connect to your existing bot with one URL.
 */

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Database Setup (SQLite — no external DB needed) ─────────

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
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT,
    tier INTEGER,
    amount_usdc REAL,
    wallet_address TEXT,
    tx_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ─── Config ──────────────────────────────────────────────────

const TIERS = {
  0: { name: "Free",           price: 0,   daily_limit: 2    },
  1: { name: "Pro",            price: 15,  daily_limit: null  },  // null = unlimited
  2: { name: "Elite",          price: 50,  daily_limit: null  },
  3: { name: "Institutional",  price: 150, daily_limit: null  },
};

const CHECKOUT_URL = process.env.CHECKOUT_URL || "https://cmvng-checkout.vercel.app";

// ─── Helper Functions ────────────────────────────────────────

function getUser(telegramId) {
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
}

function getOrCreateUser(telegramId) {
  let user = getUser(telegramId);
  if (!user) {
    db.prepare("INSERT INTO users (telegram_id) VALUES (?)").run(telegramId);
    user = getUser(telegramId);
  }
  return user;
}

function isExpired(user) {
  if (!user.expires_at) return true;
  return new Date(user.expires_at) < new Date();
}

function today() {
  return new Date().toISOString().split("T")[0];
}

// ─── ENDPOINT 1: /can-send ──────────────────────────────────
//
// YOUR EXISTING BOT CALLS THIS.
// Before sending a signal, it asks: "can I send to this user?"
//
// GET /can-send?user_id=123456789
//
// Returns:
//   { "allowed": true,  "tier": 1, "tier_name": "Pro" }
//   { "allowed": false, "tier": 0, "tier_name": "Free", "reason": "daily_limit_reached", "remaining": 0 }
//

app.get("/can-send", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.json({ allowed: false, reason: "missing_user_id" });

  const user = getOrCreateUser(userId);
  const tier = isExpired(user) && user.tier > 0 ? 0 : user.tier;
  const config = TIERS[tier];

  // Paid users: always allowed
  if (tier >= 1) {
    return res.json({
      allowed: true,
      tier: tier,
      tier_name: config.name,
    });
  }

  // Free users: check daily limit
  const todayDate = today();
  let signalsToday = user.signals_today || 0;

  // Reset count if it's a new day
  if (user.last_signal_date !== todayDate) {
    signalsToday = 0;
    db.prepare("UPDATE users SET signals_today = 0, last_signal_date = ? WHERE telegram_id = ?")
      .run(todayDate, userId);
  }

  if (signalsToday >= config.daily_limit) {
    return res.json({
      allowed: false,
      tier: 0,
      tier_name: "Free",
      reason: "daily_limit_reached",
      remaining: 0,
      upgrade_url: `${CHECKOUT_URL}?tgid=${userId}`,
    });
  }

  return res.json({
    allowed: true,
    tier: 0,
    tier_name: "Free",
    remaining: config.daily_limit - signalsToday,
  });
});


// ─── ENDPOINT 2: /signal-sent ────────────────────────────────
//
// YOUR BOT CALLS THIS AFTER SENDING A SIGNAL.
// Increments the daily counter for free users.
//
// POST /signal-sent  { "user_id": "123456789" }
//

app.post("/signal-sent", (req, res) => {
  const userId = req.body.user_id;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });

  const todayDate = today();
  const user = getOrCreateUser(userId);

  let signalsToday = user.signals_today || 0;
  if (user.last_signal_date !== todayDate) {
    signalsToday = 0;
  }

  db.prepare(
    "UPDATE users SET signals_today = ?, last_signal_date = ?, updated_at = datetime('now') WHERE telegram_id = ?"
  ).run(signalsToday + 1, todayDate, userId);

  return res.json({ ok: true, signals_today: signalsToday + 1 });
});


// ─── ENDPOINT 3: /activate ──────────────────────────────────
//
// THE CHECKOUT PAGE CALLS THIS after a successful payment.
// Activates or upgrades the user's subscription.
//
// POST /activate
// {
//   "user_id": "123456789",
//   "tier": 1,
//   "wallet_address": "0x...",
//   "tx_hash": "0x...",
//   "amount_usdc": 15
// }
//

app.post("/activate", (req, res) => {
  const { user_id, tier, wallet_address, tx_hash, amount_usdc } = req.body;

  if (!user_id || !tier) {
    return res.json({ ok: false, reason: "missing_fields" });
  }

  if (!TIERS[tier]) {
    return res.json({ ok: false, reason: "invalid_tier" });
  }

  const config = TIERS[tier];
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

  // Create or update user
  getOrCreateUser(user_id);

  db.prepare(`
    UPDATE users SET
      tier = ?,
      tier_name = ?,
      wallet_address = ?,
      expires_at = ?,
      total_paid_usdc = total_paid_usdc + ?,
      updated_at = datetime('now')
    WHERE telegram_id = ?
  `).run(tier, config.name, wallet_address || "", expiresAt.toISOString(), amount_usdc || 0, user_id);

  // Record payment
  db.prepare(`
    INSERT INTO payments (telegram_id, tier, amount_usdc, wallet_address, tx_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(user_id, tier, amount_usdc || 0, wallet_address || "", tx_hash || "");

  return res.json({
    ok: true,
    tier: tier,
    tier_name: config.name,
    expires_at: expiresAt.toISOString(),
    message: `${config.name} plan activated until ${expiresAt.toLocaleDateString()}`,
  });
});


// ─── ENDPOINT 4: /status ────────────────────────────────────
//
// Check a user's current subscription status.
//
// GET /status?user_id=123456789
//

app.get("/status", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });

  const user = getOrCreateUser(userId);
  const expired = isExpired(user);
  const activeTier = expired && user.tier > 0 ? 0 : user.tier;
  const config = TIERS[activeTier];

  return res.json({
    ok: true,
    user_id: userId,
    tier: activeTier,
    tier_name: config.name,
    is_paid: activeTier >= 1,
    is_expired: expired && user.tier > 0,
    expires_at: user.expires_at,
    total_paid_usdc: user.total_paid_usdc,
    signals_today: user.last_signal_date === today() ? user.signals_today : 0,
    daily_limit: config.daily_limit,
  });
});


// ─── ENDPOINT 5: /subscribe ─────────────────────────────────
//
// Generate a checkout link for a user.
// Your bot can call this to get the URL to send to the user.
//
// GET /subscribe?user_id=123&tier=1
//

app.get("/subscribe", (req, res) => {
  const userId = req.query.user_id;
  const tier = parseInt(req.query.tier) || 1;

  if (!userId) return res.json({ ok: false, reason: "missing_user_id" });
  if (!TIERS[tier] || tier === 0) return res.json({ ok: false, reason: "invalid_tier" });

  const config = TIERS[tier];
  const checkoutLink = `${CHECKOUT_URL}?tgid=${userId}&tier=${tier}&price=${config.price}&plan=${config.name}`;

  return res.json({
    ok: true,
    checkout_url: checkoutLink,
    tier: tier,
    tier_name: config.name,
    price_usdc: config.price,
  });
});


// ─── ENDPOINT 6: /plans ─────────────────────────────────────
//
// List all available plans. Useful for displaying in your bot.
//

app.get("/plans", (req, res) => {
  const plans = Object.entries(TIERS).map(([id, config]) => ({
    tier: parseInt(id),
    name: config.name,
    price_usdc: config.price,
    daily_limit: config.daily_limit || "unlimited",
  }));

  return res.json({ ok: true, plans });
});


// ─── Health Check ────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    service: "Cmvng SignalVault Payment API",
    status: "running",
    endpoints: [
      "GET  /can-send?user_id=123       → Can this user receive a signal?",
      "POST /signal-sent {user_id}       → Record that a signal was sent",
      "POST /activate {user_id,tier,...}  → Activate a subscription",
      "GET  /status?user_id=123          → Check subscription status",
      "GET  /subscribe?user_id=123&tier=1 → Get checkout link",
      "GET  /plans                        → List all plans",
    ],
  });
});


// ─── Start Server ────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("");
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  Cmvng SignalVault — Payment API            ║");
  console.log(`║  Running on port ${PORT}                       ║`);
  console.log("╚════════════════════════════════════════════╝");
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /can-send?user_id=123");
  console.log("  POST /signal-sent");
  console.log("  POST /activate");
  console.log("  GET  /status?user_id=123");
  console.log("  GET  /subscribe?user_id=123&tier=1");
  console.log("  GET  /plans");
  console.log("");
});
