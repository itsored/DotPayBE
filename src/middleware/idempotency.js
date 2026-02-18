function requireIdempotencyKey(req, res, next) {
  const key = String(req.get("idempotency-key") || "").trim();
  if (!key) {
    return res.status(400).json({
      success: false,
      message: "Idempotency-Key header is required.",
    });
  }

  if (key.length < 8 || key.length > 128) {
    return res.status(400).json({
      success: false,
      message: "Idempotency-Key must be 8-128 characters.",
    });
  }

  if (!/^[A-Za-z0-9_\-:.]+$/.test(key)) {
    return res.status(400).json({
      success: false,
      message: "Idempotency-Key contains unsupported characters.",
    });
  }

  req.idempotencyKey = key;
  return next();
}

module.exports = {
  requireIdempotencyKey,
};
