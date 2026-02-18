const express = require("express");

const { connectDB } = require("../config/db");
const { hasValidClientBearer } = require("../services/mpesa");
const {
  deposit,
  buyCrypto,
  payPaybill,
  payTill,
  payWithCrypto,
  withdraw,
  cryptoToMpesa,
  submitReceipt,
  getTransactionStatus,
} = require("../controllers/mpesaOperations");
const {
  stkCallback,
  b2cCallback,
  b2bCallback,
  queueTimeoutCallback,
} = require("../controllers/mpesaCallbacks");

const router = express.Router();

const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 40;

function fail(res, statusCode, message, error = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    error,
    timestamp: new Date().toISOString(),
  });
}

function requireClientAuth(req, res, next) {
  const expectedInternalKey = String(process.env.DOTPAY_INTERNAL_API_KEY || "").trim();
  const internalHeader = String(req.get("x-dotpay-internal-key") || "").trim();

  if (expectedInternalKey && internalHeader && internalHeader === expectedInternalKey) {
    return next();
  }
  if (hasValidClientBearer(req)) {
    return next();
  }
  return fail(res, 401, "Unauthorized");
}

function enforceRateLimit(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const existing = rateLimitStore.get(key);

  if (!existing || now > existing.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);
    res.set("Retry-After", String(Math.max(retryAfterSeconds, 1)));
    return fail(res, 429, "Too many requests. Please retry shortly.");
  }

  existing.count += 1;
  return next();
}

async function ensureDb(req, res, next) {
  try {
    await connectDB();
    return next();
  } catch (error) {
    console.error("M-Pesa DB connection error:", error);
    return fail(res, 500, "Database connection failed");
  }
}

router.use(ensureDb);

router.post("/deposit", requireClientAuth, enforceRateLimit, deposit);
router.post("/buy-crypto", requireClientAuth, enforceRateLimit, buyCrypto);
router.post("/pay/paybill", requireClientAuth, enforceRateLimit, payPaybill);
router.post("/pay/till", requireClientAuth, enforceRateLimit, payTill);
router.post("/pay-with-crypto", requireClientAuth, enforceRateLimit, payWithCrypto);
router.post("/withdraw", requireClientAuth, enforceRateLimit, withdraw);
router.post("/crypto-to-mpesa", requireClientAuth, enforceRateLimit, cryptoToMpesa);
router.post("/submit-receipt", requireClientAuth, submitReceipt);
router.get("/transaction/:transactionId", requireClientAuth, getTransactionStatus);

router.post("/stk-callback", stkCallback);
router.post("/b2c-callback", b2cCallback);
router.post("/b2b-callback", b2bCallback);
router.post("/queue-timeout", queueTimeoutCallback);

module.exports = router;

