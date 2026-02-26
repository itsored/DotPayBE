const crypto = require("crypto");
const { ethers } = require("ethers");
const { mpesaConfig } = require("../../config/mpesa");
const { assertTransition } = require("./stateMachine");

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
];

function pseudoRefundReference() {
  return `RF_${Date.now().toString(36).toUpperCase()}_${crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;
}

function getRefundAmountUsd(transaction) {
  const funded = Number(transaction?.onchain?.fundedAmountUsd || 0);
  if (Number.isFinite(funded) && funded > 0) return funded;

  const expected = Number(transaction?.onchain?.expectedAmountUsd || 0);
  if (Number.isFinite(expected) && expected > 0) return expected;

  const amount = Number(transaction?.quote?.amountUsd || 0);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function hasTreasuryConfig() {
  const treasury = mpesaConfig.treasury || {};
  return Boolean(treasury.rpcUrl && treasury.privateKey && treasury.usdcContract);
}

function getRefundRecipient(transaction) {
  const fromAddress = String(transaction?.onchain?.fromAddress || "")
    .trim()
    .toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(fromAddress)) {
    return fromAddress;
  }

  const signerAddress = String(transaction?.authorization?.signerAddress || "")
    .trim()
    .toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(signerAddress)) {
    return signerAddress;
  }

  const userAddress = String(transaction?.userAddress || "").trim().toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(userAddress)) {
    return userAddress;
  }

  return "";
}

async function executeOnchainRefund(transaction) {
  const treasury = mpesaConfig.treasury || {};
  if (!treasury.refundEnabled) {
    throw new Error("Treasury refund is disabled.");
  }

  if (!hasTreasuryConfig()) {
    throw new Error(
      "Missing treasury refund configuration (TREASURY_RPC_URL, TREASURY_PRIVATE_KEY, TREASURY_USDC_CONTRACT)."
    );
  }

  const recipient = getRefundRecipient(transaction);
  if (!/^0x[a-f0-9]{40}$/.test(recipient)) {
    throw new Error("Refund recipient address is invalid.");
  }

  const amountUsd = getRefundAmountUsd(transaction);
  if (amountUsd <= 0) {
    throw new Error("Refund amount must be greater than zero.");
  }

  const decimals = Math.max(0, Math.min(18, Number(treasury.usdcDecimals || 6)));
  const amountUnits = ethers.parseUnits(amountUsd.toFixed(decimals), decimals);
  if (amountUnits <= 0n) {
    throw new Error("Refund amount rounds to zero.");
  }

  const provider = new ethers.JsonRpcProvider(treasury.rpcUrl, treasury.chainId || undefined);
  const signer = new ethers.Wallet(treasury.privateKey, provider);
  const token = new ethers.Contract(treasury.usdcContract, ERC20_ABI, signer);

  const tx = await token.transfer(recipient, amountUnits);
  const receipt = await tx.wait(Math.max(1, Number(treasury.waitConfirmations || 1)));
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error("On-chain refund transaction failed.");
  }

  return {
    txHash: tx.hash,
    mode: "onchain",
  };
}

async function executeRefund(transaction) {
  if (hasTreasuryConfig() && mpesaConfig.treasury?.refundEnabled !== false) {
    return executeOnchainRefund(transaction);
  }

  // Sandbox-first fallback when treasury is not configured yet.
  if (mpesaConfig.env === "sandbox") {
    return {
      txHash: pseudoRefundReference(),
      mode: "simulated",
    };
  }

  throw new Error(
    "Treasury refund config is required in production. Configure TREASURY_RPC_URL, TREASURY_PRIVATE_KEY, TREASURY_USDC_CONTRACT."
  );
}

async function scheduleAutoRefund(transaction, reason) {
  if (!mpesaConfig.refunds.autoRefund) return transaction;

  if (!["offramp", "paybill", "buygoods"].includes(transaction.flowType)) {
    return transaction;
  }

  if (transaction.status !== "failed") return transaction;

  assertTransition(transaction, "refund_pending", reason || "Auto refund pending", "refund_service");
  transaction.refund = {
    ...(transaction.refund || {}),
    status: "pending",
    reason: reason || "Auto refund",
    initiatedAt: new Date(),
  };

  try {
    const executed = await executeRefund(transaction);
    transaction.refund.status = "completed";
    transaction.refund.txHash = executed.txHash;
    transaction.refund.completedAt = new Date();
    transaction.refund.reason = reason || "Auto refund completed";
    assertTransition(
      transaction,
      "refunded",
      executed.mode === "onchain" ? "Auto refund completed on-chain" : "Auto refund completed (sandbox simulation)",
      "refund_service"
    );
  } catch (err) {
    transaction.refund.status = "failed";
    transaction.refund.reason = `${reason || "Auto refund failed"}: ${err.message}`;
    transaction.refund.completedAt = new Date();
    assertTransition(transaction, "failed", "Auto refund failed", "refund_service");
  }

  await transaction.save();
  return transaction;
}

module.exports = {
  scheduleAutoRefund,
};
