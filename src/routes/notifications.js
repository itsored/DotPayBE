const express = require("express");
const Notification = require("../models/Notification");
const { connectDB } = require("../config/db");

const router = express.Router();

const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

function normalizeAddress(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function normalizeTxHash(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function normalizeNote(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length ? trimmed : null;
}

function requireInternalKey(req, res, next) {
  const expected = (process.env.DOTPAY_INTERNAL_API_KEY || "").trim();
  if (!expected) {
    return res.status(500).json({
      success: false,
      message: "DOTPAY_INTERNAL_API_KEY is not configured.",
    });
  }

  const provided =
    (req.get("x-dotpay-internal-key") || "").trim() ||
    ((req.get("authorization") || "").trim().toLowerCase().startsWith("bearer ")
      ? req.get("authorization").trim().slice("bearer ".length)
      : "");

  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  return next();
}

function toResponse(doc) {
  return {
    id: doc._id.toString(),
    toAddress: doc.toAddress,
    fromAddress: doc.fromAddress,
    type: doc.type,
    chainId: doc.chainId,
    contractAddress: doc.contractAddress,
    txHash: doc.txHash,
    logIndex: doc.logIndex,
    value: doc.value,
    tokenSymbol: doc.tokenSymbol,
    tokenDecimal: doc.tokenDecimal,
    note: doc.note,
    eventAt: doc.eventAt,
    readAt: doc.readAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

router.use(requireInternalKey);

/**
 * GET /api/notifications?address=0x...&limit=20&before=ISO
 * Internal-only. Lists notifications for a wallet address.
 */
router.get("/", async (req, res) => {
  try {
    await connectDB();

    const address = normalizeAddress(req.query.address);
    const limitParam = Number.parseInt(String(req.query.limit || "20"), 10);
    const beforeParam = typeof req.query.before === "string" ? req.query.before : null;

    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 20;

    if (!address || !ETH_ADDRESS_REGEX.test(address)) {
      return res.status(400).json({ success: false, message: "Invalid address." });
    }

    const query = { toAddress: address };
    if (beforeParam) {
      const beforeTs = new Date(beforeParam).getTime();
      if (Number.isFinite(beforeTs)) {
        query.eventAt = { $lt: new Date(beforeTs) };
      }
    }

    const [notifications, unreadCount] = await Promise.all([
      Notification.find(query).sort({ eventAt: -1, _id: -1 }).limit(limit),
      Notification.countDocuments({ toAddress: address, readAt: null }),
    ]);

    const nextCursor =
      notifications.length > 0 ? notifications[notifications.length - 1].eventAt?.toISOString?.() : null;

    return res.status(200).json({
      success: true,
      data: {
        notifications: notifications.map(toResponse),
        unreadCount,
        nextCursor,
      },
    });
  } catch (err) {
    console.error("GET /api/notifications error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to load notifications." });
  }
});

/**
 * POST /api/notifications/payment
 * Internal-only. Create a payment-received notification (idempotent by (toAddress, txHash, logIndex)).
 */
router.post("/payment", async (req, res) => {
  try {
    await connectDB();

    const toAddress = normalizeAddress(req.body?.toAddress);
    const fromAddress = normalizeAddress(req.body?.fromAddress);
    const type = String(req.body?.type || "payment_received");
    const txHash = normalizeTxHash(req.body?.txHash);
    const chainId = Number.parseInt(String(req.body?.chainId || "0"), 10);
    const contractAddress = normalizeAddress(req.body?.contractAddress);
    const tokenSymbol = String(req.body?.tokenSymbol || "USDC").trim();
    const tokenDecimal = Number.parseInt(String(req.body?.tokenDecimal ?? "6"), 10);
    const value = String(req.body?.value || "").trim();
    const logIndex = Number.parseInt(String(req.body?.logIndex ?? "-1"), 10);
    const note = normalizeNote(req.body?.note);
    const eventAtRaw = req.body?.eventAt;
    const eventAt = eventAtRaw ? new Date(eventAtRaw) : new Date();

    if (!toAddress || !ETH_ADDRESS_REGEX.test(toAddress)) {
      return res.status(400).json({ success: false, message: "Invalid toAddress." });
    }
    if (!fromAddress || !ETH_ADDRESS_REGEX.test(fromAddress)) {
      return res.status(400).json({ success: false, message: "Invalid fromAddress." });
    }
    if (type !== "payment_received") {
      return res.status(400).json({ success: false, message: "Unsupported notification type." });
    }
    if (!txHash || !TX_HASH_REGEX.test(txHash)) {
      return res.status(400).json({ success: false, message: "Invalid txHash." });
    }
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid chainId." });
    }
    if (!contractAddress || !ETH_ADDRESS_REGEX.test(contractAddress)) {
      return res.status(400).json({ success: false, message: "Invalid contractAddress." });
    }
    if (!Number.isFinite(tokenDecimal) || tokenDecimal < 0 || tokenDecimal > 18) {
      return res.status(400).json({ success: false, message: "Invalid tokenDecimal." });
    }
    if (!value || !/^[0-9]+$/.test(value)) {
      return res.status(400).json({ success: false, message: "Invalid value." });
    }
    if (!Number.isFinite(logIndex) || logIndex < 0) {
      return res.status(400).json({ success: false, message: "Invalid logIndex." });
    }
    if (!Number.isFinite(eventAt.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid eventAt." });
    }

    const existing = await Notification.findOne({ toAddress, txHash, logIndex });
    if (existing) {
      return res.status(200).json({ success: true, data: toResponse(existing) });
    }

    const created = await Notification.create({
      toAddress,
      fromAddress,
      type,
      chainId,
      contractAddress,
      txHash,
      logIndex,
      value,
      tokenSymbol,
      tokenDecimal,
      note,
      eventAt,
    });

    return res.status(201).json({ success: true, data: toResponse(created) });
  } catch (err) {
    // Duplicate is fine (idempotent writes across retries).
    if (err && (err.code === 11000 || err.code === 11001)) {
      return res.status(200).json({ success: true, message: "Already exists." });
    }

    console.error("POST /api/notifications/payment error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to create notification.",
    });
  }
});

/**
 * POST /api/notifications/read-all
 * Internal-only. Mark all notifications as read for an address.
 * Body: { address }
 */
router.post("/read-all", async (req, res) => {
  try {
    const address = normalizeAddress(req.body?.address);
    if (!address || !ETH_ADDRESS_REGEX.test(address)) {
      return res.status(400).json({ success: false, message: "Invalid address." });
    }

    const now = new Date();
    const result = await Notification.updateMany(
      { toAddress: address, readAt: null },
      { $set: { readAt: now } }
    );

    return res.status(200).json({
      success: true,
      data: {
        matchedCount: result.matchedCount ?? result.n ?? 0,
        modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
      },
    });
  } catch (err) {
    console.error("POST /api/notifications/read-all error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to mark read." });
  }
});

/**
 * POST /api/notifications/:id/read
 * Internal-only. Mark one notification as read for an address.
 * Body: { address }
 */
router.post("/:id/read", async (req, res) => {
  try {
    const address = normalizeAddress(req.body?.address);
    const id = String(req.params.id || "").trim();
    if (!address || !ETH_ADDRESS_REGEX.test(address)) {
      return res.status(400).json({ success: false, message: "Invalid address." });
    }
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }

    const now = new Date();
    const updated = await Notification.findOneAndUpdate(
      { _id: id, toAddress: address, readAt: null },
      { $set: { readAt: now } },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }

    return res.status(200).json({ success: true, data: toResponse(updated) });
  } catch (err) {
    console.error("POST /api/notifications/:id/read error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to mark read." });
  }
});

module.exports = router;
