const crypto = require("crypto");

function base64UrlDecode(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(padded, "base64").toString("utf8");
}

function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };

  const [encodedHeader, encodedPayload, signature] = parts;
  let header;
  let payload;

  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return { valid: false, reason: "decode_failed" };
  }

  if (!header || header.alg !== "HS256") {
    return { valid: false, reason: "unsupported_alg" };
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  if (!timingSafeEqual(expected, signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) < now) {
    return { valid: false, reason: "expired" };
  }

  if (payload.nbf && Number(payload.nbf) > now) {
    return { valid: false, reason: "not_before" };
  }

  if (!payload.address && !payload.sub) {
    return { valid: false, reason: "missing_subject" };
  }

  return {
    valid: true,
    payload: {
      ...payload,
      address: String(payload.address || payload.sub || "").trim().toLowerCase(),
    },
  };
}

function requireBackendAuth(req, res, next) {
  const secret = String(process.env.DOTPAY_BACKEND_JWT_SECRET || "").trim();
  if (!secret) {
    return res.status(500).json({
      success: false,
      message: "DOTPAY_BACKEND_JWT_SECRET is not configured.",
    });
  }

  const auth = String(req.get("authorization") || "").trim();
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

  if (!token) {
    return res.status(401).json({ success: false, message: "Missing bearer token." });
  }

  const verified = verifyToken(token, secret);
  if (!verified.valid) {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }

  const scopeRaw = verified.payload?.scope;
  const scopes = Array.isArray(scopeRaw)
    ? scopeRaw.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
    : String(scopeRaw || "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

  if (scopes.length > 0 && !scopes.includes("mpesa")) {
    return res.status(401).json({ success: false, message: "Token scope is not allowed for M-Pesa endpoints." });
  }

  req.backendAuth = verified.payload;
  return next();
}

module.exports = {
  requireBackendAuth,
  verifyToken,
};
