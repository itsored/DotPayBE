const { ethers } = require("ethers");
const { mpesaConfig } = require("../../config/mpesa");
const { assertTransition } = require("../mpesa/stateMachine");

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
];

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function isAddress(value) {
  return /^0x[a-f0-9]{40}$/.test(normalizeAddress(value));
}

function getTreasuryWalletAddress() {
  const configured = normalizeAddress(mpesaConfig.treasury?.address || "");
  if (isAddress(configured)) return configured;
  const privateKey = String(mpesaConfig.treasury?.privateKey || "").trim();
  if (!privateKey) return "";
  try {
    return normalizeAddress(new ethers.Wallet(privateKey).address);
  } catch {
    return "";
  }
}

function getCreditRecipient(tx) {
  const explicit = normalizeAddress(tx?.onchain?.toAddress || "");
  if (isAddress(explicit)) return explicit;

  const userAddress = normalizeAddress(tx?.userAddress || "");
  if (isAddress(userAddress)) return userAddress;

  return "";
}

function getCreditAmount(tx) {
  const amountUsd = Number(tx?.quote?.amountUsd || 0);
  if (Number.isFinite(amountUsd) && amountUsd > 0) return amountUsd;
  return 0;
}

function ensureTreasuryConfig() {
  const treasury = mpesaConfig.treasury || {};
  const missing = [];

  if (!String(treasury.rpcUrl || "").trim()) missing.push("TREASURY_RPC_URL");
  if (!String(treasury.privateKey || "").trim()) missing.push("TREASURY_PRIVATE_KEY");
  if (!String(treasury.usdcContract || "").trim()) missing.push("TREASURY_USDC_CONTRACT");
  if (!getTreasuryWalletAddress()) missing.push("TREASURY_PLATFORM_ADDRESS (or TREASURY_PRIVATE_KEY)");

  if (missing.length > 0) {
    throw new Error(`Missing treasury settlement config: ${missing.join(", ")}`);
  }
}

async function settleOnrampCredit(tx, options = {}) {
  const source = String(options.source || "system").trim() || "system";
  if (!tx) throw new Error("Transaction is required.");
  if (tx.flowType !== "onramp") throw new Error("settleOnrampCredit supports onramp only.");

  tx.onchain = tx.onchain || {};

  // Idempotent guard: already credited.
  if (tx.onchain.verificationStatus === "verified" && tx.onchain.txHash) {
    return {
      credited: false,
      reason: "already_credited",
      txHash: tx.onchain.txHash,
    };
  }

  ensureTreasuryConfig();
  const recipient = getCreditRecipient(tx);
  if (!recipient) {
    tx.onchain.verificationStatus = "failed";
    tx.onchain.verificationError = "Topup recipient wallet is missing or invalid.";
    tx.onchain.verifiedBy = source;
    tx.onchain.verifiedAt = new Date();
    await tx.save();
    return { credited: false, reason: "failed", error: tx.onchain.verificationError };
  }

  const amountUsd = getCreditAmount(tx);
  if (amountUsd <= 0) {
    tx.onchain.verificationStatus = "failed";
    tx.onchain.verificationError = "Topup credit amount is invalid.";
    tx.onchain.verifiedBy = source;
    tx.onchain.verifiedAt = new Date();
    await tx.save();
    return { credited: false, reason: "failed", error: tx.onchain.verificationError };
  }

  const treasury = mpesaConfig.treasury || {};
  const decimals = Math.max(0, Math.min(18, Number(treasury.usdcDecimals || 6)));
  const amountUnits = ethers.parseUnits(amountUsd.toFixed(decimals), decimals);
  if (amountUnits <= 0n) {
    tx.onchain.verificationStatus = "failed";
    tx.onchain.verificationError = "Topup credit amount rounds to zero.";
    tx.onchain.verifiedBy = source;
    tx.onchain.verifiedAt = new Date();
    await tx.save();
    return { credited: false, reason: "failed", error: tx.onchain.verificationError };
  }

  const chainId = Number(treasury.chainId || 0) || null;
  const tokenAddress = normalizeAddress(treasury.usdcContract);
  const treasuryAddress = getTreasuryWalletAddress();

  tx.onchain.required = false;
  tx.onchain.tokenSymbol = "USDC";
  tx.onchain.tokenAddress = tokenAddress;
  tx.onchain.treasuryAddress = treasuryAddress;
  tx.onchain.chainId = chainId;
  tx.onchain.toAddress = recipient;
  tx.onchain.expectedAmountUsd = amountUsd;
  tx.onchain.expectedAmountUnits = amountUnits.toString();
  tx.onchain.verificationStatus = "pending";
  tx.onchain.verificationError = null;
  tx.onchain.verifiedBy = source;
  tx.onchain.verifiedAt = new Date();
  await tx.save();

  try {
    const provider = new ethers.JsonRpcProvider(treasury.rpcUrl, chainId || undefined);
    const signer = new ethers.Wallet(treasury.privateKey, provider);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    const transferTx = await token.transfer(recipient, amountUnits);
    const receipt = await transferTx.wait(Math.max(1, Number(treasury.waitConfirmations || 1)));
    if (!receipt || Number(receipt.status) !== 1) {
      throw new Error("On-chain topup credit transaction failed.");
    }

    tx.onchain.txHash = normalizeAddress(transferTx.hash);
    tx.onchain.fundedAmountUnits = amountUnits.toString();
    tx.onchain.fundedAmountUsd = amountUsd;
    tx.onchain.fromAddress = treasuryAddress;
    tx.onchain.toAddress = recipient;
    tx.onchain.logIndex = null;
    tx.onchain.verificationStatus = "verified";
    tx.onchain.verificationError = null;
    tx.onchain.verifiedBy = source;
    tx.onchain.verifiedAt = new Date();

    if (tx.status === "mpesa_submitted") {
      assertTransition(tx, "mpesa_processing", "Waiting for on-chain topup credit", source);
    }
    if (tx.status === "mpesa_processing") {
      assertTransition(tx, "succeeded", "On-chain topup credit completed", source);
    }
    await tx.save();

    return {
      credited: true,
      reason: "credited",
      txHash: tx.onchain.txHash,
      toAddress: recipient,
      amountUnits: tx.onchain.fundedAmountUnits,
      amountUsd: tx.onchain.fundedAmountUsd,
    };
  } catch (err) {
    tx.onchain.verificationStatus = "failed";
    tx.onchain.verificationError = err?.message || "On-chain topup credit failed.";
    tx.onchain.verifiedBy = source;
    tx.onchain.verifiedAt = new Date();
    await tx.save();

    return {
      credited: false,
      reason: "failed",
      error: tx.onchain.verificationError,
    };
  }
}

module.exports = {
  settleOnrampCredit,
};

