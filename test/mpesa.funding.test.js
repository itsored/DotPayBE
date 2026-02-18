const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateExpectedFundingFromQuote,
} = require("../src/services/settlement/verifyUsdcFunding");

test("calculateExpectedFundingFromQuote computes USDC debit from totalDebitKes/rate", () => {
  const quote = {
    totalDebitKes: 1550,
    rateKesPerUsd: 155,
  };

  const result = calculateExpectedFundingFromQuote(quote, 6);
  assert.equal(result.expectedUnitsString, "10000000");
  assert.equal(result.expectedUsd, 10);
});

test("calculateExpectedFundingFromQuote rounds up to protect treasury debit floor", () => {
  const quote = {
    totalDebitKes: 1000.03,
    rateKesPerUsd: 155,
  };

  const result = calculateExpectedFundingFromQuote(quote, 6);
  assert.ok(Number(result.expectedUsd) > 6.4518);
  assert.ok(BigInt(result.expectedUnitsString) > 0n);
});
