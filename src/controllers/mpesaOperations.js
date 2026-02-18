const { randomUUID } = require("crypto");

const MpesaTransaction = require("../models/MpesaTransaction");
const {
  normalizeMsisdn,
  isValidKenyanMsisdn,
  initiateStkPush,
  initiateB2CPayment,
  initiateB2BPayment,
} = require("../services/mpesa");

const RECEIPT_REGEX = /^[A-Z0-9]{10}$/i;
const DIGITS_REGEX = /^[0-9]+$/;
const DEFAULT_KES_PER_USD = Number.parseFloat(process.env.KES_PER_USD || "130");

function nowIso() {
  return new Date().toISOString();
}

function success(res, message, data = null, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: nowIso(),
  });
}

function fail(res, statusCode, message, error = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    error,
    timestamp: nowIso(),
  });
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  if (clone.SecurityCredential) clone.SecurityCredential = "***";
  if (clone.Password) clone.Password = "***";
  return clone;
}

function parseAmount(value, { min = 1, max = 150000 } = {}) {
  const amount = Number.parseFloat(String(value));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount < min || amount > max) return null;
  return Math.round(amount);
}

function extractPhone(body) {
  return normalizeMsisdn(body?.phone || body?.phoneNumber);
}

function normalizeTargetNumber(value) {
  const normalized = String(value || "").trim();
  return DIGITS_REGEX.test(normalized) ? normalized : "";
}

async function createTransaction(input) {
  const tx = new MpesaTransaction(input);
  await tx.save();
  return tx;
}

async function updateTransactionById(id, patch) {
  return MpesaTransaction.findOneAndUpdate({ transactionId: id }, patch, { new: true });
}

async function handleC2BStk({ req, res, product, accountReference, transactionDesc }) {
  const amount = parseAmount(req.body?.amount, { min: 10, max: 150000 });
  const phoneNumber = extractPhone(req.body);

  if (!amount) {
    return fail(res, 400, "Invalid amount. Must be between 10 and 150000 KES.");
  }
  if (!phoneNumber || !isValidKenyanMsisdn(phoneNumber)) {
    return fail(res, 400, "Invalid phone number. Use format 2547XXXXXXXX or 2541XXXXXXXX.");
  }

  const transactionId = randomUUID();
  const chain = req.body?.chain ? String(req.body.chain).trim().toLowerCase() : null;
  const tokenType = req.body?.tokenType ? String(req.body.tokenType).trim().toUpperCase() : null;
  const kesPerUsd = Number.isFinite(DEFAULT_KES_PER_USD) && DEFAULT_KES_PER_USD > 0 ? DEFAULT_KES_PER_USD : 130;
  const cryptoAmount = Number((amount / kesPerUsd).toFixed(6));

  await createTransaction({
    transactionId,
    flow: "C2B",
    product,
    status: "pending",
    amount,
    phoneNumber,
    chain,
    tokenType,
    requestPayload: sanitizePayload({
      amount,
      phoneNumber,
      chain,
      tokenType,
      accountReference,
      transactionDesc,
    }),
  });

  try {
    const result = await initiateStkPush({
      amount,
      phoneNumber,
      accountReference,
      transactionDesc,
      transactionId,
    });
    const response = result?.response || {};
    const responseCode = String(response?.ResponseCode || "");

    const patch = {
      status: responseCode === "0" ? "processing" : "failed",
      merchantRequestId: response?.MerchantRequestID || null,
      checkoutRequestId: response?.CheckoutRequestID || null,
      resultCode: responseCode === "0" ? 0 : 1,
      resultDesc: response?.ResponseDescription || response?.errorMessage || null,
      responsePayload: sanitizePayload(response),
    };
    await updateTransactionById(transactionId, patch);

    return success(res, "M-Pesa request accepted", {
      transactionId,
      status: patch.status,
      mpesaAmount: amount,
      cryptoAmount,
      tokenType: tokenType || "USDC",
      chain: chain || "unknown",
      merchantRequestId: patch.merchantRequestId,
      checkoutRequestId: patch.checkoutRequestId,
      customerMessage: response?.CustomerMessage || "Check your phone to complete payment.",
      estimatedCompletionTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    console.error(`M-Pesa ${product} STK error:`, error?.message || error);
    await updateTransactionById(transactionId, {
      status: "failed",
      resultDesc: error?.message || "Failed to initiate STK push",
      responsePayload: sanitizePayload(error?.payload || null),
    });
    return fail(res, 502, "Failed to initiate M-Pesa payment", {
      code: "STK_PUSH_FAILED",
      message: error?.message || "STK push failed",
    });
  }
}

async function handleB2C({ req, res, product }) {
  const amount = parseAmount(req.body?.amount, { min: 10, max: 150000 });
  const phoneNumber = extractPhone(req.body);

  if (!amount) {
    return fail(res, 400, "Invalid amount. Must be between 10 and 150000 KES.");
  }
  if (!phoneNumber || !isValidKenyanMsisdn(phoneNumber)) {
    return fail(res, 400, "Invalid phone number.");
  }

  const transactionId = randomUUID();
  const tokenType = req.body?.tokenType ? String(req.body.tokenType).trim().toUpperCase() : "USDC";
  const chain = req.body?.chain ? String(req.body.chain).trim().toLowerCase() : null;

  await createTransaction({
    transactionId,
    flow: "B2C",
    product,
    status: "pending",
    amount,
    phoneNumber,
    tokenType,
    chain,
    requestPayload: sanitizePayload({
      amount,
      phoneNumber,
      tokenType,
      chain,
      remarks: req.body?.description || req.body?.remarks || null,
    }),
  });

  try {
    const result = await initiateB2CPayment({
      amount,
      phoneNumber,
      remarks: req.body?.description || req.body?.remarks || "DotPay withdrawal",
      occasion: req.body?.occasion || "DotPay",
      commandId: req.body?.commandId || "BusinessPayment",
    });
    const response = result?.response || {};
    const responseCode = String(response?.ResponseCode || "");

    const patch = {
      status: responseCode === "0" ? "processing" : "failed",
      conversationId: response?.ConversationID || null,
      originatorConversationId: response?.OriginatorConversationID || null,
      resultCode: responseCode === "0" ? 0 : 1,
      resultDesc: response?.ResponseDescription || response?.errorMessage || null,
      responsePayload: sanitizePayload(response),
    };
    await updateTransactionById(transactionId, patch);

    return success(res, "B2C request accepted", {
      transactionId,
      status: patch.status,
      amount,
      mpesaTransactionId: patch.conversationId,
      originatorConversationId: patch.originatorConversationId,
      transactionDetails: {
        type: "B2C",
        recipientPhone: phoneNumber,
        tokenType,
        chain: chain || "unknown",
      },
      estimatedCompletionTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    console.error(`M-Pesa ${product} B2C error:`, error?.message || error);
    await updateTransactionById(transactionId, {
      status: "failed",
      resultDesc: error?.message || "Failed to initiate B2C payment",
      responsePayload: sanitizePayload(error?.payload || null),
    });
    return fail(res, 502, "Failed to initiate B2C payment", {
      code: "B2C_REQUEST_FAILED",
      message: error?.message || "B2C request failed",
    });
  }
}

async function handleB2B({ req, res, product, commandId, targetNumber, accountNumber, remarks }) {
  const amount = parseAmount(req.body?.amount, { min: 10, max: 150000 });
  if (!amount) {
    return fail(res, 400, "Invalid amount. Must be between 10 and 150000 KES.");
  }

  const normalizedTarget = normalizeTargetNumber(targetNumber);
  if (!normalizedTarget || normalizedTarget.length < 5 || normalizedTarget.length > 7) {
    return fail(res, 400, "Invalid target number. Expected 5-7 digit paybill/till number.");
  }

  const transactionId = randomUUID();
  await createTransaction({
    transactionId,
    flow: "B2B",
    product,
    status: "pending",
    amount,
    targetNumber: normalizedTarget,
    accountNumber: accountNumber || null,
    chain: req.body?.chain ? String(req.body.chain).trim().toLowerCase() : null,
    tokenType: req.body?.tokenType ? String(req.body.tokenType).trim().toUpperCase() : null,
    requestPayload: sanitizePayload({
      amount,
      targetNumber: normalizedTarget,
      accountNumber: accountNumber || null,
      commandId,
      remarks,
    }),
  });

  try {
    const result = await initiateB2BPayment({
      amount,
      targetNumber: normalizedTarget,
      accountNumber,
      remarks,
      commandId,
    });

    const response = result?.response || {};
    const responseCode = String(response?.ResponseCode || "");
    const patch = {
      status: responseCode === "0" ? "processing" : "failed",
      conversationId: response?.ConversationID || null,
      originatorConversationId: response?.OriginatorConversationID || null,
      resultCode: responseCode === "0" ? 0 : 1,
      resultDesc: response?.ResponseDescription || response?.errorMessage || null,
      responsePayload: sanitizePayload(response),
    };
    await updateTransactionById(transactionId, patch);

    return success(res, "B2B request accepted", {
      transactionId,
      status: patch.status,
      amount,
      mpesaTransactionId: patch.conversationId,
      originatorConversationId: patch.originatorConversationId,
      transactionDetails: {
        targetNumber: normalizedTarget,
        accountNumber: accountNumber || null,
        commandId,
      },
      cryptoTransactionHash: null,
    });
  } catch (error) {
    console.error(`M-Pesa ${product} B2B error:`, error?.message || error);
    await updateTransactionById(transactionId, {
      status: "failed",
      resultDesc: error?.message || "Failed to initiate B2B payment",
      responsePayload: sanitizePayload(error?.payload || null),
    });
    return fail(res, 502, "Failed to initiate B2B payment", {
      code: "B2B_REQUEST_FAILED",
      message: error?.message || "B2B request failed",
    });
  }
}

async function deposit(req, res) {
  return handleC2BStk({
    req,
    res,
    product: "deposit",
    accountReference: "DOTPAY-DEPOSIT",
    transactionDesc: "DotPay deposit",
  });
}

async function buyCrypto(req, res) {
  return handleC2BStk({
    req,
    res,
    product: "buy_crypto",
    accountReference: `BUY-${String(req.body?.tokenType || "USDC").toUpperCase()}`,
    transactionDesc: "DotPay buy crypto",
  });
}

async function payPaybill(req, res) {
  const targetNumber = req.body?.businessNumber || req.body?.paybillNumber;
  const accountNumber = req.body?.accountNumber ? String(req.body.accountNumber).trim() : "";
  if (!accountNumber) {
    return fail(res, 400, "accountNumber is required for paybill.");
  }
  return handleB2B({
    req,
    res,
    product: "paybill",
    commandId: "BusinessPayBill",
    targetNumber,
    accountNumber,
    remarks: req.body?.description || "DotPay paybill settlement",
  });
}

async function payTill(req, res) {
  return handleB2B({
    req,
    res,
    product: "till",
    commandId: "BusinessBuyGoods",
    targetNumber: req.body?.tillNumber,
    accountNumber: req.body?.accountNumber || "DotPay",
    remarks: req.body?.description || "DotPay till settlement",
  });
}

async function payWithCrypto(req, res) {
  const targetType = String(req.body?.targetType || "").trim().toLowerCase();
  const targetNumber = req.body?.targetNumber;
  const accountNumber = req.body?.accountNumber ? String(req.body.accountNumber).trim() : "";

  if (!["paybill", "till"].includes(targetType)) {
    return fail(res, 400, "targetType must be paybill or till.");
  }
  if (targetType === "paybill" && !accountNumber) {
    return fail(res, 400, "accountNumber is required for paybill targetType.");
  }

  return handleB2B({
    req,
    res,
    product: "pay_with_crypto",
    commandId: targetType === "paybill" ? "BusinessPayBill" : "BusinessBuyGoods",
    targetNumber,
    accountNumber: targetType === "paybill" ? accountNumber : req.body?.accountNumber || "DotPay",
    remarks: req.body?.description || "DotPay pay with crypto",
  });
}

async function withdraw(req, res) {
  return handleB2C({ req, res, product: "withdraw" });
}

async function cryptoToMpesa(req, res) {
  return handleB2C({ req, res, product: "crypto_to_mpesa" });
}

async function submitReceipt(req, res) {
  const transactionId = String(req.body?.transactionId || "").trim();
  const receipt = String(req.body?.mpesaReceiptNumber || "")
    .trim()
    .toUpperCase();

  if (!transactionId) {
    return fail(res, 400, "transactionId is required.");
  }
  if (!RECEIPT_REGEX.test(receipt)) {
    return fail(res, 400, "mpesaReceiptNumber must be 10 alphanumeric characters.");
  }

  const tx = await MpesaTransaction.findOneAndUpdate(
    { transactionId },
    { $set: { mpesaReceiptNumber: receipt, status: "completed" } },
    { new: true }
  );

  if (!tx) {
    return fail(res, 404, "Transaction not found.");
  }

  return success(res, "Receipt saved", {
    transactionId: tx.transactionId,
    status: tx.status,
    mpesaReceiptNumber: tx.mpesaReceiptNumber,
  });
}

async function getTransactionStatus(req, res) {
  const transactionId = String(req.params.transactionId || "").trim();
  if (!transactionId) return fail(res, 400, "transactionId is required.");

  const tx = await MpesaTransaction.findOne({ transactionId }).lean();
  if (!tx) return fail(res, 404, "Transaction not found.");

  return success(res, "Transaction fetched", {
    transactionId: tx.transactionId,
    flow: tx.flow,
    product: tx.product,
    status: tx.status,
    amount: tx.amount,
    phoneNumber: tx.phoneNumber,
    targetNumber: tx.targetNumber,
    accountNumber: tx.accountNumber,
    tokenType: tx.tokenType,
    chain: tx.chain,
    mpesaReceiptNumber: tx.mpesaReceiptNumber,
    resultCode: tx.resultCode,
    resultDesc: tx.resultDesc,
    mpesaTransactionId: tx.conversationId || tx.checkoutRequestId || null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  });
}

module.exports = {
  deposit,
  buyCrypto,
  payPaybill,
  payTill,
  payWithCrypto,
  withdraw,
  cryptoToMpesa,
  submitReceipt,
  getTransactionStatus,
};

