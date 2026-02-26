const mongoose = require("mongoose");

const FLOW_TYPES = ["onramp", "offramp", "paybill", "buygoods"];
const STATUSES = [
  "created",
  "quoted",
  "awaiting_user_authorization",
  "awaiting_onchain_funding",
  "mpesa_submitted",
  "mpesa_processing",
  "succeeded",
  "failed",
  "refund_pending",
  "refunded",
];

function generateTransactionId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `MPX${Date.now().toString(36).toUpperCase()}${rand}`;
}

const mpesaTransactionSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
      default: generateTransactionId,
      trim: true,
      uppercase: true,
      index: true,
    },
    flowType: {
      type: String,
      required: true,
      enum: FLOW_TYPES,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: STATUSES,
      default: "created",
      index: true,
    },
    userAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    businessId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      default: undefined,
      trim: true,
      index: true,
    },
    quote: {
      quoteId: { type: String, default: null, trim: true, index: true },
      currency: { type: String, enum: ["KES", "USD"], default: "KES" },
      amountRequested: { type: Number, min: 0 },
      amountKes: { type: Number, min: 0 },
      amountUsd: { type: Number, min: 0 },
      rateKesPerUsd: { type: Number, min: 0 },
      feeAmountKes: { type: Number, min: 0 },
      networkFeeKes: { type: Number, min: 0 },
      totalDebitKes: { type: Number, min: 0 },
      expectedReceiveKes: { type: Number, min: 0 },
      expiresAt: { type: Date, default: null },
      snapshotAt: { type: Date, default: null },
    },
    targets: {
      phoneNumber: { type: String, default: null, trim: true },
      paybillNumber: { type: String, default: null, trim: true },
      tillNumber: { type: String, default: null, trim: true },
      accountReference: { type: String, default: null, trim: true },
    },
    authorization: {
      pinProvided: { type: Boolean, default: false },
      signature: { type: String, default: null, trim: true },
      signedAt: { type: Date, default: null },
      nonce: { type: String, default: null, trim: true },
      signerAddress: { type: String, default: null, trim: true, lowercase: true },
    },
    onchain: {
      txHash: { type: String, default: null, trim: true, lowercase: true },
      chainId: { type: Number, default: null },
      required: { type: Boolean, default: false },
      verificationStatus: {
        type: String,
        enum: ["not_required", "pending", "verified", "failed"],
        default: "not_required",
      },
      tokenAddress: { type: String, default: null, trim: true, lowercase: true },
      tokenSymbol: { type: String, default: "USDC", trim: true },
      treasuryAddress: { type: String, default: null, trim: true, lowercase: true },
      expectedAmountUsd: { type: Number, min: 0, default: 0 },
      expectedAmountUnits: { type: String, default: null, trim: true },
      fundedAmountUsd: { type: Number, min: 0, default: 0 },
      fundedAmountUnits: { type: String, default: null, trim: true },
      fromAddress: { type: String, default: null, trim: true, lowercase: true },
      toAddress: { type: String, default: null, trim: true, lowercase: true },
      logIndex: { type: Number, default: null },
      verifiedBy: { type: String, default: null, trim: true },
      verificationError: { type: String, default: null, trim: true },
      verifiedAt: { type: Date, default: null },
    },
    daraja: {
      merchantRequestId: { type: String, default: null, trim: true },
      checkoutRequestId: { type: String, default: null, trim: true, index: true },
      conversationId: { type: String, default: null, trim: true, index: true },
      originatorConversationId: { type: String, default: null, trim: true, index: true },
      responseCode: { type: String, default: null, trim: true },
      responseDescription: { type: String, default: null, trim: true },
      resultCode: { type: Number, default: null },
      // Some Daraja APIs return non-numeric codes (e.g. "SFC_IC0003").
      resultCodeRaw: { type: String, default: null, trim: true },
      resultDesc: { type: String, default: null, trim: true },
      receiptNumber: { type: String, default: null, trim: true, index: true },
      customerMessage: { type: String, default: null, trim: true },
      rawRequest: { type: mongoose.Schema.Types.Mixed, default: null },
      rawResponse: { type: mongoose.Schema.Types.Mixed, default: null },
      rawCallback: { type: mongoose.Schema.Types.Mixed, default: null },
      callbackReceivedAt: { type: Date, default: null },
    },
    refund: {
      status: {
        type: String,
        enum: ["none", "pending", "completed", "failed"],
        default: "none",
      },
      reason: { type: String, default: null, trim: true },
      txHash: { type: String, default: null, trim: true },
      initiatedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
    },
    history: [
      {
        from: { type: String, default: null },
        to: { type: String, required: true },
        reason: { type: String, default: null },
        source: { type: String, default: "system" },
        at: { type: Date, default: Date.now },
      },
    ],
    metadata: {
      source: { type: String, default: "web" },
      ipAddress: { type: String, default: null },
      userAgent: { type: String, default: null },
      tags: [{ type: String }],
      extra: { type: mongoose.Schema.Types.Mixed, default: null },
    },
  },
  {
    timestamps: true,
  }
);

mpesaTransactionSchema.index({ userAddress: 1, createdAt: -1 });
mpesaTransactionSchema.index({ flowType: 1, status: 1, createdAt: -1 });
mpesaTransactionSchema.index(
  { "onchain.txHash": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "onchain.txHash": { $type: "string" },
    },
  }
);
mpesaTransactionSchema.index(
  { userAddress: 1, flowType: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
    },
  }
);

module.exports = {
  MpesaTransaction: mongoose.model("MpesaTransaction", mpesaTransactionSchema),
  FLOW_TYPES,
  STATUSES,
};
