const test = require("node:test");
const assert = require("node:assert/strict");

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function freshRefundService() {
  freshRequire("../src/config/mpesa");
  return freshRequire("../src/services/mpesa/refundService");
}

function buildTx(overrides = {}) {
  return {
    flowType: "offramp",
    status: "failed",
    userAddress: "0x3333333333333333333333333333333333333333",
    quote: { amountUsd: 12.5 },
    history: [],
    refund: { status: "none" },
    saved: false,
    async save() {
      this.saved = true;
      return this;
    },
    ...overrides,
  };
}

test("scheduleAutoRefund uses sandbox simulated refund when treasury is not configured", async () => {
  process.env.MPESA_AUTO_REFUND = "true";
  process.env.MPESA_ENV = "sandbox";
  process.env.TREASURY_RPC_URL = "";
  process.env.TREASURY_PRIVATE_KEY = "";
  process.env.TREASURY_USDC_CONTRACT = "";

  const { scheduleAutoRefund } = freshRefundService();
  const tx = buildTx();
  await scheduleAutoRefund(tx, "test refund");

  assert.equal(tx.saved, true);
  assert.equal(tx.status, "refunded");
  assert.equal(tx.refund.status, "completed");
  assert.match(String(tx.refund.txHash || ""), /^RF_/);
});

test("scheduleAutoRefund skips non-eligible flow", async () => {
  process.env.MPESA_AUTO_REFUND = "true";
  process.env.MPESA_ENV = "sandbox";

  const { scheduleAutoRefund } = freshRefundService();
  const tx = buildTx({ flowType: "onramp" });
  await scheduleAutoRefund(tx, "should skip");

  assert.equal(tx.saved, false);
  assert.equal(tx.status, "failed");
  assert.equal(tx.refund.status, "none");
});

