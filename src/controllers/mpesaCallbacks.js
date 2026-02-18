const MpesaTransaction = require("../models/MpesaTransaction");
const { verifyCallbackToken } = require("../services/mpesa");

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

function parseStkMetadata(stkCallback) {
  const items = Array.isArray(stkCallback?.CallbackMetadata?.Item) ? stkCallback.CallbackMetadata.Item : [];
  const byName = new Map(items.map((item) => [item?.Name, item?.Value]));
  return {
    mpesaReceiptNumber: byName.get("MpesaReceiptNumber") || null,
    phoneNumber: byName.get("PhoneNumber") ? String(byName.get("PhoneNumber")) : null,
  };
}

function rejectInvalidCallbackToken(req, res) {
  if (!verifyCallbackToken(req)) {
    fail(res, 401, "Unauthorized callback token");
    return true;
  }
  return false;
}

async function stkCallback(req, res) {
  if (rejectInvalidCallbackToken(req, res)) return;

  const stk = req.body?.Body?.stkCallback;
  if (!stk) {
    return success(res, "Callback acknowledged");
  }

  const checkoutRequestId = stk.CheckoutRequestID || null;
  const merchantRequestId = stk.MerchantRequestID || null;
  const resultCode = Number.parseInt(String(stk.ResultCode ?? "1"), 10);
  const resultDesc = String(stk.ResultDesc || "").trim() || null;
  const metadata = parseStkMetadata(stk);

  const query = [];
  if (checkoutRequestId) query.push({ checkoutRequestId });
  if (merchantRequestId) query.push({ merchantRequestId });

  if (query.length > 0) {
    await MpesaTransaction.findOneAndUpdate(
      { $or: query },
      {
        $set: {
          status: resultCode === 0 ? "completed" : "failed",
          resultCode,
          resultDesc,
          mpesaReceiptNumber: metadata.mpesaReceiptNumber || null,
          callbackPayload: req.body,
          phoneNumber: metadata.phoneNumber || undefined,
        },
      }
    );
  }

  return success(res, "Callback acknowledged");
}

async function b2cCallback(req, res) {
  if (rejectInvalidCallbackToken(req, res)) return;

  const result = req.body?.Result;
  if (!result) return success(res, "Callback acknowledged");

  const conversationId = result.ConversationID || null;
  const originatorConversationId = result.OriginatorConversationID || null;
  const resultCode = Number.parseInt(String(result.ResultCode ?? "1"), 10);
  const resultDesc = String(result.ResultDesc || "").trim() || null;

  const query = [];
  if (conversationId) query.push({ conversationId });
  if (originatorConversationId) query.push({ originatorConversationId });

  if (query.length > 0) {
    await MpesaTransaction.findOneAndUpdate(
      { $or: query },
      {
        $set: {
          status: resultCode === 0 ? "completed" : "failed",
          resultCode,
          resultDesc,
          callbackPayload: req.body,
        },
      }
    );
  }

  return success(res, "Callback acknowledged");
}

async function b2bCallback(req, res) {
  if (rejectInvalidCallbackToken(req, res)) return;

  const result = req.body?.Result;
  if (!result) return success(res, "Callback acknowledged");

  const conversationId = result.ConversationID || null;
  const originatorConversationId = result.OriginatorConversationID || null;
  const resultCode = Number.parseInt(String(result.ResultCode ?? "1"), 10);
  const resultDesc = String(result.ResultDesc || "").trim() || null;

  const query = [];
  if (conversationId) query.push({ conversationId });
  if (originatorConversationId) query.push({ originatorConversationId });

  if (query.length > 0) {
    await MpesaTransaction.findOneAndUpdate(
      { $or: query },
      {
        $set: {
          status: resultCode === 0 ? "completed" : "failed",
          resultCode,
          resultDesc,
          callbackPayload: req.body,
        },
      }
    );
  }

  return success(res, "Callback acknowledged");
}

async function queueTimeoutCallback(req, res) {
  if (rejectInvalidCallbackToken(req, res)) return;

  const result = req.body?.Result || req.body || {};
  const conversationId = result.ConversationID || null;
  const originatorConversationId = result.OriginatorConversationID || null;
  const query = [];
  if (conversationId) query.push({ conversationId });
  if (originatorConversationId) query.push({ originatorConversationId });

  if (query.length > 0) {
    await MpesaTransaction.findOneAndUpdate(
      { $or: query },
      {
        $set: {
          status: "timeout",
          resultDesc: "Queue timeout",
          callbackPayload: req.body,
        },
      }
    );
  }

  return success(res, "Timeout callback acknowledged");
}

module.exports = {
  stkCallback,
  b2cCallback,
  b2bCallback,
  queueTimeoutCallback,
};

