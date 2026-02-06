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

// Health endpoints: keep /health for local, and expose /api/health for serverless deployments.
app.get(["/health", "/api/health"], (req, res) => {
  res.json({ ok: true, service: "dotpay-backend" });
});

app.use("/api/users", usersRouter);
app.use("/api/notifications", notificationsRouter);

module.exports = { app };
