const test = require("node:test");
const assert = require("node:assert/strict");

const { requireIdempotencyKey } = require("../src/middleware/idempotency");

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("requireIdempotencyKey accepts valid key", () => {
  const req = {
    get(name) {
      if (String(name).toLowerCase() === "idempotency-key") return "offramp:test-key-001";
      return "";
    },
  };
  const res = createRes();
  let called = false;
  requireIdempotencyKey(req, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(req.idempotencyKey, "offramp:test-key-001");
});

test("requireIdempotencyKey rejects missing key", () => {
  const req = {
    get() {
      return "";
    },
  };
  const res = createRes();

  requireIdempotencyKey(req, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body?.message || ""), /Idempotency-Key header is required/i);
});

