const { mpesaConfig, ensureMpesaConfigured } = require("../../config/mpesa");

let cachedToken = null;
let cachedExpiresAt = 0;

async function getAccessToken(forceRefresh = false) {
  ensureMpesaConfigured();

  if (!forceRefresh && cachedToken && cachedExpiresAt > Date.now() + 10_000) {
    return cachedToken;
  }

  const key = mpesaConfig.credentials.consumerKey;
  const secret = mpesaConfig.credentials.consumerSecret;
  const basicAuth = Buffer.from(`${key}:${secret}`).toString("base64");

  const response = await fetch(mpesaConfig.oauthUrl, {
    method: "GET",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    const msg = payload?.errorMessage || payload?.error || payload?.message || "OAuth token request failed";
    throw new Error(`M-Pesa auth failed: ${msg}`);
  }

  const expiresIn = Number(payload.expires_in || 3600);
  cachedToken = payload.access_token;
  cachedExpiresAt = Date.now() + Math.max(60, expiresIn - 30) * 1000;

  return cachedToken;
}

function clearAccessToken() {
  cachedToken = null;
  cachedExpiresAt = 0;
}

module.exports = {
  getAccessToken,
  clearAccessToken,
};
