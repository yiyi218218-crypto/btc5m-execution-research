import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTakerIocExecution } from "../../src/evaluation/btc5m-v6h1-economic-evaluator-v1.mjs";

test("complete PIT book with empty asks is reconstructed evidence but not a fill opportunity", () => {
  const result = evaluateTakerIocExecution({
    book: {
      asks: [],
      minimumOrderShares: 5,
      minimumOrderVerified: true,
      tickSize: 0.01,
      tickSizeVerified: true,
      takerFeeRate: 0.1,
      marketStateReconstructed: true,
      executionEvidenceComplete: true,
    },
    fixedStakeUsd: 5,
  });
  assert.equal(result.marketStateReconstructed, true);
  assert.equal(result.executionEvidenceComplete, true);
  assert.equal(result.fillOpportunity, false);
  assert.equal(result.simulatedFill, false);
  assert.equal(result.classification, "NO_DIRECT_ASK");
  assert.equal(result.executionReason, "NO_DIRECT_ASK");
  assert.equal(result.fillShares, 0);
});

test("empty asks without complete reconstruction remain unverified", () => {
  const result = evaluateTakerIocExecution({
    book: { asks: [], minimumOrderShares: 5, minimumOrderVerified: true, tickSize: 0.01, tickSizeVerified: true, takerFeeRate: 0.1 },
    fixedStakeUsd: 5,
  });
  assert.equal(result.executionEvidenceComplete, undefined);
  assert.equal(result.classification, "NO_DIRECT_ASK");
  assert.equal(result.executionReady, false);
});
