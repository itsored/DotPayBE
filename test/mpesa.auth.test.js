const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { verifyToken, requireBackendAuth } = require("../src/middleware/requireBackendAuth");

function signToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${encHeader}.${encPayload}`;
  const signature = crypto.createHmac("sha256", secret).update(input).digest("base64url");
  return `${input}.${signature}`;
}

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

test("verifyToken validates HS256 token", () => {
  const secret = "test-secret";
  const now = Math.floor(Date.now() / 1000);
  const token = signToken(
    {
      sub: "0x1111111111111111111111111111111111111111",
      scope: "mpesa",
      iat: now,
      exp: now + 120,
    },
    secret
  );

  const verified = verifyToken(token, secret);
  assert.equal(verified.valid, true);
  assert.equal(verified.payload.address, "0x1111111111111111111111111111111111111111");
});

test("requireBackendAuth rejects token with non-mpesa scope", () => {
  const secret = "test-secret";
  process.env.DOTPAY_BACKEND_JWT_SECRET = secret;

  const now = Math.floor(Date.now() / 1000);
  const token = signToken(
    {
      sub: "0x2222222222222222222222222222222222222222",
      scope: "users",
      iat: now,
      exp: now + 120,
    },
    secret
  );

  const req = {
    get(name) {
      if (String(name).toLowerCase() === "authorization") return `Bearer ${token}`;
      return "";
    },
  };
  const res = createRes();
  let nextCalled = false;
  requireBackendAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(String(res.body?.message || ""), /scope/i);
});

