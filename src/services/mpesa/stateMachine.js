const { STATUSES } = require("../../models/MpesaTransaction");

const ALLOWED_TRANSITIONS = {
  created: ["quoted", "awaiting_user_authorization", "failed"],
  quoted: ["awaiting_user_authorization", "mpesa_submitted", "failed"],
  awaiting_user_authorization: ["awaiting_onchain_funding", "mpesa_submitted", "failed"],
  awaiting_onchain_funding: ["mpesa_submitted", "failed"],
  mpesa_submitted: ["mpesa_processing", "succeeded", "failed"],
  mpesa_processing: ["succeeded", "failed"],
  succeeded: [],
  failed: ["refund_pending", "refunded"],
  refund_pending: ["refunded", "failed"],
  refunded: [],
};

function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function assertTransition(transaction, to, reason, source = "system") {
  const from = transaction.status;
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} -> ${to}`);
  }

  if (from !== to) {
    transaction.history = transaction.history || [];
    transaction.history.push({
      from,
      to,
      reason: reason || null,
      source,
      at: new Date(),
    });
    transaction.status = to;
  }
}

module.exports = {
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
};
