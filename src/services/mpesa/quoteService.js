const crypto = require("crypto");
const { mpesaConfig } = require("../../config/mpesa");

const FEE_BPS_BY_FLOW = {
  onramp: 130,
  offramp: 180,
  paybill: 120,
  buygoods: 120,
};

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function toPositiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return n;
}

function generateQuoteId() {
  return `Q${Date.now().toString(36).toUpperCase()}${crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
}

function buildQuote({ flowType, amount, currency = "KES", kesPerUsd }) {
  const amountRequested = toPositiveNumber(amount, "amount");
  const normalizedCurrency = String(currency || "KES").toUpperCase();
  if (!["KES", "USD"].includes(normalizedCurrency)) {
    throw new Error("currency must be KES or USD.");
  }

  const rateKesPerUsd =
    Number.isFinite(Number(kesPerUsd)) && Number(kesPerUsd) > 0
      ? Number(kesPerUsd)
      : Number(mpesaConfig.quote?.defaultRateKesPerUsd || 130);

  const amountKes =
    normalizedCurrency === "KES"
      ? amountRequested
      : round2(amountRequested * rateKesPerUsd);
  const amountUsd =
    normalizedCurrency === "USD"
      ? amountRequested
      : round2(amountRequested / rateKesPerUsd);

  const feeBps = FEE_BPS_BY_FLOW[flowType] ?? 150;
  const feeAmountKes = round2(Math.max(5, (amountKes * feeBps) / 10000));
  const networkFeeKes = round2(flowType === "onramp" ? 0 : 3);
  const totalDebitKes = round2(amountKes + feeAmountKes + networkFeeKes);
  const expectedReceiveKes = round2(amountKes);

  const ttlMs = mpesaConfig.quote.ttlSeconds * 1000;
  const now = new Date();

  return {
    quoteId: generateQuoteId(),
    currency: normalizedCurrency,
    amountRequested: round2(amountRequested),
    amountKes,
    amountUsd,
    rateKesPerUsd: round2(rateKesPerUsd),
    feeAmountKes,
    networkFeeKes,
    totalDebitKes,
    expectedReceiveKes,
    expiresAt: new Date(now.getTime() + ttlMs),
    snapshotAt: now,
  };
}

function isQuoteExpired(quote) {
  if (!quote?.expiresAt) return true;
  return new Date(quote.expiresAt).getTime() < Date.now();
}

module.exports = {
  FEE_BPS_BY_FLOW,
  buildQuote,
  isQuoteExpired,
};
