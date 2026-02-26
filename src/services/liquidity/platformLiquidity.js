const { ethers } = require("ethers");
const { mpesaConfig } = require("../../config/mpesa");
const { MpesaTransaction } = require("../../models/MpesaTransaction");

const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

const LIQUIDITY_CACHE_TTL_MS = Math.max(
  5,
  Number(process.env.MPESA_LIQUIDITY_CACHE_TTL_SECONDS || 20)
) * 1000;

const OUTFLOW_FLOWS = ["offramp", "paybill", "buygoods"];

const ROUNDING_EPSILON = 1e-9;

const cache = {
  fetchedAt: 0,
  state: null,
};

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function toSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getMpesaSeedBalanceKes() {
  return toSafeNumber(process.env.MPESA_TRACKED_START_BALANCE_KES, 0);
}

function getMpesaManualAdjustmentKes() {
  return toSafeNumber(process.env.MPESA_TRACKED_BALANCE_ADJUSTMENT_KES, 0);
}

function getMpesaMinReserveKes() {
  return Math.max(0, toSafeNumber(process.env.MPESA_MIN_PAYOUT_RESERVE_KES, 0));
}

function getTreasuryMinNativeGasEth() {
  return Math.max(0, toSafeNumber(process.env.TREASURY_MIN_NATIVE_GAS_ETH, 0.00005));
}

async function aggregateNumericSum({ match, fieldPath }) {
  const rows = await MpesaTransaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $ifNull: [`$${fieldPath}`, 0],
          },
        },
      },
    },
  ]);
  return toSafeNumber(rows?.[0]?.total, 0);
}

async function getTreasuryOnchainBalance() {
  const treasury = mpesaConfig.treasury || {};
  const rpcUrl = String(treasury.rpcUrl || "").trim();
  const treasuryAddress = String(treasury.address || "").trim().toLowerCase();
  const tokenAddress = String(treasury.usdcContract || "").trim();
  const decimals = Math.max(0, Math.min(18, Number(treasury.usdcDecimals || 6)));
  const chainId = Number(treasury.chainId || 0) || null;

  if (!rpcUrl) {
    throw new Error("TREASURY_RPC_URL is not configured.");
  }
  if (!treasuryAddress || !/^0x[a-f0-9]{40}$/.test(treasuryAddress)) {
    throw new Error("TREASURY_PLATFORM_ADDRESS is not configured correctly.");
  }
  if (!tokenAddress || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
    throw new Error("TREASURY_USDC_CONTRACT is not configured correctly.");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId || undefined);
  const token = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);

  const [tokenUnits, nativeWei] = await Promise.all([
    token.balanceOf(treasuryAddress),
    provider.getBalance(treasuryAddress),
  ]);

  const tokenUnitsStr = tokenUnits.toString();
  const tokenUsd = Number(ethers.formatUnits(tokenUnits, decimals));
  const nativeEth = Number(ethers.formatEther(nativeWei));

  return {
    treasuryAddress,
    usdcContract: tokenAddress.toLowerCase(),
    usdcDecimals: decimals,
    chainId,
    usdcBalanceUnits: tokenUnitsStr,
    usdcBalanceUsd: round(tokenUsd, 6),
    nativeBalanceWei: nativeWei.toString(),
    nativeBalanceEth: round(nativeEth, 8),
  };
}

async function getMpesaTrackedBalance() {
  const inflowSucceededKesPromise = aggregateNumericSum({
    match: { flowType: "onramp", status: "succeeded" },
    fieldPath: "quote.amountKes",
  });

  const outflowSucceededKesPromise = aggregateNumericSum({
    match: { flowType: { $in: OUTFLOW_FLOWS }, status: "succeeded" },
    fieldPath: "quote.expectedReceiveKes",
  });

  const reservedOutflowKesPromise = aggregateNumericSum({
    match: {
      flowType: { $in: OUTFLOW_FLOWS },
      status: { $in: ["mpesa_submitted", "mpesa_processing"] },
    },
    fieldPath: "quote.expectedReceiveKes",
  });

  const [
    inflowSucceededKes,
    outflowSucceededKes,
    reservedOutflowKes,
  ] = await Promise.all([
    inflowSucceededKesPromise,
    outflowSucceededKesPromise,
    reservedOutflowKesPromise,
  ]);

  const seedBalanceKes = getMpesaSeedBalanceKes();
  const manualAdjustmentKes = getMpesaManualAdjustmentKes();
  const minReserveKes = getMpesaMinReserveKes();
  const trackedBalanceKes = seedBalanceKes + manualAdjustmentKes + inflowSucceededKes - outflowSucceededKes;
  const availableForPayoutKes = trackedBalanceKes - reservedOutflowKes - minReserveKes;

  return {
    seedBalanceKes: round(seedBalanceKes, 2),
    manualAdjustmentKes: round(manualAdjustmentKes, 2),
    inflowSucceededKes: round(inflowSucceededKes, 2),
    outflowSucceededKes: round(outflowSucceededKes, 2),
    trackedBalanceKes: round(trackedBalanceKes, 2),
    reservedOutflowKes: round(reservedOutflowKes, 2),
    minReserveKes: round(minReserveKes, 2),
    availableForPayoutKes: round(availableForPayoutKes, 2),
  };
}

async function getReservedOnrampCreditUsd() {
  return aggregateNumericSum({
    match: {
      flowType: "onramp",
      $or: [
        { status: { $in: ["mpesa_submitted", "mpesa_processing"] } },
        {
          status: "succeeded",
          $or: [
            { "onchain.verificationStatus": { $ne: "verified" } },
            { "onchain.txHash": { $exists: false } },
            { "onchain.txHash": null },
            { "onchain.txHash": "" },
          ],
        },
      ],
    },
    fieldPath: "quote.amountUsd",
  });
}

async function computePlatformLiquidityState() {
  const [treasuryOnchain, mpesaTracked, reservedOnrampUsdRaw] = await Promise.all([
    getTreasuryOnchainBalance(),
    getMpesaTrackedBalance(),
    getReservedOnrampCreditUsd(),
  ]);

  const reservedOnrampUsd = round(reservedOnrampUsdRaw, 6);
  const availableForOnrampUsd = round(
    treasuryOnchain.usdcBalanceUsd - reservedOnrampUsd,
    6
  );

  return {
    asOf: new Date().toISOString(),
    onchain: {
      ...treasuryOnchain,
      reservedOnrampCreditUsd: reservedOnrampUsd,
      availableForOnrampUsd,
      minNativeGasEth: getTreasuryMinNativeGasEth(),
    },
    mpesa: {
      ...mpesaTracked,
    },
  };
}

async function getPlatformLiquidityState({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.state && now - cache.fetchedAt < LIQUIDITY_CACHE_TTL_MS) {
    return cache.state;
  }

  const state = await computePlatformLiquidityState();
  cache.state = state;
  cache.fetchedAt = now;
  return state;
}

function requireQuote(quote) {
  if (!quote || typeof quote !== "object") {
    throw new Error("Quote is required for liquidity checks.");
  }
}

function formatKes(value) {
  return round(value, 2).toFixed(2);
}

function formatUsd(value) {
  return round(value, 6).toFixed(6);
}

async function assertLiquidityForQuote({ flowType, quote, source = "unknown" }) {
  requireQuote(quote);
  const normalizedFlow = String(flowType || "").trim().toLowerCase();
  const state = await getPlatformLiquidityState({ forceRefresh: true });

  if (normalizedFlow === "onramp") {
    const requiredUsd = toSafeNumber(quote.amountUsd, 0);
    const availableUsd = toSafeNumber(state?.onchain?.availableForOnrampUsd, 0);
    const nativeBalanceEth = toSafeNumber(state?.onchain?.nativeBalanceEth, 0);
    const minNativeGasEth = toSafeNumber(state?.onchain?.minNativeGasEth, 0);

    if (requiredUsd > availableUsd + ROUNDING_EPSILON) {
      throw new Error(
        `Top up unavailable right now: treasury has USD ${formatUsd(
          availableUsd
        )} available, but USD ${formatUsd(requiredUsd)} is required.`
      );
    }

    if (nativeBalanceEth + ROUNDING_EPSILON < minNativeGasEth) {
      throw new Error(
        `Top up unavailable right now: treasury gas is low (${nativeBalanceEth} ETH).`
      );
    }

    return state;
  }

  if (OUTFLOW_FLOWS.includes(normalizedFlow)) {
    const requiredKes = toSafeNumber(quote.expectedReceiveKes || quote.amountKes, 0);
    const availableKes = toSafeNumber(state?.mpesa?.availableForPayoutKes, 0);
    if (requiredKes > availableKes + ROUNDING_EPSILON) {
      throw new Error(
        `Insufficient M-Pesa float: available KSh ${formatKes(
          availableKes
        )}, required KSh ${formatKes(requiredKes)}.`
      );
    }
    return state;
  }

  return state;
}

function clearPlatformLiquidityCache() {
  cache.fetchedAt = 0;
  cache.state = null;
}

module.exports = {
  getPlatformLiquidityState,
  assertLiquidityForQuote,
  clearPlatformLiquidityCache,
};
