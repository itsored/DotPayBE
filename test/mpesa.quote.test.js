const test = require("node:test");
const assert = require("node:assert/strict");

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test("buildQuote computes expected KES quote fields", () => {
  process.env.MPESA_QUOTE_TTL_SECONDS = "120";
  freshRequire("../src/config/mpesa");
  const { buildQuote } = freshRequire("../src/services/mpesa/quoteService");

  const quote = buildQuote({
    flowType: "onramp",
    amount: 1000,
    currency: "KES",
  });

  assert.equal(quote.currency, "KES");
  assert.equal(quote.amountRequested, 1000);
  assert.equal(quote.amountKes, 1000);
  assert.equal(quote.expectedReceiveKes, 1000);
  assert.equal(quote.feeAmountKes, 0);
  assert.equal(quote.networkFeeKes, 0);
  assert.equal(quote.totalDebitKes, quote.amountKes);
  assert.ok(quote.expiresAt);
  assert.ok(quote.snapshotAt);

  const ttlSeconds = Math.round(
    (new Date(quote.expiresAt).getTime() - new Date(quote.snapshotAt).getTime()) / 1000
  );
  assert.ok(ttlSeconds >= 119 && ttlSeconds <= 121);
});

test("buildQuote handles USD input and explicit rate", () => {
  const { buildQuote } = freshRequire("../src/services/mpesa/quoteService");
  const quote = buildQuote({
    flowType: "offramp",
    amount: 10,
    currency: "USD",
    kesPerUsd: 155,
  });

  assert.equal(quote.currency, "USD");
  assert.equal(quote.amountRequested, 10);
  assert.equal(quote.amountUsd, 10);
  assert.equal(quote.amountKes, 1550);
  assert.equal(quote.rateKesPerUsd, 155);
  assert.equal(quote.feeAmountKes, 0);
  assert.equal(quote.networkFeeKes, 0);
  assert.equal(quote.totalDebitKes, quote.amountKes);
});
