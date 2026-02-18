const express = require("express");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { connectDB } = require("../config/db");
const { mpesaConfig } = require("../config/mpesa");
const { MpesaTransaction } = require("../models/MpesaTransaction");
const User = require("../models/User");
const { requireBackendAuth } = require("../middleware/requireBackendAuth");
const { requireIdempotencyKey } = require("../middleware/idempotency");
const { buildQuote, isQuoteExpired } = require("../services/mpesa/quoteService");
const { assertTransition } = require("../services/mpesa/stateMachine");
const {
  initiateStkPush,
  initiateB2C,
  initiateB2B,
  queryTransactionStatus,
} = require("../services/mpesa/darajaClient");
const { scheduleAutoRefund } = require("../services/mpesa/refundService");
const {
  calculateExpectedFundingFromQuote,
  verifyUsdcFunding,
} = require("../services/settlement/verifyUsdcFunding");
const { verifyPin } = require("../services/security/pin");

const router = express.Router();

const FLOWS = ["onramp", "offramp", "paybill", "buygoods"];
const FUNDED_FLOWS = new Set(["offramp", "paybill", "buygoods"]);
const APP_PIN_LENGTH = 6;

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").trim().replace(/[\s()+-]/g, "");
}

function normalizeNumber(value) {
  return String(value || "").trim();
}

function parsePositiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return n;
}

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function formatFixed(value, decimals) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return Number(0).toFixed(decimals);
  return n.toFixed(decimals);
}

function isValidPhone(phone) {
  return /^254\d{9}$/.test(phone);
}

function requireMpesaEnabled(req, res) {
  if (!mpesaConfig.enabled) {
    res.status(503).json({
      success: false,
      message: "M-Pesa is currently disabled.",
    });
    return false;
  }
  return true;
}

function requiresOnchainFunding(flowType) {
  return Boolean(mpesaConfig.settlement?.requireOnchainFunding) && FUNDED_FLOWS.has(flowType);
}

function mapTransaction(tx) {
  return {
    transactionId: tx.transactionId,
    flowType: tx.flowType,
    status: tx.status,
    quote: tx.quote,
    targets: tx.targets,
    onchain: tx.onchain,
    daraja: {
      merchantRequestId: tx.daraja?.merchantRequestId || null,
      checkoutRequestId: tx.daraja?.checkoutRequestId || null,
      conversationId: tx.daraja?.conversationId || null,
      originatorConversationId: tx.daraja?.originatorConversationId || null,
      responseCode: tx.daraja?.responseCode || null,
      responseDescription: tx.daraja?.responseDescription || null,
      resultCode: tx.daraja?.resultCode ?? null,
      resultCodeRaw: tx.daraja?.resultCodeRaw || null,
      resultDesc: tx.daraja?.resultDesc || null,
      receiptNumber: tx.daraja?.receiptNumber || null,
      customerMessage: tx.daraja?.customerMessage || null,
      callbackReceivedAt: tx.daraja?.callbackReceivedAt || null,
    },
    refund: tx.refund,
    history: tx.history,
    businessId: tx.businessId || null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  };
}

function requireInternalKey(req, res, next) {
  const expected = String(process.env.DOTPAY_INTERNAL_API_KEY || "").trim();
  if (!expected) {
    return res.status(500).json({ success: false, message: "DOTPAY_INTERNAL_API_KEY is not configured." });
  }

  const provided =
    String(req.get("x-dotpay-internal-key") || "").trim() ||
    (String(req.get("authorization") || "").toLowerCase().startsWith("bearer ")
      ? String(req.get("authorization") || "").slice(7).trim()
      : "");

  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  return next();
}

function ensureSensitiveAuth(body) {
  const pin = String(body?.pin || "").trim();
  const signature = String(body?.signature || "").trim();
  const nonce = String(body?.nonce || "").trim();
  const expectedLen = APP_PIN_LENGTH;
  if (!pin || pin.length !== expectedLen) {
    throw new Error(`pin is required and must be exactly ${expectedLen} digits.`);
  }
  if (!/^\d+$/.test(pin)) {
    throw new Error("pin must contain digits only.");
  }
  if (!signature || signature.length < 24) {
    throw new Error("signature is required.");
  }
  if (!nonce || nonce.length < 8) {
    throw new Error("nonce is required and must be at least 8 characters.");
  }
  const signedAt = body?.signedAt ? new Date(body.signedAt) : new Date();
  const signedAtRaw = String(body?.signedAt || signedAt.toISOString()).trim();
  if (Number.isNaN(signedAt.getTime())) {
    throw new Error("signedAt must be a valid ISO date.");
  }
  const now = Date.now();
  const signedAtMs = signedAt.getTime();
  const maxAgeMs = Math.max(30, Number(mpesaConfig.security.signatureMaxAgeSeconds || 600)) * 1000;
  if (signedAtMs > now + 60 * 1000) {
    throw new Error("signedAt cannot be in the future.");
  }
  if (now - signedAtMs > maxAgeMs) {
    throw new Error("signature has expired. Please sign and retry.");
  }
  return {
    pin,
    signature,
    signedAt,
    signedAtRaw,
    nonce,
  };
}

async function requireUserPinVerified(userAddress, pin) {
  const address = normalizeAddress(userAddress);
  const user = await User.findOne({ address });
  if (!user || !user.pinHash) {
    throw new Error("Security PIN is not set. Please set a 6-digit app PIN to continue.");
  }

  const ok = verifyPin(pin, user.pinHash, { length: APP_PIN_LENGTH });
  if (!ok) {
    throw new Error("Invalid PIN.");
  }
}

function targetDescriptor(tx) {
  if (tx.flowType === "offramp") return `phone:${tx.targets?.phoneNumber || "-"}`;
  if (tx.flowType === "paybill") {
    return `paybill:${tx.targets?.paybillNumber || "-"}:${tx.targets?.accountReference || "-"}`;
  }
  if (tx.flowType === "buygoods") {
    return `buygoods:${tx.targets?.tillNumber || "-"}:${tx.targets?.accountReference || "DotPay"}`;
  }
  return "onramp";
}

function buildAuthorizationMessage({ tx, signedAtRaw, nonce }) {
  return [
    "DotPay Authorization",
    `Transaction: ${tx.transactionId}`,
    `Flow: ${tx.flowType}`,
    `Quote: ${tx.quote?.quoteId || "-"}`,
    `AmountKES: ${formatFixed(tx.quote?.totalDebitKes || tx.quote?.amountKes || 0, 2)}`,
    `AmountUSDC: ${formatFixed(tx.onchain?.expectedAmountUsd || tx.quote?.amountUsd || 0, 6)}`,
    `Target: ${targetDescriptor(tx)}`,
    `Nonce: ${nonce}`,
    `SignedAt: ${signedAtRaw}`,
  ].join("\n");
}

function verifyAuthorizationSignature({ tx, userAddress, signature, signedAtRaw, nonce }) {
  const message = buildAuthorizationMessage({ tx, signedAtRaw, nonce });
  let recovered = "";

  try {
    recovered = String(ethers.verifyMessage(message, signature) || "").trim().toLowerCase();
  } catch {
    throw new Error("Invalid signature.");
  }

  if (!recovered || recovered !== userAddress) {
    throw new Error("Signature does not match the authenticated wallet.");
  }

  return message;
}

function applyFundingDefaults(tx) {
  const required = requiresOnchainFunding(tx.flowType);
  const treasuryAddress = String(mpesaConfig.treasury?.address || "").trim().toLowerCase();
  const tokenAddress = String(mpesaConfig.treasury?.usdcContract || "").trim().toLowerCase();
  const chainId = parseOptionalPositiveInt(mpesaConfig.treasury?.chainId);

  tx.onchain = tx.onchain || {};
  tx.onchain.required = required;
  tx.onchain.tokenSymbol = "USDC";
  tx.onchain.tokenAddress = tokenAddress || tx.onchain.tokenAddress || null;
  tx.onchain.treasuryAddress = treasuryAddress || tx.onchain.treasuryAddress || null;
  tx.onchain.chainId = chainId || tx.onchain.chainId || null;

  if (!required) {
    tx.onchain.verificationStatus = "not_required";
    tx.onchain.expectedAmountUsd = 0;
    tx.onchain.expectedAmountUnits = null;
    return;
  }

  if (!tokenAddress || !treasuryAddress) {
    throw new Error(
      "Treasury settlement is not configured. Set TREASURY_USDC_CONTRACT and TREASURY_PLATFORM_ADDRESS (or TREASURY_PRIVATE_KEY)."
    );
  }
  if (!String(mpesaConfig.treasury?.rpcUrl || "").trim()) {
    throw new Error("TREASURY_RPC_URL is required when on-chain funding is enabled.");
  }

  const { expectedUnitsString, expectedUsd } = calculateExpectedFundingFromQuote(
    tx.quote,
    mpesaConfig.treasury?.usdcDecimals
  );

  tx.onchain.verificationStatus =
    tx.onchain.verificationStatus === "verified" ? "verified" : "pending";
  tx.onchain.expectedAmountUsd = expectedUsd;
  tx.onchain.expectedAmountUnits = expectedUnitsString;
}

async function enforceLimits(userAddress, amountKes) {
  if (amountKes > mpesaConfig.limits.maxTxnKes) {
    throw new Error(`Amount exceeds per-transaction limit of ${mpesaConfig.limits.maxTxnKes} KES.`);
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const today = await MpesaTransaction.aggregate([
    {
      $match: {
        userAddress,
        createdAt: { $gte: start },
        status: { $nin: ["failed"] },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: "$quote.amountKes" },
      },
    },
  ]);

  const used = Number(today?.[0]?.total || 0);
  if (used + amountKes > mpesaConfig.limits.maxDailyKes) {
    throw new Error(`Daily limit exceeded (${mpesaConfig.limits.maxDailyKes} KES).`);
  }
}

async function fetchOrCreateQuoteTransaction({
  userAddress,
  flowType,
  body,
  idempotencyKey = null,
}) {
  const quoteId = String(body?.quoteId || "").trim();
  let tx = null;

  if (quoteId) {
    tx = await MpesaTransaction.findOne({
      userAddress,
      flowType,
      "quote.quoteId": quoteId,
    });

    if (!tx) {
      throw new Error("quoteId not found.");
    }

    if (isQuoteExpired(tx.quote)) {
      throw new Error("Quote has expired. Please generate a new quote.");
    }

    if (FUNDED_FLOWS.has(flowType) && !tx.onchain?.expectedAmountUnits) {
      applyFundingDefaults(tx);
      await tx.save();
    }
  }

  if (!tx) {
    const amount = parsePositiveNumber(body?.amount, "amount");
    const currency = String(body?.currency || "KES").trim().toUpperCase();
    const quote = buildQuote({
      flowType,
      amount,
      currency,
      kesPerUsd: body?.kesPerUsd,
    });

    tx = await MpesaTransaction.create({
      flowType,
      status: "quoted",
      userAddress,
      idempotencyKey,
      quote,
      history: [{ from: "created", to: "quoted", reason: "Quote generated", source: "api" }],
      metadata: {
        source: "web",
        extra: {
          requestId: crypto.randomUUID(),
        },
      },
    });

    applyFundingDefaults(tx);
    await tx.save();
  }

  return tx;
}

function buildCallbackUrl(kind, tx) {
  const txId = encodeURIComponent(tx.transactionId);
  if (kind === "stk") {
    return `${mpesaConfig.callbacks.resultBaseUrl}/api/mpesa/webhooks/stk?tx=${txId}`;
  }
  if (kind === "b2c_result") {
    return `${mpesaConfig.callbacks.resultBaseUrl}/api/mpesa/webhooks/b2c/result?tx=${txId}`;
  }
  if (kind === "b2c_timeout") {
    return `${mpesaConfig.callbacks.timeoutBaseUrl}/api/mpesa/webhooks/b2c/timeout?tx=${txId}`;
  }
  if (kind === "b2b_result") {
    return `${mpesaConfig.callbacks.resultBaseUrl}/api/mpesa/webhooks/b2b/result?tx=${txId}`;
  }
  return `${mpesaConfig.callbacks.timeoutBaseUrl}/api/mpesa/webhooks/b2b/timeout?tx=${txId}`;
}

async function ensureFundingVerified({ tx, userAddress, body }) {
  if (!tx.onchain?.required) {
    tx.onchain = tx.onchain || {};
    tx.onchain.verificationStatus = "not_required";
    return;
  }

  const onchainTxHash = String(body?.onchainTxHash || tx.onchain?.txHash || "")
    .trim()
    .toLowerCase();
  if (!onchainTxHash) {
    throw new Error("onchainTxHash is required before M-Pesa submission.");
  }

  const duplicate = await MpesaTransaction.findOne({
    _id: { $ne: tx._id },
    "onchain.txHash": onchainTxHash,
  }).select({ transactionId: 1 });
  if (duplicate) {
    throw new Error("This on-chain funding transaction is already linked to another payout.");
  }

  const expectedUnits = BigInt(String(tx.onchain?.expectedAmountUnits || "0"));
  if (expectedUnits <= 0n) {
    throw new Error("Funding requirement is missing for this transaction.");
  }

  if (tx.status === "awaiting_user_authorization") {
    assertTransition(tx, "awaiting_onchain_funding", "Awaiting on-chain funding", "api");
  }

  try {
    const verified = await verifyUsdcFunding({
      txHash: onchainTxHash,
      expectedFromAddress: userAddress,
      providedChainId: body?.chainId,
      expectedMinAmountUnits: expectedUnits,
    });

    tx.onchain = {
      ...(tx.onchain || {}),
      txHash: verified.txHash,
      chainId: verified.chainId,
      tokenAddress: verified.tokenAddress,
      treasuryAddress: verified.treasuryAddress,
      verificationStatus: "verified",
      verificationError: null,
      fundedAmountUnits: verified.fundedAmountUnits,
      fundedAmountUsd: verified.fundedAmountUsd,
      fromAddress: verified.fromAddress,
      toAddress: verified.toAddress,
      logIndex: Number.isFinite(verified.logIndex) ? verified.logIndex : null,
      verifiedBy: "api",
      verifiedAt: new Date(),
    };
  } catch (err) {
    tx.onchain = {
      ...(tx.onchain || {}),
      txHash: onchainTxHash,
      verificationStatus: "failed",
      verificationError: err.message,
      verifiedBy: "api",
      verifiedAt: new Date(),
    };
    await tx.save();
    throw err;
  }
}

router.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mpesa/internal/reconcile
 * Internal-only reconciliation endpoint.
 */
router.post("/internal/reconcile", requireInternalKey, async (req, res) => {
  try {
    const maxAgeMinutes = Number.parseInt(String(req.body?.maxAgeMinutes || "30"), 10);
    const executeQuery = String(req.body?.executeQuery || "false").toLowerCase() === "true";
    const transactionId = String(req.body?.transactionId || "").trim().toUpperCase();

    const cutoff = new Date(Date.now() - Math.max(1, maxAgeMinutes) * 60 * 1000);
    const query = transactionId
      ? { transactionId }
      : { status: "mpesa_processing", updatedAt: { $lte: cutoff } };

    const candidates = await MpesaTransaction.find(query).limit(100);
    const summary = {
      scanned: candidates.length,
      markedFailed: 0,
      refunded: 0,
      queried: 0,
      queryErrors: 0,
    };

    for (const tx of candidates) {
      let changed = false;

      if (executeQuery && tx.daraja?.receiptNumber) {
        summary.queried += 1;
        try {
          const statusResponse = await queryTransactionStatus({
            transactionReceipt: tx.daraja.receiptNumber,
            originatorConversationId: tx.daraja.originatorConversationId || tx.transactionId,
          });
          tx.metadata = tx.metadata || {};
          tx.metadata.extra = {
            ...(tx.metadata.extra || {}),
            lastReconcileQuery: statusResponse,
          };
          changed = true;
        } catch (err) {
          summary.queryErrors += 1;
          tx.metadata = tx.metadata || {};
          tx.metadata.extra = {
            ...(tx.metadata.extra || {}),
            lastReconcileError: err.message,
          };
          changed = true;
        }
      }

      const shouldForceById = Boolean(transactionId);
      if (tx.status === "mpesa_processing" && (shouldForceById || tx.updatedAt <= cutoff)) {
        assertTransition(tx, "failed", "Reconcile timeout", "reconcile");
        summary.markedFailed += 1;
        changed = true;
        if (mpesaConfig.refunds.autoRefund) {
          await scheduleAutoRefund(tx, "Automatic refund after reconcile timeout");
          if (tx.status === "refunded") summary.refunded += 1;
        }
      }

      if (changed) {
        await tx.save();
      }
    }

    return res.status(200).json({ success: true, data: summary });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Reconcile failed." });
  }
});

router.use(requireBackendAuth);

/**
 * POST /api/mpesa/quotes
 */
router.post("/quotes", async (req, res) => {
  try {
    if (!requireMpesaEnabled(req, res)) return;

    const userAddress = normalizeAddress(req.backendAuth.address);
    const flowType = String(req.body?.flowType || "").trim().toLowerCase();
    if (!FLOWS.includes(flowType)) {
      return res.status(400).json({ success: false, message: "flowType must be one of onramp/offramp/paybill/buygoods." });
    }

    const amount = parsePositiveNumber(req.body?.amount, "amount");
    const currency = String(req.body?.currency || "KES").trim().toUpperCase();

    const quote = buildQuote({
      flowType,
      amount,
      currency,
      kesPerUsd: req.body?.kesPerUsd,
    });

    await enforceLimits(userAddress, quote.amountKes);

    const tx = await MpesaTransaction.create({
      flowType,
      status: "quoted",
      userAddress,
      quote,
      businessId: req.body?.businessId ? String(req.body.businessId).trim() : null,
      targets: {
        phoneNumber: req.body?.phoneNumber ? normalizePhone(req.body.phoneNumber) : null,
        paybillNumber: req.body?.paybillNumber ? normalizeNumber(req.body.paybillNumber) : null,
        tillNumber: req.body?.tillNumber ? normalizeNumber(req.body.tillNumber) : null,
        accountReference: req.body?.accountReference ? normalizeNumber(req.body.accountReference) : null,
      },
      history: [{ from: "created", to: "quoted", reason: "Quote generated", source: "api" }],
      metadata: {
        source: "web",
        ipAddress: req.ip || null,
        userAgent: req.get("user-agent") || null,
      },
    });

    applyFundingDefaults(tx);
    await tx.save();

    return res.status(200).json({
      success: true,
      data: {
        quote: tx.quote,
        transaction: mapTransaction(tx),
      },
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Failed to generate quote." });
  }
});

/**
 * POST /api/mpesa/onramp/stk/initiate
 */
router.post("/onramp/stk/initiate", requireIdempotencyKey, async (req, res) => {
  try {
    if (!requireMpesaEnabled(req, res)) return;

    const userAddress = normalizeAddress(req.backendAuth.address);
    const idempotencyKey = req.idempotencyKey;

    const existing = await MpesaTransaction.findOne({ userAddress, flowType: "onramp", idempotencyKey });
    if (existing) {
      return res.status(200).json({ success: true, data: mapTransaction(existing), idempotent: true });
    }

    const phoneNumber = normalizePhone(req.body?.phoneNumber);
    if (!isValidPhone(phoneNumber)) {
      return res.status(400).json({ success: false, message: "phoneNumber must be in 2547XXXXXXXX format." });
    }

    const tx = await fetchOrCreateQuoteTransaction({
      userAddress,
      flowType: "onramp",
      body: req.body,
      idempotencyKey,
    });

    tx.idempotencyKey = idempotencyKey;
    tx.targets = { ...tx.targets, phoneNumber };
    assertTransition(tx, "mpesa_submitted", "Submitting STK push", "api");

    const callbackUrl = buildCallbackUrl("stk", tx);
    const darajaRes = await initiateStkPush({
      amountKes: tx.quote.amountKes,
      phoneNumber,
      callbackUrl,
      accountReference: `DOTPAY-${tx.transactionId}`,
      transactionDesc: "DotPay wallet top up",
      transactionType: "CustomerPayBillOnline",
    });

    tx.daraja = {
      ...(tx.daraja || {}),
      responseCode: String(darajaRes.data?.ResponseCode || ""),
      responseDescription: darajaRes.data?.ResponseDescription || null,
      merchantRequestId: darajaRes.data?.MerchantRequestID || null,
      checkoutRequestId: darajaRes.data?.CheckoutRequestID || null,
      customerMessage: darajaRes.data?.CustomerMessage || null,
      rawRequest: {
        endpoint: "stkpush",
        callbackUrl,
      },
      rawResponse: darajaRes.data,
    };

    if (darajaRes.ok && String(darajaRes.data?.ResponseCode || "") === "0") {
      assertTransition(tx, "mpesa_processing", "STK request accepted", "daraja");
    } else {
      assertTransition(tx, "failed", "STK request rejected", "daraja");
    }

    await tx.save();

    return res.status(200).json({ success: true, data: mapTransaction(tx) });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Failed to initiate onramp." });
  }
});

/**
 * POST /api/mpesa/offramp/initiate
 */
router.post("/offramp/initiate", requireIdempotencyKey, async (req, res) => {
  try {
    if (!requireMpesaEnabled(req, res)) return;

    const userAddress = normalizeAddress(req.backendAuth.address);
    const idempotencyKey = req.idempotencyKey;

    const existing = await MpesaTransaction.findOne({ userAddress, flowType: "offramp", idempotencyKey });
    if (existing) {
      return res.status(200).json({ success: true, data: mapTransaction(existing), idempotent: true });
    }

    const auth = ensureSensitiveAuth(req.body);
    await requireUserPinVerified(userAddress, auth.pin);
    const phoneNumber = normalizePhone(req.body?.phoneNumber);
    if (!isValidPhone(phoneNumber)) {
      return res.status(400).json({ success: false, message: "phoneNumber must be in 2547XXXXXXXX format." });
    }

    const tx = await fetchOrCreateQuoteTransaction({
      userAddress,
      flowType: "offramp",
      body: req.body,
      idempotencyKey,
    });

    tx.idempotencyKey = idempotencyKey;
    tx.businessId = req.body?.businessId ? String(req.body.businessId).trim() : tx.businessId;
    tx.targets = { ...tx.targets, phoneNumber };
    applyFundingDefaults(tx);
    tx.authorization = {
      pinProvided: true,
      signature: auth.signature,
      signedAt: auth.signedAt,
      nonce: auth.nonce,
    };
    const signatureMessage = verifyAuthorizationSignature({
      tx,
      userAddress,
      signature: auth.signature,
      signedAtRaw: auth.signedAtRaw,
      nonce: auth.nonce,
    });
    tx.metadata = tx.metadata || {};
    tx.metadata.extra = {
      ...(tx.metadata.extra || {}),
      authorizationMessage: signatureMessage,
    };

    assertTransition(tx, "awaiting_user_authorization", "User authorization captured", "api");
    await ensureFundingVerified({ tx, userAddress, body: req.body });
    assertTransition(tx, "mpesa_submitted", "Submitting B2C payout", "api");

    const resultUrl = buildCallbackUrl("b2c_result", tx);
    const timeoutUrl = buildCallbackUrl("b2c_timeout", tx);

    const darajaRes = await initiateB2C({
      amountKes: tx.quote.expectedReceiveKes,
      phoneNumber,
      originatorConversationId: tx.transactionId,
      remarks: "DotPay wallet cashout",
      occasion: "DotPay cashout",
      resultUrl,
      timeoutUrl,
      commandId: mpesaConfig.commands?.b2cOfframp || "BusinessPayment",
    });

    tx.daraja = {
      ...(tx.daraja || {}),
      responseCode: String(darajaRes.data?.ResponseCode || ""),
      responseDescription: darajaRes.data?.ResponseDescription || null,
      conversationId: darajaRes.data?.ConversationID || null,
      originatorConversationId: darajaRes.data?.OriginatorConversationID || tx.transactionId,
      rawRequest: {
        endpoint: "b2c",
        resultUrl,
        timeoutUrl,
      },
      rawResponse: darajaRes.data,
    };

    if (darajaRes.ok && String(darajaRes.data?.ResponseCode || "") === "0") {
      assertTransition(tx, "mpesa_processing", "B2C request accepted", "daraja");
      await tx.save();
    } else {
      assertTransition(tx, "failed", "B2C request rejected", "daraja");
      await tx.save();
      await scheduleAutoRefund(tx, "B2C request rejected");
    }

    return res.status(200).json({ success: true, data: mapTransaction(tx) });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Failed to initiate offramp." });
  }
});

/**
 * POST /api/mpesa/merchant/paybill/initiate
 */
router.post("/merchant/paybill/initiate", requireIdempotencyKey, async (req, res) => {
  try {
    if (!requireMpesaEnabled(req, res)) return;

    const userAddress = normalizeAddress(req.backendAuth.address);
    const idempotencyKey = req.idempotencyKey;

    const existing = await MpesaTransaction.findOne({ userAddress, flowType: "paybill", idempotencyKey });
    if (existing) {
      return res.status(200).json({ success: true, data: mapTransaction(existing), idempotent: true });
    }

    const auth = ensureSensitiveAuth(req.body);
    await requireUserPinVerified(userAddress, auth.pin);
    const paybillNumber = normalizeNumber(req.body?.paybillNumber);
    const accountReference = normalizeNumber(req.body?.accountReference);

    if (!/^\d{5,8}$/.test(paybillNumber)) {
      return res.status(400).json({ success: false, message: "paybillNumber must be 5-8 digits." });
    }
    if (!accountReference || accountReference.length < 2 || accountReference.length > 20) {
      return res.status(400).json({ success: false, message: "accountReference must be 2-20 characters." });
    }

    const tx = await fetchOrCreateQuoteTransaction({
      userAddress,
      flowType: "paybill",
      body: req.body,
      idempotencyKey,
    });

    tx.idempotencyKey = idempotencyKey;
    tx.businessId = req.body?.businessId ? String(req.body.businessId).trim() : tx.businessId;
    tx.targets = { ...tx.targets, paybillNumber, accountReference };
    applyFundingDefaults(tx);
    tx.authorization = {
      pinProvided: true,
      signature: auth.signature,
      signedAt: auth.signedAt,
      nonce: auth.nonce,
    };
    const signatureMessage = verifyAuthorizationSignature({
      tx,
      userAddress,
      signature: auth.signature,
      signedAtRaw: auth.signedAtRaw,
      nonce: auth.nonce,
    });
    tx.metadata = tx.metadata || {};
    tx.metadata.extra = {
      ...(tx.metadata.extra || {}),
      authorizationMessage: signatureMessage,
    };

    assertTransition(tx, "awaiting_user_authorization", "User authorization captured", "api");
    await ensureFundingVerified({ tx, userAddress, body: req.body });
    assertTransition(tx, "mpesa_submitted", "Submitting B2B paybill", "api");

    const resultUrl = buildCallbackUrl("b2b_result", tx);
    const timeoutUrl = buildCallbackUrl("b2b_timeout", tx);
    const darajaRes = await initiateB2B({
      amountKes: tx.quote.expectedReceiveKes,
      receiverNumber: paybillNumber,
      accountReference,
      originatorConversationId: tx.transactionId,
      resultUrl,
      timeoutUrl,
      commandId: mpesaConfig.commands?.b2bPaybill || "BusinessPayBill",
      remarks: "DotPay merchant paybill",
      receiverIdentifierType: "4",
      requester:
        String(req.body?.requester || "").trim() ||
        mpesaConfig.credentials?.b2bRequester ||
        "",
      initiatorNameOverride:
        mpesaConfig.credentials?.b2bPaybillInitiatorName ||
        "",
      securityCredentialOverride:
        mpesaConfig.credentials?.b2bPaybillSecurityCredential ||
        "",
    });

    tx.daraja = {
      ...(tx.daraja || {}),
      responseCode: String(darajaRes.data?.ResponseCode || ""),
      responseDescription: darajaRes.data?.ResponseDescription || null,
      conversationId: darajaRes.data?.ConversationID || null,
      originatorConversationId: darajaRes.data?.OriginatorConversationID || tx.transactionId,
      rawRequest: {
        endpoint: "b2b_paybill",
        resultUrl,
        timeoutUrl,
      },
      rawResponse: darajaRes.data,
    };

    if (darajaRes.ok && String(darajaRes.data?.ResponseCode || "") === "0") {
      assertTransition(tx, "mpesa_processing", "B2B paybill accepted", "daraja");
      await tx.save();
    } else {
      assertTransition(tx, "failed", "B2B paybill rejected", "daraja");
      await tx.save();
      await scheduleAutoRefund(tx, "B2B paybill rejected");
    }

    return res.status(200).json({ success: true, data: mapTransaction(tx) });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Failed to initiate paybill." });
  }
});

/**
 * POST /api/mpesa/merchant/buygoods/initiate
 */
router.post("/merchant/buygoods/initiate", requireIdempotencyKey, async (req, res) => {
  try {
    if (!requireMpesaEnabled(req, res)) return;

    const userAddress = normalizeAddress(req.backendAuth.address);
    const idempotencyKey = req.idempotencyKey;

    const existing = await MpesaTransaction.findOne({ userAddress, flowType: "buygoods", idempotencyKey });
    if (existing) {
      return res.status(200).json({ success: true, data: mapTransaction(existing), idempotent: true });
    }

    const auth = ensureSensitiveAuth(req.body);
    await requireUserPinVerified(userAddress, auth.pin);
    const tillNumber = normalizeNumber(req.body?.tillNumber);

    if (!/^\d{5,8}$/.test(tillNumber)) {
      return res.status(400).json({ success: false, message: "tillNumber must be 5-8 digits." });
    }

    const tx = await fetchOrCreateQuoteTransaction({
      userAddress,
      flowType: "buygoods",
      body: req.body,
      idempotencyKey,
    });

    tx.idempotencyKey = idempotencyKey;
    tx.businessId = req.body?.businessId ? String(req.body.businessId).trim() : tx.businessId;
    tx.targets = { ...tx.targets, tillNumber };
    applyFundingDefaults(tx);
    tx.authorization = {
      pinProvided: true,
      signature: auth.signature,
      signedAt: auth.signedAt,
      nonce: auth.nonce,
    };
    const signatureMessage = verifyAuthorizationSignature({
      tx,
      userAddress,
      signature: auth.signature,
      signedAtRaw: auth.signedAtRaw,
      nonce: auth.nonce,
    });
    tx.metadata = tx.metadata || {};
    tx.metadata.extra = {
      ...(tx.metadata.extra || {}),
      authorizationMessage: signatureMessage,
    };

    assertTransition(tx, "awaiting_user_authorization", "User authorization captured", "api");
    await ensureFundingVerified({ tx, userAddress, body: req.body });
    assertTransition(tx, "mpesa_submitted", "Submitting B2B buygoods", "api");

    const resultUrl = buildCallbackUrl("b2b_result", tx);
    const timeoutUrl = buildCallbackUrl("b2b_timeout", tx);

    const darajaRes = await initiateB2B({
      amountKes: tx.quote.expectedReceiveKes,
      receiverNumber: tillNumber,
      accountReference: req.body?.accountReference ? normalizeNumber(req.body.accountReference) : "DotPay",
      originatorConversationId: tx.transactionId,
      resultUrl,
      timeoutUrl,
      commandId: mpesaConfig.commands?.b2bBuygoods || "BusinessBuyGoods",
      remarks: "DotPay buy goods",
      receiverIdentifierType:
        mpesaConfig.commands?.b2bBuygoodsReceiverIdentifierType || "2",
      requester:
        String(req.body?.requester || "").trim() ||
        mpesaConfig.credentials?.b2bRequester ||
        "",
      initiatorNameOverride:
        mpesaConfig.credentials?.b2bBuygoodsInitiatorName ||
        "",
      securityCredentialOverride:
        mpesaConfig.credentials?.b2bBuygoodsSecurityCredential ||
        "",
    });

    tx.daraja = {
      ...(tx.daraja || {}),
      responseCode: String(darajaRes.data?.ResponseCode || ""),
      responseDescription: darajaRes.data?.ResponseDescription || null,
      conversationId: darajaRes.data?.ConversationID || null,
      originatorConversationId: darajaRes.data?.OriginatorConversationID || tx.transactionId,
      rawRequest: {
        endpoint: "b2b_buygoods",
        resultUrl,
        timeoutUrl,
      },
      rawResponse: darajaRes.data,
    };

    if (darajaRes.ok && String(darajaRes.data?.ResponseCode || "") === "0") {
      assertTransition(tx, "mpesa_processing", "B2B buygoods accepted", "daraja");
      await tx.save();
    } else {
      assertTransition(tx, "failed", "B2B buygoods rejected", "daraja");
      await tx.save();
      await scheduleAutoRefund(tx, "B2B buygoods rejected");
    }

    return res.status(200).json({ success: true, data: mapTransaction(tx) });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Failed to initiate buygoods." });
  }
});

/**
 * GET /api/mpesa/transactions/:id
 */
router.get("/transactions/:id", async (req, res) => {
  try {
    const userAddress = normalizeAddress(req.backendAuth.address);
    const id = String(req.params.id || "").trim().toUpperCase();

    const tx = await MpesaTransaction.findOne({
      transactionId: id,
      userAddress,
    });

    if (!tx) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    return res.status(200).json({ success: true, data: mapTransaction(tx) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load transaction." });
  }
});

/**
 * GET /api/mpesa/transactions
 */
router.get("/transactions", async (req, res) => {
  try {
    const userAddress = normalizeAddress(req.backendAuth.address);
    const flowType = String(req.query.flowType || "").trim().toLowerCase();
    const status = String(req.query.status || "").trim();
    const limitRaw = Number.parseInt(String(req.query.limit || "20"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

    const query = { userAddress };
    if (FLOWS.includes(flowType)) query.flowType = flowType;
    if (status) query.status = status;

    const list = await MpesaTransaction.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);

    return res.status(200).json({
      success: true,
      data: {
        transactions: list.map(mapTransaction),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to list transactions." });
  }
});

module.exports = router;
