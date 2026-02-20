const test = require("node:test");
const assert = require("node:assert/strict");

const { assertPinFormat, hashPin, verifyPin } = require("../src/services/security/pin");

test("assertPinFormat enforces exactly 6 digits", () => {
  assert.equal(assertPinFormat("123456", 6), "123456");
  assert.equal(assertPinFormat(" 12 34 56 ", 6), "123456");

  assert.throws(() => assertPinFormat("", 6));
  assert.throws(() => assertPinFormat("1234", 6));
  assert.throws(() => assertPinFormat("1234567", 6));
  assert.throws(() => assertPinFormat("12ab56", 6));
});

test("hashPin + verifyPin roundtrip", () => {
  const h = hashPin("123456", { length: 6 });
  assert.ok(h.startsWith("scrypt$"));

  assert.equal(verifyPin("123456", h, { length: 6 }), true);
  assert.equal(verifyPin("000000", h, { length: 6 }), false);
});

