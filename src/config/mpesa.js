const DEFAULT_SANDBOX_BASE_URL = "https://sandbox.safaricom.co.ke";
const DEFAULT_PRODUCTION_BASE_URL = "https://api.safaricom.co.ke";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { generateSecurityCredentialFromCertPath } = require("../services/mpesa/securityCredential");

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

const LIKELY_RSA_CIPHERTEXT_BYTE_LENGTHS = new Set([128, 192, 256, 384, 512]);

function decodedBase64ByteLength(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const normalized = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return -1;
  try {
    return Buffer.from(normalized, "base64").length;
  } catch {
    return -1;
  }
}

function looksLikeRsaSecurityCredential(value) {
  const decodedLength = decodedBase64ByteLength(value);
  return LIKELY_RSA_CIPHERTEXT_BYTE_LENGTHS.has(decodedLength);
}

const envRaw = String(process.env.MPESA_ENV || "").trim().toLowerCase();
const env = envRaw === "production" ? "production" : "sandbox";

function readEnvRaw(name) {
  return String(process.env[name] || "").trim();
}

// In production mode, allow a separate credential namespace:
// MPESA_PROD_*. Falls back to MPESA_* for backward compatibility.
function readMpesaValue(suffix, { allowLegacyFallback = true } = {}) {
  if (env === "production") {
    const prodValue = readEnvRaw(`MPESA_PROD_${suffix}`);
    if (prodValue) return prodValue;
    if (!allowLegacyFallback) return "";
  }
  return readEnvRaw(`MPESA_${suffix}`);
}

function defaultCertPathForEnv(targetEnv) {
  // Only sandbox cert is bundled; production should be supplied via MPESA_CERT_PATH.
  if (targetEnv === "sandbox") return path.join(__dirname, "../assets/mpesa-sandbox-cert.cer");
  return "";
}

const baseUrl =
  normalizeUrl(process.env.MPESA_BASE_URL) ||
  (env === "production" ? DEFAULT_PRODUCTION_BASE_URL : DEFAULT_SANDBOX_BASE_URL);

const resultBaseUrl = normalizeUrl(process.env.MPESA_RESULT_BASE_URL || process.env.NEXT_PUBLIC_DOTPAY_API_URL);
const timeoutBaseUrl = normalizeUrl(process.env.MPESA_TIMEOUT_BASE_URL || process.env.NEXT_PUBLIC_DOTPAY_API_URL);

// Resolve the environment-scoped security credential first.
// In production mode, this prefers MPESA_PROD_SECURITY_CREDENTIAL and only falls back to MPESA_SECURITY_CREDENTIAL.
let securityCredential = readMpesaValue("SECURITY_CREDENTIAL");
if (!securityCredential) {
  const initiatorPassword = readMpesaValue("INITIATOR_PASSWORD");
  const certPath = readMpesaValue("CERT_PATH") || defaultCertPathForEnv(env);
  if (initiatorPassword && certPath && fs.existsSync(certPath)) {
    try {
      securityCredential = generateSecurityCredentialFromCertPath({ initiatorPassword, certPath });
    } catch (err) {
      if (!global.__dotpay_mpesa_cred_warned) {
        global.__dotpay_mpesa_cred_warned = true;
        console.warn("Failed to generate MPESA_SECURITY_CREDENTIAL from password:", err?.message || err);
      }
    }
  }
}

function deriveTreasuryAddressFromPrivateKey(privateKey) {
  const pk = String(privateKey || "").trim();
  if (!pk) return "";
  try {
    return new ethers.Wallet(pk).address;
  } catch {
    return "";
  }
}

const treasuryPrivateKey = String(process.env.TREASURY_PRIVATE_KEY || "").trim();
const treasuryAddress =
  String(process.env.TREASURY_PLATFORM_ADDRESS || "").trim() ||
  deriveTreasuryAddressFromPrivateKey(treasuryPrivateKey);
const b2cApiVersion = String(readMpesaValue("B2C_API_VERSION", { allowLegacyFallback: false }) || "v3")
  .trim()
  .toLowerCase();

const mpesaConfig = {
  enabled: toBool(process.env.MPESA_ENABLED, false),
  env,
  baseUrl,
  oauthUrl: `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
  endpoints: {
    stkPush: `${baseUrl}/mpesa/stkpush/v1/processrequest`,
    stkQuery: `${baseUrl}/mpesa/stkpushquery/v1/query`,
    b2cPayment:
      b2cApiVersion === "v1"
        ? `${baseUrl}/mpesa/b2c/v1/paymentrequest`
        : `${baseUrl}/mpesa/b2c/v3/paymentrequest`,
    b2bPayment: `${baseUrl}/mpesa/b2b/v1/paymentrequest`,
    transactionStatus: `${baseUrl}/mpesa/transactionstatus/v1/query`,
  },
  credentials: {
    consumerKey: readMpesaValue("CONSUMER_KEY"),
    consumerSecret: readMpesaValue("CONSUMER_SECRET"),
    shortcode: readMpesaValue("SHORTCODE"),
    stkShortcode: readMpesaValue("STK_SHORTCODE") || readMpesaValue("SHORTCODE"),
    b2cShortcode: readMpesaValue("B2C_SHORTCODE") || readMpesaValue("SHORTCODE"),
    b2bShortcode: readMpesaValue("B2B_SHORTCODE") || readMpesaValue("SHORTCODE"),
    passkey: readMpesaValue("PASSKEY"),
    initiatorName: readMpesaValue("INITIATOR_NAME"),
    securityCredential,

    // Optional per-product overrides (some Daraja apps issue different initiators/credentials per API product).
    b2cInitiatorName:
      readMpesaValue("B2C_INITIATOR_NAME", { allowLegacyFallback: false }) || readMpesaValue("INITIATOR_NAME"),
    b2cSecurityCredential:
      readMpesaValue("B2C_SECURITY_CREDENTIAL", { allowLegacyFallback: false }) || securityCredential,
    b2bInitiatorName:
      readMpesaValue("B2B_INITIATOR_NAME", { allowLegacyFallback: false }) || readMpesaValue("INITIATOR_NAME"),
    b2bSecurityCredential:
      readMpesaValue("B2B_SECURITY_CREDENTIAL", { allowLegacyFallback: false }) || securityCredential,

    // Optional per-flow B2B overrides.
    b2bPaybillInitiatorName:
      readMpesaValue("B2B_PAYBILL_INITIATOR_NAME", { allowLegacyFallback: false }) ||
      readMpesaValue("B2B_INITIATOR_NAME", { allowLegacyFallback: false }) ||
      readMpesaValue("INITIATOR_NAME"),
    b2bPaybillSecurityCredential:
      readMpesaValue("B2B_PAYBILL_SECURITY_CREDENTIAL", { allowLegacyFallback: false }) ||
      readMpesaValue("B2B_SECURITY_CREDENTIAL", { allowLegacyFallback: false }) ||
      securityCredential,
    b2bBuygoodsInitiatorName:
      readMpesaValue("B2B_BUYGOODS_INITIATOR_NAME", { allowLegacyFallback: false }) ||
      readMpesaValue("B2B_INITIATOR_NAME", { allowLegacyFallback: false }) ||
      readMpesaValue("INITIATOR_NAME"),
    b2bBuygoodsSecurityCredential:
      readMpesaValue("B2B_BUYGOODS_SECURITY_CREDENTIAL", { allowLegacyFallback: false }) ||
      readMpesaValue("B2B_SECURITY_CREDENTIAL", { allowLegacyFallback: false }) ||
      securityCredential,

    // Optional Requester for B2B payloads (commonly used in sandbox samples).
    b2bRequester: readMpesaValue("B2B_REQUESTER", { allowLegacyFallback: false }),
  },
  commands: {
    b2cOfframp: String(readMpesaValue("B2C_COMMAND_ID", { allowLegacyFallback: false }) || "BusinessPayment").trim(),
    b2bPaybill: String(readMpesaValue("B2B_PAYBILL_COMMAND_ID", { allowLegacyFallback: false }) || "BusinessPayBill").trim(),
    b2bBuygoods: String(readMpesaValue("B2B_BUYGOODS_COMMAND_ID", { allowLegacyFallback: false }) || "BusinessBuyGoods").trim(),
    b2bBuygoodsReceiverIdentifierType: String(
      readMpesaValue("B2B_BUYGOODS_RECEIVER_IDENTIFIER_TYPE", { allowLegacyFallback: false }) || "2"
    ).trim(),
  },
  callbacks: {
    resultBaseUrl,
    timeoutBaseUrl,
    webhookSecret: String(process.env.MPESA_WEBHOOK_SECRET || "").trim(),
  },
  limits: {
    maxTxnKes: toNumber(process.env.MPESA_MAX_TXN_KES, 150000),
    maxDailyKes: toNumber(process.env.MPESA_MAX_DAILY_KES, 500000),
  },
  quote: {
    ttlSeconds: toNumber(process.env.MPESA_QUOTE_TTL_SECONDS, 300),
  },
  refunds: {
    autoRefund: toBool(process.env.MPESA_AUTO_REFUND, true),
  },
  security: {
    // DotPay uses a fixed-length app PIN (6 digits) for sensitive flows.
    pinMinLength: toNumber(process.env.MPESA_PIN_MIN_LENGTH, 6),
    signatureMaxAgeSeconds: toNumber(process.env.MPESA_SIGNATURE_MAX_AGE_SECONDS, 600),
  },
  treasury: {
    refundEnabled: toBool(process.env.TREASURY_REFUND_ENABLED, true),
    rpcUrl: normalizeUrl(process.env.TREASURY_RPC_URL),
    privateKey: treasuryPrivateKey,
    address: treasuryAddress ? treasuryAddress.toLowerCase() : "",
    usdcContract: String(process.env.TREASURY_USDC_CONTRACT || "").trim(),
    chainId: toNumber(process.env.TREASURY_CHAIN_ID, 0) || null,
    usdcDecimals: toNumber(process.env.TREASURY_USDC_DECIMALS, 6),
    waitConfirmations: Math.max(1, toNumber(process.env.TREASURY_WAIT_CONFIRMATIONS, 1)),
  },
  settlement: {
    requireOnchainFunding: toBool(process.env.MPESA_REQUIRE_ONCHAIN_FUNDING, true),
    minFundingConfirmations: Math.max(1, toNumber(process.env.MPESA_MIN_FUNDING_CONFIRMATIONS, 1)),
  },
};

function ensureMpesaConfigured() {
  const missing = [];
  if (!mpesaConfig.credentials.consumerKey)
    missing.push("MPESA_CONSUMER_KEY (or MPESA_PROD_CONSUMER_KEY when MPESA_ENV=production)");
  if (!mpesaConfig.credentials.consumerSecret)
    missing.push("MPESA_CONSUMER_SECRET (or MPESA_PROD_CONSUMER_SECRET when MPESA_ENV=production)");
  if (!mpesaConfig.credentials.stkShortcode)
    missing.push("MPESA_STK_SHORTCODE/MPESA_SHORTCODE (or MPESA_PROD_STK_SHORTCODE/MPESA_PROD_SHORTCODE)");
  if (!mpesaConfig.credentials.b2cShortcode)
    missing.push("MPESA_B2C_SHORTCODE/MPESA_SHORTCODE (or MPESA_PROD_B2C_SHORTCODE/MPESA_PROD_SHORTCODE)");
  if (!mpesaConfig.credentials.b2bShortcode)
    missing.push("MPESA_B2B_SHORTCODE/MPESA_SHORTCODE (or MPESA_PROD_B2B_SHORTCODE/MPESA_PROD_SHORTCODE)");
  if (!mpesaConfig.callbacks.resultBaseUrl) missing.push("MPESA_RESULT_BASE_URL");
  if (!mpesaConfig.callbacks.timeoutBaseUrl) missing.push("MPESA_TIMEOUT_BASE_URL");
  if (mpesaConfig.settlement?.requireOnchainFunding) {
    if (!mpesaConfig.treasury?.rpcUrl) missing.push("TREASURY_RPC_URL");
    if (!mpesaConfig.treasury?.usdcContract) missing.push("TREASURY_USDC_CONTRACT");
    if (!mpesaConfig.treasury?.address) {
      missing.push("TREASURY_PLATFORM_ADDRESS (or TREASURY_PRIVATE_KEY)");
    }
  }

  const invalidSecurityCredentials = [];
  const securityCandidates = [
    ["MPESA_SECURITY_CREDENTIAL", mpesaConfig.credentials.securityCredential],
    ["MPESA_B2C_SECURITY_CREDENTIAL", mpesaConfig.credentials.b2cSecurityCredential],
    ["MPESA_B2B_SECURITY_CREDENTIAL", mpesaConfig.credentials.b2bSecurityCredential],
  ];

  for (const [name, value] of securityCandidates) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    if (!looksLikeRsaSecurityCredential(raw)) {
      const decodedLength = decodedBase64ByteLength(raw);
      invalidSecurityCredentials.push(`${name} (decoded bytes: ${decodedLength})`);
    }
  }
  if (invalidSecurityCredentials.length > 0) {
    missing.push(`Invalid security credential format: ${invalidSecurityCredentials.join(", ")}`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing M-Pesa configuration: ${missing.join(", ")}`);
  }
}

module.exports = {
  mpesaConfig,
  ensureMpesaConfigured,
};
