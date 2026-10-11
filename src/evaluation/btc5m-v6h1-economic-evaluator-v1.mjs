const EPSILON = 1e-9;

export const V6H1_ECONOMIC_EVALUATOR_SCHEMA = "btc5m-v6h1-economic-evaluator-v1";
export const V6H1_FIXED_WINDOW_STAKE_USD = 5;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rounded(value, digits = 10) {
  const number = finite(value, null);
  if (number == null) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function normalizeLevels(levels = []) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: finite(level?.price, null), shares: finite(level?.shares ?? level?.size, null) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.shares > 0)
    .sort((left, right) => left.price - right.price || right.shares - left.shares);
}

export function allInUnitCost(price, takerFeeRate) {
  const p = finite(price, null);
  const feeRate = finite(takerFeeRate, null);
  if (!(p > 0 && p < 1 && feeRate >= 0)) return null;
  return p * (1 + feeRate * (1 - p));
}

function levelOnTick(price, tickSize) {
  const tick = finite(tickSize, null);
  if (!(tick > 0)) return false;
  return Math.abs(price / tick - Math.round(price / tick)) <= 1e-8;
}

export function consumeAllInBudget({ asks = [], budgetUsd, takerFeeRate } = {}) {
  let remainingBudget = finite(budgetUsd, null);
  if (!(remainingBudget > 0)) return { shares: 0, principal: 0, fee: 0, allInCost: 0, depthExhausted: true, levelsConsumed: [] };
  let shares = 0;
  let principal = 0;
  let allInCost = 0;
  const levelsConsumed = [];
  for (const level of normalizeLevels(asks)) {
    if (remainingBudget <= EPSILON) break;
    const unitCost = allInUnitCost(level.price, takerFeeRate);
    if (!(unitCost > 0)) continue;
    const taken = Math.min(level.shares, remainingBudget / unitCost);
    if (!(taken > 0)) continue;
    const cost = taken * unitCost;
    shares += taken;
    principal += taken * level.price;
    allInCost += cost;
    remainingBudget -= cost;
    levelsConsumed.push({ price: level.price, shares: rounded(taken, 8), allInCost: rounded(cost, 8) });
  }
  return {
    shares: rounded(shares, 8),
    principal: rounded(principal, 8),
    fee: rounded(allInCost - principal, 8),
    allInCost: rounded(allInCost, 8),
    remainingBudget: rounded(Math.max(0, remainingBudget), 8),
    depthExhausted: remainingBudget > EPSILON,
    levelsConsumed,
  };
}

export function evaluateTakerIocExecution({ book = {}, fixedStakeUsd = V6H1_FIXED_WINDOW_STAKE_USD } = {}) {
  const asks = normalizeLevels(book.asks);
  const minimumOrderShares = finite(book.minOrderShares ?? book.minimumOrderShares ?? book.min_order_size, null);
  const tickSize = finite(book.tickSize ?? book.tick_size, null);
  const feeRate = finite(book.takerFeeRate ?? book.feeRate, null);
  const minimumVerified = book.minimumOrderVerified === true;
  const tickVerified = book.tickSizeVerified === true;
  const marketStateReconstructed = book.marketStateReconstructed === true;
  const executionEvidenceComplete = book.executionEvidenceComplete === true || marketStateReconstructed;
  const failures = [];
  if (!asks.length && !executionEvidenceComplete) failures.push("NO_DIRECT_ASK");
  if (!minimumVerified || !(minimumOrderShares > 0)) failures.push("MINIMUM_ORDER_UNVERIFIED");
  if (!tickVerified || !(tickSize > 0)) failures.push("TICK_SIZE_UNVERIFIED");
  if (!(feeRate >= 0)) failures.push("TAKER_FEE_UNVERIFIED");
  if (asks.length && tickVerified && tickSize > 0 && asks.some((level) => !levelOnTick(level.price, tickSize))) failures.push("ASK_NOT_ON_TICK");
  if (!asks.length && executionEvidenceComplete && !failures.length) {
    return {
      schemaVersion: V6H1_ECONOMIC_EVALUATOR_SCHEMA,
      executionReady: false,
      marketStateReconstructed: true,
      executionEvidenceComplete: true,
      fillOpportunity: false,
      simulatedFill: false,
      classification: "NO_DIRECT_ASK",
      executionReason: "NO_DIRECT_ASK",
      reason: "NO_DIRECT_ASK",
      failures: [],
      fillShares: 0,
      allInCost: 0,
      minimumOrderShares,
      tickSize,
      takerFeeRate: feeRate,
      fixedStakeUsd,
    };
  }
  if (failures.length) return { schemaVersion: V6H1_ECONOMIC_EVALUATOR_SCHEMA, executionReady: false, classification: failures[0], failures, fillShares: 0, allInCost: 0 };
  const execution = consumeAllInBudget({ asks, budgetUsd: fixedStakeUsd, takerFeeRate: feeRate });
  if (!(execution.shares + EPSILON >= minimumOrderShares)) {
    return { schemaVersion: V6H1_ECONOMIC_EVALUATOR_SCHEMA, executionReady: false, classification: "MINIMUM_ORDER_NOT_MET", failures: [], fillShares: execution.shares, ...execution, minimumOrderShares, tickSize, takerFeeRate: feeRate, fixedStakeUsd };
  }
  return {
    schemaVersion: V6H1_ECONOMIC_EVALUATOR_SCHEMA,
    executionReady: true,
    marketStateReconstructed,
    executionEvidenceComplete,
    fillOpportunity: true,
    simulatedFill: false,
    classification: execution.depthExhausted ? "INSUFFICIENT_DEPTH" : "EXECUTABLE_FULL_STAKE",
    failures: [],
    minimumOrderShares,
    tickSize,
    takerFeeRate: feeRate,
    fixedStakeUsd,
    fillShares: execution.shares,
    vwap: execution.shares > 0 ? rounded(execution.principal / execution.shares, 10) : null,
    allInCostPerShare: execution.shares > 0 ? rounded(execution.allInCost / execution.shares, 10) : null,
    ...execution,
  };
}

export function evaluateCandidateEconomics({ side, modelProbability, book, fixedStakeUsd = V6H1_FIXED_WINDOW_STAKE_USD } = {}) {
  const probability = finite(modelProbability, null);
  const execution = evaluateTakerIocExecution({ book, fixedStakeUsd });
  if (!(probability >= 0 && probability <= 1)) return { execution, action: "NO_ACTION", reason: "MODEL_PROBABILITY_INVALID", predictedEdgePerShare: null, expectedNetPnl: null };
  if (!execution.executionReady || !(execution.shares > 0)) return { execution, action: "NO_ACTION", reason: execution.classification, predictedEdgePerShare: null, expectedNetPnl: null };
  const predictedEdgePerShare = probability - execution.allInCostPerShare;
  const expectedNetPnl = probability * execution.shares - execution.allInCost;
  return {
    execution,
    side: side || null,
    modelProbability: probability,
    predictedEdgePerShare: rounded(predictedEdgePerShare, 10),
    expectedNetPnl: rounded(expectedNetPnl, 10),
    action: expectedNetPnl > 0 ? "OPEN" : "NO_ACTION",
    reason: expectedNetPnl > 0 ? "POSITIVE_EXPECTED_NET_PNL" : "NO_POSITIVE_EXPECTED_NET_PNL",
  };
}

export function settleSimulatedFill({ side, winner, shares, allInCost } = {}) {
  const normalizedSide = side === "Up" || side === "Down" ? side : null;
  const normalizedWinner = winner === "Up" || winner === "Down" ? winner : null;
  const fillShares = finite(shares, null);
  const cost = finite(allInCost, null);
  if (!normalizedSide || !normalizedWinner || !(fillShares > 0) || !(cost >= 0)) return { settlementStatus: "INVALID", netPnl: null };
  const payout = normalizedSide === normalizedWinner ? fillShares : 0;
  return { settlementStatus: "SETTLED", side: normalizedSide, winner: normalizedWinner, shares: rounded(fillShares, 8), payout: rounded(payout, 8), allInCost: rounded(cost, 8), netPnl: rounded(payout - cost, 8) };
}

export { normalizeLevels };
