const { mpesaConfig, ensureMpesaConfigured } = require("../../config/mpesa");
const { getAccessToken, clearAccessToken } = require("./authTokenCache");

function nowTimestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${min}${sec}`;
}

function buildStkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

async function darajaRequest(url, body, retry = true) {
  ensureMpesaConfigured();
  const token = await getAccessToken();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (response.status === 401 && retry) {
    clearAccessToken();
    return darajaRequest(url, body, false);
  }

  return {
    ok: response.ok,
    status: response.status,
    data: payload,
  };
}

async function initiateStkPush({
  amountKes,
  phoneNumber,
  callbackUrl,
  accountReference,
  transactionDesc,
  transactionType = "CustomerPayBillOnline",
}) {
  const shortcode = mpesaConfig.credentials.stkShortcode || mpesaConfig.credentials.shortcode;
  const passkey = mpesaConfig.credentials.passkey;
  if (!shortcode) throw new Error("Missing M-Pesa STK shortcode (MPESA_STK_SHORTCODE).");
  if (!passkey) throw new Error("Missing M-Pesa passkey (MPESA_PASSKEY).");
  const timestamp = nowTimestamp();

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildStkPassword(shortcode, passkey, timestamp),
    Timestamp: timestamp,
    TransactionType: transactionType,
    Amount: Math.max(1, Math.round(Number(amountKes))),
    PartyA: phoneNumber,
    PartyB: shortcode,
    PhoneNumber: phoneNumber,
    CallBackURL: callbackUrl,
    AccountReference: accountReference || "DotPay",
    TransactionDesc: transactionDesc || "DotPay wallet top up",
  };

  return darajaRequest(mpesaConfig.endpoints.stkPush, payload);
}

async function initiateB2C({
  amountKes,
  phoneNumber,
  originatorConversationId,
  remarks,
  occasion,
  resultUrl,
  timeoutUrl,
  commandId = "BusinessPayment",
}) {
  const shortcode = mpesaConfig.credentials.b2cShortcode || mpesaConfig.credentials.shortcode;
  if (!shortcode) throw new Error("Missing M-Pesa B2C shortcode (MPESA_B2C_SHORTCODE).");
  const initiatorName = mpesaConfig.credentials.b2cInitiatorName || mpesaConfig.credentials.initiatorName;
  const securityCredential = mpesaConfig.credentials.b2cSecurityCredential || mpesaConfig.credentials.securityCredential;
  if (!initiatorName) throw new Error("Missing M-Pesa initiator name (MPESA_B2C_INITIATOR_NAME or MPESA_INITIATOR_NAME).");
  if (!securityCredential) {
    throw new Error("Missing M-Pesa security credential (MPESA_SECURITY_CREDENTIAL or MPESA_INITIATOR_PASSWORD + MPESA_CERT_PATH).");
  }
  const payload = {
    OriginatorConversationID: originatorConversationId,
    InitiatorName: initiatorName,
    SecurityCredential: securityCredential,
    CommandID: commandId,
    Amount: Math.max(1, Math.round(Number(amountKes))),
    PartyA: shortcode,
    PartyB: phoneNumber,
    Remarks: remarks || "DotPay payout",
    QueueTimeOutURL: timeoutUrl,
    ResultURL: resultUrl,
    Occassion: occasion || "DotPay",
  };

  return darajaRequest(mpesaConfig.endpoints.b2cPayment, payload);
}

async function initiateB2B({
  amountKes,
  receiverNumber,
  accountReference,
  originatorConversationId,
  resultUrl,
  timeoutUrl,
  commandId,
  remarks,
  senderIdentifierType = "4",
  receiverIdentifierType = "4",
  requester = "",
  initiatorNameOverride = "",
  securityCredentialOverride = "",
}) {
  const shortcode = mpesaConfig.credentials.b2bShortcode || mpesaConfig.credentials.shortcode;
  if (!shortcode) throw new Error("Missing M-Pesa B2B shortcode (MPESA_B2B_SHORTCODE).");
  const initiatorName =
    String(initiatorNameOverride || "").trim() ||
    mpesaConfig.credentials.b2bInitiatorName ||
    mpesaConfig.credentials.initiatorName;
  const securityCredential =
    String(securityCredentialOverride || "").trim() ||
    mpesaConfig.credentials.b2bSecurityCredential ||
    mpesaConfig.credentials.securityCredential;
  if (!initiatorName) throw new Error("Missing M-Pesa initiator name (MPESA_B2B_INITIATOR_NAME or MPESA_INITIATOR_NAME).");
  if (!securityCredential) {
    throw new Error("Missing M-Pesa security credential (MPESA_SECURITY_CREDENTIAL or MPESA_INITIATOR_PASSWORD + MPESA_CERT_PATH).");
  }
  const payload = {
    OriginatorConversationID: originatorConversationId,
    Initiator: initiatorName,
    SecurityCredential: securityCredential,
    CommandID: commandId,
    SenderIdentifierType: String(senderIdentifierType),
    RecieverIdentifierType: String(receiverIdentifierType),
    Amount: Math.max(1, Math.round(Number(amountKes))),
    PartyA: shortcode,
    PartyB: receiverNumber,
    AccountReference: accountReference || "DotPay",
    Remarks: remarks || "DotPay merchant payment",
    QueueTimeOutURL: timeoutUrl,
    ResultURL: resultUrl,
  };

  const requesterValue = String(requester || "").trim();
  if (requesterValue) {
    payload.Requester = requesterValue;
  }

  return darajaRequest(mpesaConfig.endpoints.b2bPayment, payload);
}

async function queryTransactionStatus({ transactionReceipt, originatorConversationId }) {
  const shortcode = mpesaConfig.credentials.b2cShortcode || mpesaConfig.credentials.shortcode;
  const initiatorName = mpesaConfig.credentials.b2cInitiatorName || mpesaConfig.credentials.initiatorName;
  const securityCredential = mpesaConfig.credentials.b2cSecurityCredential || mpesaConfig.credentials.securityCredential;
  const payload = {
    Initiator: initiatorName,
    SecurityCredential: securityCredential,
    CommandID: "TransactionStatusQuery",
    TransactionID: transactionReceipt,
    OriginalConversationID: originatorConversationId,
    PartyA: shortcode,
    IdentifierType: "4",
    ResultURL: `${mpesaConfig.callbacks.resultBaseUrl}/api/mpesa/webhooks/b2c/result`,
    QueueTimeOutURL: `${mpesaConfig.callbacks.timeoutBaseUrl}/api/mpesa/webhooks/b2c/timeout`,
    Remarks: "DotPay reconcile",
    Occasion: "DotPay reconcile",
  };

  return darajaRequest(mpesaConfig.endpoints.transactionStatus, payload);
}

module.exports = {
  nowTimestamp,
  buildStkPassword,
  initiateStkPush,
  initiateB2C,
  initiateB2B,
  queryTransactionStatus,
};
