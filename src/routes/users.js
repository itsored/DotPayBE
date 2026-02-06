const express = require("express");
const User = require("../models/User");
const { connectDB } = require("../config/db");

const router = express.Router();
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const DOTPAY_ID_PREFIX_REGEX = /^dp/i;
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function normalizePhone(value) {
  if (typeof value !== "string") return "";
  // Keep "+" if present, strip common separators/spaces.
  return value.trim().replace(/[\s()-]/g, "");
}

function normalizeAddress(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function normalizeUsername(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^@+/, "").toLowerCase();
}

async function generateUniqueDotpayId() {
  for (let i = 0; i < 12; i += 1) {
    const random = Math.floor(100000000 + Math.random() * 900000000);
    const candidate = `DP${random}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await User.exists({ dotpayId: candidate });
    if (!exists) return candidate;
  }

  const fallback = `DP${Date.now().toString().slice(-9)}`;
  const exists = await User.exists({ dotpayId: fallback });
  if (!exists) return fallback;
  return `DP${Date.now().toString()}${Math.floor(Math.random() * 10)}`;
}

function toResponse(user) {
  return {
    id: user._id.toString(),
    address: user.address,
    email: user.email,
    phone: user.phone,
    thirdwebUserId: user.thirdwebUserId,
    username: user.username,
    dotpayId: user.dotpayId,
    authMethod: user.authMethod,
    thirdwebCreatedAt: user.thirdwebCreatedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * POST /api/users
 * Create or update user from DotPay sign-in/sign-up (session user payload).
 * Body: { address, email?, phone?, userId?, authMethod?, createdAt?, username? }
 */
router.post("/", async (req, res) => {
  try {
    await connectDB();

    const { address, email, phone, userId, authMethod, createdAt, username } = req.body;
    const normalizedAddress = normalizeAddress(address);
    const normalizedUsername = normalizeUsername(username);
    const normalizedPhone = phone === undefined ? undefined : phone ? normalizePhone(phone) : null;

    if (!normalizedAddress) {
      return res.status(400).json({
        success: false,
        message: "address is required",
      });
    }

    if (normalizedUsername && !USERNAME_REGEX.test(normalizedUsername)) {
      return res.status(400).json({
        success: false,
        message: "username must be 3-20 chars using lowercase letters, numbers, or underscore",
      });
    }

    if (normalizedUsername) {
      const usernameOwner = await User.findOne({ username: normalizedUsername });
      if (usernameOwner && usernameOwner.address !== normalizedAddress) {
        return res.status(409).json({
          success: false,
          message: "username is already taken",
        });
      }
    }

    let user = await User.findOne({ address: normalizedAddress });

    if (!user) {
      user = new User({
        address: normalizedAddress,
        email: email ?? null,
        phone: normalizedPhone ?? null,
        thirdwebUserId: userId ?? null,
        authMethod: authMethod ?? null,
        thirdwebCreatedAt: createdAt ? new Date(createdAt) : null,
        username: normalizedUsername || null,
        dotpayId: await generateUniqueDotpayId(),
      });
    } else {
      if (email !== undefined) user.email = email ?? null;
      if (phone !== undefined) user.phone = normalizedPhone ?? null;
      if (userId !== undefined) user.thirdwebUserId = userId ?? null;
      if (authMethod !== undefined) user.authMethod = authMethod ?? null;
      if (createdAt !== undefined) user.thirdwebCreatedAt = createdAt ? new Date(createdAt) : null;
      if (normalizedUsername) user.username = normalizedUsername;
      if (!user.dotpayId) user.dotpayId = await generateUniqueDotpayId();
    }

    await user.save();

    return res.status(200).json({
      success: true,
      data: toResponse(user),
    });
  } catch (err) {
    console.error("POST /api/users error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to save user",
    });
  }
});

/**
 * PATCH /api/users/:address/identity
 * Set username and ensure DotPay ID exists.
 * Body: { username }
 */
router.patch("/:address/identity", async (req, res) => {
  try {
    await connectDB();

    const normalizedAddress = normalizeAddress(req.params.address);
    const normalizedUsername = normalizeUsername(req.body?.username);

    if (!normalizedAddress) {
      return res.status(400).json({ success: false, message: "address is required" });
    }

    if (!normalizedUsername || !USERNAME_REGEX.test(normalizedUsername)) {
      return res.status(400).json({
        success: false,
        message: "username must be 3-20 chars using lowercase letters, numbers, or underscore",
      });
    }

    const usernameOwner = await User.findOne({ username: normalizedUsername });
    if (usernameOwner && usernameOwner.address !== normalizedAddress) {
      return res.status(409).json({ success: false, message: "username is already taken" });
    }

    let user = await User.findOne({ address: normalizedAddress });
    if (!user) {
      user = new User({
        address: normalizedAddress,
        username: normalizedUsername,
        dotpayId: await generateUniqueDotpayId(),
      });
    } else {
      user.username = normalizedUsername;
      if (!user.dotpayId) user.dotpayId = await generateUniqueDotpayId();
    }

    await user.save();

    return res.status(200).json({
      success: true,
      data: toResponse(user),
    });
  } catch (err) {
    console.error("PATCH /api/users/:address/identity error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update identity",
    });
  }
});

/**
 * GET /api/users/lookup?q=...
 * Resolve a recipient identifier (DotPay ID, @username, email, phone, or wallet address) to a user record.
 *
 * Note: This is intentionally minimal to avoid leaking sensitive fields in lookup responses.
 */
router.get("/lookup", async (req, res) => {
  try {
    await connectDB();

    const qRaw = typeof req.query.q === "string" ? req.query.q : typeof req.query.query === "string" ? req.query.query : "";
    const q = (qRaw || "").trim();
    if (!q) {
      return res.status(400).json({ success: false, message: "q is required" });
    }

    const normalizedAddress = normalizeAddress(q);
    const normalizedUsername = normalizeUsername(q);
    const normalizedEmail = normalizeEmail(q);
    const normalizedPhone = normalizePhone(q);
    const upper = q.toUpperCase();
    const phoneDigits = normalizedPhone.replace(/[^0-9]/g, "");

    const lookups = [];

    // Wallet address
    if (ETH_ADDRESS_REGEX.test(q)) {
      lookups.push({ address: normalizedAddress });
    }

    // DotPay ID (e.g. DP123456789)
    if (DOTPAY_ID_PREFIX_REGEX.test(q)) {
      lookups.push({ dotpayId: upper });
    }

    // Username (e.g. @alex or alex)
    if (q.startsWith("@") || USERNAME_REGEX.test(normalizedUsername)) {
      lookups.push({ username: normalizedUsername });
    }

    // Email
    if (q.includes("@")) {
      lookups.push({ email: normalizedEmail });
    }

    // Phone (store format can vary; try a few common normalizations)
    if (phoneDigits.length >= 7) {
      lookups.push({ phone: normalizedPhone });
      if (normalizedPhone !== phoneDigits) lookups.push({ phone: phoneDigits });
      if (!normalizedPhone.startsWith("+")) lookups.push({ phone: `+${phoneDigits}` });
    }

    if (lookups.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Unsupported lookup format",
      });
    }

    const user = await User.findOne({ $or: lookups });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      data: {
        address: user.address,
        username: user.username,
        dotpayId: user.dotpayId,
      },
    });
  } catch (err) {
    console.error("GET /api/users/lookup error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to lookup user",
    });
  }
});

/**
 * GET /api/users/:address
 * Get user by wallet address.
 */
router.get("/:address", async (req, res) => {
  try {
    await connectDB();

    const address = normalizeAddress(req.params.address);
    if (!address) {
      return res.status(400).json({ success: false, message: "address is required" });
    }

    const user = await User.findOne({ address });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      data: toResponse(user),
    });
  } catch (err) {
    console.error("GET /api/users/:address error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to get user",
    });
  }
});

module.exports = router;
