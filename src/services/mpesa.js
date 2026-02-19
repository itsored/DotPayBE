const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.MPESA_TIMEOUT_MS || "30000", 10);

const normalizeDigits = (value) => String(value || "").replace(/\D/g, "");

function normalizeMsisdn(phone) {
  const digits = normalizeDigits(phone);
  if (!digits) return "";
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}

function isValidKenyanMsisdn(phone) {
  return /^254(?:7|1)\d{8}$/.test(String(phone || ""));
}

function getEnvValue(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getMpesaConfig() {
  const env = getEnvValue("MPESA_ENV") || "production";
  const isSandbox = env.toLowerCase() === "sandbox";
  const baseUrl =
    getEnvValue("MPESA_BASE_URL") ||
    (isSandbox ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke");

  const consumerKey = getEnvValue(
    isSandbox ? "MPESA_DEV_CONSUMER_KEY" : "MPESA_PROD_CONSUMER_KEY",
    "MPESA_CONSUMER_KEY",
    "MPESA_DEV_CONSUMER_KEY",
    "MPESA_PROD_CONSUMER_KEY"
  );
  const consumerSecret = getEnvValue(
    isSandbox ? "MPESA_DEV_CONSUMER_SECRET" : "MPESA_PROD_CONSUMER_SECRET",
    "MPESA_CONSUMER_SECRET",
    "MPESA_DEV_CONSUMER_SECRET",
    "MPESA_PROD_CONSUMER_SECRET"
  );
  const shortcode = getEnvValue(
    isSandbox ? "MPESA_DEV_SHORTCODE" : "MPESA_PROD_SHORTCODE",
    "MPESA_SHORTCODE",
    "MPESA_DEV_SHORTCODE",
    "MPESA_PROD_SHORTCODE"
  );
  const passkey = getEnvValue(
    isSandbox ? "MPESA_DEV_PASSKEY" : "MPESA_PROD_PASSKEY",
    "MPESA_PASSKEY",
    "MPESA_DEV_PASSKEY",
    "MPESA_PROD_PASSKEY"
  );
  const initiatorName = getEnvValue(
    isSandbox ? "MPESA_DEV_INITIATOR_NAME" : "MPESA_PROD_INITIATOR_NAME",
    "MPESA_INITIATOR_NAME",
    "MPESA_DEV_INITIATOR_NAME",
    "MPESA_PROD_INITIATOR_NAME"
  );
  const securityCredential = getEnvValue(
    isSandbox ? "MPESA_DEV_SECURITY_CREDENTIAL" : "MPESA_PROD_SECURITY_CREDENTIAL",
    "MPESA_SECURITY_CREDENTIAL",
    "MPESA_DEV_SECURITY_CREDENTIAL",
    "MPESA_PROD_SECURITY_CREDENTIAL"
  );

  const b2cShortcode =
    getEnvValue(
      isSandbox ? "MPESA_DEV_B2C_SHORTCODE" : "MPESA_PROD_B2C_SHORTCODE",
      "MPESA_B2C_SHORTCODE"
    ) || shortcode;
  const b2bShortcode =
    getEnvValue(
      isSandbox ? "MPESA_DEV_B2B_SHORTCODE" : "MPESA_PROD_B2B_SHORTCODE",
      "MPESA_B2B_SHORTCODE"
    ) || shortcode;
  const webhookBase = getEnvValue("MPESA_WEBHOOK_URL");
  const callbackToken = getEnvValue("MPESA_CALLBACK_TOKEN");

  return {
    env,
    isSandbox,
    baseUrl,
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
    initiatorName,
    securityCredential,
    b2cShortcode,
    b2bShortcode,
    webhookBase,
    callbackToken,
    b2cUrl: getEnvValue("MPESA_B2C_URL") || `${baseUrl}/mpesa/b2c/v1/paymentrequest`,
    b2bUrl: getEnvValue("MPESA_B2B_URL") || `${baseUrl}/mpesa/b2b/v1/paymentrequest`,
  };
}

function assertRequiredConfig(config) {
  const required = [
    ["consumerKey", "MPESA_CONSUMER_KEY / MPESA_DEV_CONSUMER_KEY"],
    ["consumerSecret", "MPESA_CONSUMER_SECRET / MPESA_DEV_CONSUMER_SECRET"],
    ["shortcode", "MPESA_SHORTCODE / MPESA_DEV_SHORTCODE"],
    ["passkey", "MPESA_PASSKEY / MPESA_DEV_PASSKEY"],
    ["initiatorName", "MPESA_INITIATOR_NAME / MPESA_DEV_INITIATOR_NAME"],
    ["securityCredential", "MPESA_SECURITY_CREDENTIAL / MPESA_DEV_SECURITY_CREDENTIAL"],
  ];

  const missing = required.filter(([field]) => !config[field]).map(([, envName]) => envName);
  if (missing.length > 0) {
    const error = new Error(`Missing required M-Pesa config: ${missing.join(", ")}`);
    error.statusCode = 500;
    throw error;
  }
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function withTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function readJsonSafely(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function fetchMpesa(url, options = {}) {
  const { signal, cancel } = withTimeout();
  try {
    const response = await fetch(url, { ...options, signal });
    const payload = await readJsonSafely(response);
    if (!response.ok) {
      const err = new Error(
        payload?.errorMessage || payload?.error_description || payload?.message || `M-Pesa request failed (${response.status})`
      );
      err.statusCode = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    cancel();
  }
}

const tokenCache = global.__dotpay_mpesa_token_cache || { token: null, expiresAt: 0 };
global.__dotpay_mpesa_token_cache = tokenCache;

async function getAccessToken(config) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 15_000) {
    return tokenCache.token;
  }

  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  const url = `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
  const payload = await fetchMpesa(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  const token = payload?.access_token;
  const expiresInSec = Number.parseInt(String(payload?.expires_in || "3599"), 10);
  if (!token) {
    const err = new Error("Failed to obtain M-Pesa access token");
    err.statusCode = 500;
    throw err;
  }

  tokenCache.token = token;
  tokenCache.expiresAt = now + Math.max(60, expiresInSec - 30) * 1000;
  return token;
}

function withCallbackToken(url, token) {
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

function callbackUrl(config, path, fallbackPath) {
  const explicit = getEnvValue(path);
  if (explicit) return withCallbackToken(explicit, config.callbackToken);
  if (!config.webhookBase) {
    const err = new Error(
      `Missing callback URL. Set ${path} or MPESA_WEBHOOK_URL to build callback endpoints.`
    );
    err.statusCode = 500;
    throw err;
  }
  const base = config.webhookBase.replace(/\/+$/, "");
  return withCallbackToken(`${base}${fallbackPath}`, config.callbackToken);
}

async function postToMpesa(pathOrUrl, body, config) {
  const accessToken = await getAccessToken(config);
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${config.baseUrl}${pathOrUrl}`;
  return fetchMpesa(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function initiateStkPush({
  amount,
  phoneNumber,
  accountReference,
  transactionDesc,
  transactionId,
}) {
  const config = getMpesaConfig();
  assertRequiredConfig(config);

  const timestamp = formatTimestamp();
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString("base64");

  const body = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: phoneNumber,
    PartyB: config.shortcode,
    PhoneNumber: phoneNumber,
    CallBackURL: callbackUrl(config, "MPESA_STK_CALLBACK_URL", "/api/mpesa/stk-callback"),
    AccountReference: String(accountReference || transactionId || "DotPay").slice(0, 12),
    TransactionDesc: String(transactionDesc || "DotPay payment").slice(0, 182),
  };

  const response = await postToMpesa("/mpesa/stkpush/v1/processrequest", body, config);
  return { request: body, response, config };
}

async function initiateB2CPayment({
  amount,
  phoneNumber,
  remarks,
  occasion,
  commandId = "BusinessPayment",
}) {
  const config = getMpesaConfig();
  assertRequiredConfig(config);

  const body = {
    InitiatorName: config.initiatorName,
    SecurityCredential: config.securityCredential,
    CommandID: commandId,
    Amount: Math.round(amount),
    PartyA: config.b2cShortcode,
    PartyB: phoneNumber,
    Remarks: String(remarks || "DotPay B2C payout").slice(0, 100),
    QueueTimeOutURL: callbackUrl(config, "MPESA_B2C_TIMEOUT_URL", "/api/mpesa/queue-timeout"),
    ResultURL: callbackUrl(config, "MPESA_B2C_RESULT_URL", "/api/mpesa/b2c-callback"),
    Occasion: String(occasion || "DotPay").slice(0, 100),
  };

  const response = await postToMpesa(config.b2cUrl, body, config);
  return { request: body, response, config };
}

async function initiateB2BPayment({
  amount,
  targetNumber,
  accountNumber,
  remarks,
  commandId = "BusinessPayBill",
}) {
  const config = getMpesaConfig();
  assertRequiredConfig(config);

  const body = {
    Initiator: config.initiatorName,
    SecurityCredential: config.securityCredential,
    CommandID: commandId,
    SenderIdentifierType: "4",
    RecieverIdentifierType: "4",
    Amount: Math.round(amount),
    PartyA: config.b2bShortcode,
    PartyB: String(targetNumber),
    AccountReference: String(accountNumber || "DotPay").slice(0, 20),
    Remarks: String(remarks || "DotPay B2B payment").slice(0, 100),
    QueueTimeOutURL: callbackUrl(config, "MPESA_B2B_TIMEOUT_URL", "/api/mpesa/queue-timeout"),
    ResultURL: callbackUrl(config, "MPESA_B2B_RESULT_URL", "/api/mpesa/b2b-callback"),
  };

  const response = await postToMpesa(config.b2bUrl, body, config);
  return { request: body, response, config };
}

function verifyCallbackToken(req) {
  const config = getMpesaConfig();
  if (!config.callbackToken) return true;
  const provided = String(req.query?.token || req.get("x-mpesa-callback-token") || "").trim();
  return provided && provided === config.callbackToken;
}

function hasValidClientBearer(req) {
  const authHeader = String(req.get("authorization") || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) return false;
  const token = authHeader.slice("bearer ".length).trim();
  if (!token || token.length < 20) return false;
  return true;
}

module.exports = {
  normalizeMsisdn,
  isValidKenyanMsisdn,
  initiateStkPush,
  initiateB2CPayment,
  initiateB2BPayment,
  verifyCallbackToken,
  hasValidClientBearer,
  getMpesaConfig,
};
