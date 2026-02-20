require("dotenv").config();

const express = require("express");
const cors = require("cors");

const usersRouter = require("./routes/users");
const notificationsRouter = require("./routes/notifications");
const mpesaRouter = require("./routes/mpesa");
const mpesaWebhooksRouter = require("./routes/mpesa-webhooks");

const normalizeOrigin = (value) => String(value || "").trim().replace(/\/+$/, "");

// Allowlist of browser origins (comma-separated). Example:
// CLIENT_ORIGINS=https://dot-pay.vercel.app,https://dot-pay-git-branch.vercel.app
const CLIENT_ORIGINS_RAW = process.env.CLIENT_ORIGINS || process.env.CLIENT_ORIGIN || "";
const CLIENT_ORIGINS = CLIENT_ORIGINS_RAW.split(",").map(normalizeOrigin).filter(Boolean);

const app = express();

const allowLocalhost = process.env.NODE_ENV !== "production";
const allowAllOrigins =
  String(process.env.CORS_ALLOW_ALL || "").trim().toLowerCase() === "true" || CLIENT_ORIGINS.includes("*");

const allowedOriginSet = new Set();
const allowedHostSet = new Set();
for (const entry of CLIENT_ORIGINS) {
  if (!entry || entry === "*") continue;
  if (entry.includes("://")) allowedOriginSet.add(entry);
  else allowedHostSet.add(entry);
}

const allowAllByDefault =
  process.env.NODE_ENV === "production" && allowedOriginSet.size === 0 && allowedHostSet.size === 0;

const shouldAllowAll = allowAllOrigins || allowAllByDefault;

if (allowAllByDefault && !global.__dotpay_cors_warned) {
  global.__dotpay_cors_warned = true;
  console.warn("CLIENT_ORIGINS/CLIENT_ORIGIN not set; allowing all origins (set it to lock down CORS).");
}

// Allow frontend origin(s): allowlisted in production; allow localhost in dev.
const corsOrigin = (origin, cb) => {
  if (!origin) return cb(null, true); // non-browser clients

  const o = normalizeOrigin(origin);
  if (allowLocalhost && /^https?:\/\/localhost(:\d+)?$/.test(o)) {
    return cb(null, true);
  }

  if (shouldAllowAll) return cb(null, true);

  if (allowedOriginSet.has(o)) return cb(null, true);

  try {
    const { hostname } = new URL(o);
    if (allowedHostSet.has(hostname)) return cb(null, true);
  } catch (err) {
    // ignore invalid Origin values
  }

  return cb(null, false);
};

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
// Explicit preflight support for all routes.
app.options("*", cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

// Health endpoints.
// Note: Vercel rewrites can preserve the original path, so support "/" directly too.
app.get(["/", "/health", "/api/health"], (req, res) => {
  res.json({ ok: true, service: "dotpay-backend" });
});

app.use("/api/users", usersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/mpesa", mpesaWebhooksRouter);
app.use("/api/mpesa", mpesaRouter);

// Last-resort error handler for unexpected exceptions.
// (Most routes already handle their own errors.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal Server Error" });
});

module.exports = { app };
