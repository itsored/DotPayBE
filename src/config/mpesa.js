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

const envRaw = String(process.env.MPESA_ENV || "").trim().toLowerCase();
const env = envRaw === "production" ? "production" : "sandbox";
const envPrefix = env === "production" ? "MPESA_PROD_" : "MPESA_DEV_";

function pickMpesaEnvValue(suffix, fallback = "") {
  const envScoped = String(process.env[`${envPrefix}${suffix}`] || "").trim();
  if (envScoped) return envScoped;
  const generic = String(process.env[`MPESA_${suffix}`] || "").trim();
  if (generic) return generic;
  return String(fallback || "").trim();
}

function defaultCertPathForEnv(targetEnv) {
  // Only sandbox cert is bundled; production should be supplied via MPESA_CERT_PATH.
  if (targetEnv === "sandbox") return path.join(__dirname, "../assets/mpesa-sandbox-cert.cer");
  return "";
}

const baseUrl =
  normalizeUrl(process.env.MPESA_BASE_URL) ||
  (env === "production" ? DEFAULT_PRODUCTION_BASE_URL : DEFAULT_SANDBOX_BASE_URL);

const webhookBaseUrl = normalizeUrl(process.env.MPESA_WEBHOOK_URL || "");
const resultBaseUrl = normalizeUrl(
  process.env.MPESA_RESULT_BASE_URL || webhookBaseUrl || process.env.NEXT_PUBLIC_DOTPAY_API_URL
);
const timeoutBaseUrl = normalizeUrl(
  process.env.MPESA_TIMEOUT_BASE_URL || webhookBaseUrl || process.env.NEXT_PUBLIC_DOTPAY_API_URL
);

let securityCredential = pickMpesaEnvValue("SECURITY_CREDENTIAL");
if (!securityCredential) {
  const initiatorPassword = pickMpesaEnvValue("INITIATOR_PASSWORD");
  const certPath = String(process.env.MPESA_CERT_PATH || "").trim() || defaultCertPathForEnv(env);
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

const mpesaConfig = {
  enabled: toBool(process.env.MPESA_ENABLED, false),
  env,
  baseUrl,
  oauthUrl: `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
  endpoints: {
    stkPush: `${baseUrl}/mpesa/stkpush/v1/processrequest`,
    stkQuery: `${baseUrl}/mpesa/stkpushquery/v1/query`,
    b2cPayment:
      String(process.env.MPESA_B2C_API_VERSION || "")
        .trim()
        .toLowerCase() === "v1"
        ? `${baseUrl}/mpesa/b2c/v1/paymentrequest`
        : `${baseUrl}/mpesa/b2c/v3/paymentrequest`,
    b2bPayment: `${baseUrl}/mpesa/b2b/v1/paymentrequest`,
    transactionStatus: `${baseUrl}/mpesa/transactionstatus/v1/query`,
  },
  credentials: {
    consumerKey: pickMpesaEnvValue("CONSUMER_KEY"),
    consumerSecret: pickMpesaEnvValue("CONSUMER_SECRET"),
    shortcode: pickMpesaEnvValue("SHORTCODE"),
    stkShortcode: pickMpesaEnvValue("STK_SHORTCODE", pickMpesaEnvValue("SHORTCODE")),
    b2cShortcode: pickMpesaEnvValue("B2C_SHORTCODE", pickMpesaEnvValue("SHORTCODE")),
    b2bShortcode: pickMpesaEnvValue("B2B_SHORTCODE", pickMpesaEnvValue("SHORTCODE")),
    passkey: pickMpesaEnvValue("PASSKEY"),
    initiatorName: pickMpesaEnvValue("INITIATOR_NAME"),
    securityCredential,

    // Optional per-product overrides (some Daraja apps issue different initiators/credentials per API product).
    b2cInitiatorName:
      pickMpesaEnvValue("B2C_INITIATOR_NAME") ||
      pickMpesaEnvValue("INITIATOR_NAME"),
    b2cSecurityCredential:
      pickMpesaEnvValue("B2C_SECURITY_CREDENTIAL") ||
      securityCredential,
    b2bInitiatorName:
      pickMpesaEnvValue("B2B_INITIATOR_NAME") ||
      pickMpesaEnvValue("INITIATOR_NAME"),
    b2bSecurityCredential:
      pickMpesaEnvValue("B2B_SECURITY_CREDENTIAL") ||
      securityCredential,

    // Optional per-flow B2B overrides.
    b2bPaybillInitiatorName:
      pickMpesaEnvValue("B2B_PAYBILL_INITIATOR_NAME") ||
      pickMpesaEnvValue("B2B_INITIATOR_NAME") ||
      pickMpesaEnvValue("INITIATOR_NAME"),
    b2bPaybillSecurityCredential:
      pickMpesaEnvValue("B2B_PAYBILL_SECURITY_CREDENTIAL") ||
      pickMpesaEnvValue("B2B_SECURITY_CREDENTIAL") ||
      securityCredential,
    b2bBuygoodsInitiatorName:
      pickMpesaEnvValue("B2B_BUYGOODS_INITIATOR_NAME") ||
      pickMpesaEnvValue("B2B_INITIATOR_NAME") ||
      pickMpesaEnvValue("INITIATOR_NAME"),
    b2bBuygoodsSecurityCredential:
      pickMpesaEnvValue("B2B_BUYGOODS_SECURITY_CREDENTIAL") ||
      pickMpesaEnvValue("B2B_SECURITY_CREDENTIAL") ||
      securityCredential,

    // Optional Requester for B2B payloads (commonly used in sandbox samples).
    b2bRequester: pickMpesaEnvValue("B2B_REQUESTER"),
  },
  commands: {
    b2cOfframp: String(process.env.MPESA_B2C_COMMAND_ID || "BusinessPayment").trim(),
    b2bPaybill: String(process.env.MPESA_B2B_PAYBILL_COMMAND_ID || "BusinessPayBill").trim(),
    b2bBuygoods: String(process.env.MPESA_B2B_BUYGOODS_COMMAND_ID || "BusinessBuyGoods").trim(),
    b2bBuygoodsReceiverIdentifierType: String(
      process.env.MPESA_B2B_BUYGOODS_RECEIVER_IDENTIFIER_TYPE || "2"
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
    defaultRateKesPerUsd: toNumber(process.env.KES_PER_USD, 130),
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
  if (!mpesaConfig.credentials.consumerKey) missing.push("MPESA_CONSUMER_KEY");
  if (!mpesaConfig.credentials.consumerSecret) missing.push("MPESA_CONSUMER_SECRET");
  if (!mpesaConfig.credentials.stkShortcode) missing.push("MPESA_STK_SHORTCODE or MPESA_SHORTCODE");
  if (!mpesaConfig.credentials.b2cShortcode) missing.push("MPESA_B2C_SHORTCODE or MPESA_SHORTCODE");
  if (!mpesaConfig.credentials.b2bShortcode) missing.push("MPESA_B2B_SHORTCODE or MPESA_SHORTCODE");
  if (!mpesaConfig.callbacks.resultBaseUrl) missing.push("MPESA_RESULT_BASE_URL");
  if (!mpesaConfig.callbacks.timeoutBaseUrl) missing.push("MPESA_TIMEOUT_BASE_URL");
  if (mpesaConfig.settlement?.requireOnchainFunding) {
    if (!mpesaConfig.treasury?.rpcUrl) missing.push("TREASURY_RPC_URL");
    if (!mpesaConfig.treasury?.usdcContract) missing.push("TREASURY_USDC_CONTRACT");
    if (!mpesaConfig.treasury?.address) {
      missing.push("TREASURY_PLATFORM_ADDRESS (or TREASURY_PRIVATE_KEY)");
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing M-Pesa configuration: ${missing.join(", ")}`);
  }
}

module.exports = {
  mpesaConfig,
  ensureMpesaConfigured,
};
