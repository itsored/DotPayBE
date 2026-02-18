const test = require("node:test");
const assert = require("node:assert/strict");

const { canTransition, assertTransition } = require("../src/services/mpesa/stateMachine");

test("canTransition allows expected transitions", () => {
  assert.equal(canTransition("quoted", "mpesa_submitted"), true);
  assert.equal(canTransition("mpesa_processing", "succeeded"), true);
  assert.equal(canTransition("failed", "refund_pending"), true);
});

test("assertTransition updates status and history", () => {
  const tx = {
    status: "quoted",
    history: [],
  };

  assertTransition(tx, "mpesa_submitted", "submit", "test");
  assert.equal(tx.status, "mpesa_submitted");
  assert.equal(tx.history.length, 1);
  assert.equal(tx.history[0].from, "quoted");
  assert.equal(tx.history[0].to, "mpesa_submitted");
});

test("assertTransition rejects invalid transition", () => {
  const tx = {
    status: "succeeded",
    history: [],
  };

  assert.throws(() => {
    assertTransition(tx, "failed", "should fail", "test");
  }, /Invalid status transition/);
});

