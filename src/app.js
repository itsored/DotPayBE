require("dotenv").config();

const express = require("express");
const cors = require("cors");

const usersRouter = require("./routes/users");
const notificationsRouter = require("./routes/notifications");

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

const app = express();

// Allow frontend origin(s): single CLIENT_ORIGIN or any localhost in dev
const corsOrigin =
  process.env.NODE_ENV === "production"
    ? CLIENT_ORIGIN
    : (origin, cb) => {
        if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
          cb(null, true);
        } else {
          cb(null, false);
        }
      };

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
app.use(express.json());

// Health endpoints.
// Note: Vercel rewrites can preserve the original path, so support "/" directly too.
app.get(["/", "/health", "/api/health"], (req, res) => {
  res.json({ ok: true, service: "dotpay-backend" });
});

app.use("/api/users", usersRouter);
app.use("/api/notifications", notificationsRouter);

// Last-resort error handler for unexpected exceptions.
// (Most routes already handle their own errors.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal Server Error" });
});

module.exports = { app };
