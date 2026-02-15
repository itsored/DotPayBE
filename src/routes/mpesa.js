const express = require("express");
const crypto = require("crypto");
const { connectDB } = require("../config/db");
const { mpesaConfig } = require("../config/mpesa");
const { MpesaTransaction } = require("../models/MpesaTransaction");
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

const router = express.Router();

const FLOWS = ["onramp", "offramp", "paybill", "buygoods"];

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
  if (!pin || pin.length < mpesaConfig.security.pinMinLength) {
    throw new Error(`pin is required and must be at least ${mpesaConfig.security.pinMinLength} digits.`);
  }
  if (!/^\d+$/.test(pin)) {
    throw new Error("pin must contain digits only.");
  }
  if (!signature || signature.length < 24) {
    throw new Error("signature is required.");
  }
  const signedAt = body?.signedAt ? new Date(body.signedAt) : new Date();
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
    nonce: String(body?.nonce || "").trim() || null,
  };
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

      if (tx.status === "mpesa_processing" && tx.updatedAt <= cutoff) {
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
    tx.authorization = {
      pinProvided: true,
      signature: auth.signature,
      signedAt: auth.signedAt,
      nonce: auth.nonce,
    };

    const onchainTxHash = String(req.body?.onchainTxHash || "").trim().toLowerCase();
    if (onchainTxHash) {
      tx.onchain = {
        txHash: onchainTxHash,
        chainId: req.body?.chainId ? Number(req.body.chainId) : null,
        verifiedAt: new Date(),
      };
    }

    assertTransition(tx, "awaiting_user_authorization", "User authorization captured", "api");
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
      // Prefer BusinessPayment as a sensible default; sandbox docs also accept SalaryPayment.
      commandId: "BusinessPayment",
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
    tx.authorization = {
      pinProvided: true,
      signature: auth.signature,
      signedAt: auth.signedAt,
      nonce: auth.nonce,
    };

    assertTransition(tx, "awaiting_user_authorization", "User authorization captured", "api");
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
      commandId: "BusinessPayBill",
      remarks: "DotPay merchant paybill",
      receiverIdentifierType: "4",
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
    tx.authorization = {
      pinProvided: true,
      signature: auth.signature,
      signedAt: auth.signedAt,
      nonce: auth.nonce,
    };

    assertTransition(tx, "awaiting_user_authorization", "User authorization captured", "api");
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
      commandId: "BusinessBuyGoods",
      remarks: "DotPay buy goods",
      // Till numbers use identifier type 2 in B2B.
      receiverIdentifierType: "2",
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
