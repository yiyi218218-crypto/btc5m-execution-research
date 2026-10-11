import assert from "node:assert/strict";
import test from "node:test";

import {
  createReplayKernel,
  ReplayKernel,
} from "../../src/replay/replay-kernel.mjs";

function event(type, sequence, overrides = {}) {
  return {
    streamId: "token-up",
    type,
    sequence,
    exchangeTimestampMs: 1_700_000_000_000 + sequence,
    receivedTimestampMs: 1_700_000_000_100 + sequence,
    ...overrides,
  };
}

test("replay kernel applies a snapshot and contiguous deltas", () => {
  const kernel = createReplayKernel();
  assert.equal(kernel.ingest(event("SNAPSHOT", 10, {
    bids: [{ price: 0.45, size: 5 }],
    asks: [{ price: 0.47, size: 7 }],
  })).accepted, true);
  assert.equal(kernel.ingest(event("DELTA", 11, {
    changes: [
      { side: "BUY", price: 0.46, size: 3 },
      { side: "SELL", price: 0.47, size: 0 },
      { side: "SELL", price: 0.48, size: 9 },
    ],
  })).accepted, true);
  const snapshot = kernel.snapshot("token-up");
  assert.equal(snapshot.usable, true);
  assert.equal(snapshot.lastSequence, 11);
  assert.deepEqual(snapshot.book.bids.map((row) => row.price), [0.46, 0.45]);
  assert.deepEqual(snapshot.book.asks.map((row) => row.price), [0.48]);
});

test("sequence gaps invalidate the book until a fresh snapshot", () => {
  const kernel = createReplayKernel();
  kernel.ingest(event("SNAPSHOT", 20, {
    bids: [{ price: 0.4, size: 5 }],
    asks: [{ price: 0.6, size: 5 }],
  }));
  const gap = kernel.ingest(event("DELTA", 22, {
    changes: [{ side: "BUY", price: 0.41, size: 2 }],
  }));
  assert.equal(gap.reason, "REPLAY_SEQUENCE_GAP");
  assert.equal(gap.stream.usable, false);
  assert.equal(gap.stream.book, null);
  assert.equal(kernel.ingest(event("DELTA", 23, { changes: [] })).reason,
    "REPLAY_WAITING_FOR_SNAPSHOT");
  assert.equal(kernel.ingest(event("SNAPSHOT", 30, {
    bids: [{ price: 0.42, size: 8 }],
    asks: [{ price: 0.58, size: 8 }],
  })).accepted, true);
  assert.equal(kernel.snapshot("token-up").lastSequence, 30);
});

test("replay is deterministic and preserves timestamped raw evidence", () => {
  const events = [
    event("SNAPSHOT", 1, {
      bids: [{ price: 0.45, size: 5 }],
      asks: [{ price: 0.55, size: 5 }],
      raw: { source: "fixture" },
    }),
    event("DELTA", 2, {
      changes: [{ side: "BUY", price: 0.46, size: 2 }],
    }),
  ];
  const first = ReplayKernel.replay(events);
  const second = ReplayKernel.replay(events);
  assert.deepEqual(first.kernel.snapshot("token-up"), second.kernel.snapshot("token-up"));
  assert.deepEqual(first.kernel.exportLedger(), second.kernel.exportLedger());
  assert.equal(first.kernel.exportLedger()[0].event.raw.source, "fixture");
});

test("unsequenced snapshots are usable only until the first delta", () => {
  const kernel = createReplayKernel();
  const snapshot = event("SNAPSHOT", null, {
    sequence: null,
    bids: [{ price: 0.45, size: 5 }],
    asks: [{ price: 0.55, size: 5 }],
  });
  assert.equal(kernel.ingest(snapshot).accepted, true);
  assert.equal(kernel.snapshot("token-up").sequenceMode,
    "UNSEQUENCED_SNAPSHOT_ONLY");
  const delta = event("DELTA", null, {
    sequence: null,
    changes: [{ side: "BUY", price: 0.46, size: 3 }],
  });
  const result = kernel.ingest(delta);
  assert.equal(result.reason, "REPLAY_TRUSTED_SEQUENCE_REQUIRED");
  assert.equal(result.stream.usable, false);
  assert.equal(result.stream.state, "WAITING_SNAPSHOT");
});

test("only a newer full snapshot restores an unsequenced stream", () => {
  const kernel = createReplayKernel();
  kernel.ingest(event("SNAPSHOT", null, {
    sequence: null,
    exchangeTimestampMs: 100,
    receivedTimestampMs: 200,
    bids: [{ price: 0.45, size: 5 }],
    asks: [{ price: 0.55, size: 5 }],
  }));
  kernel.ingest(event("DELTA", null, {
    sequence: null,
    exchangeTimestampMs: 110,
    receivedTimestampMs: 210,
    changes: [{ side: "BUY", price: 0.46, size: 3 }],
  }));
  const stale = kernel.ingest(event("SNAPSHOT", null, {
    sequence: null,
    exchangeTimestampMs: 109,
    receivedTimestampMs: 220,
    bids: [{ price: 0.46, size: 3 }],
    asks: [{ price: 0.55, size: 5 }],
  }));
  assert.equal(stale.reason, "REPLAY_STALE_SNAPSHOT_TIMESTAMP");
  assert.equal(stale.stream.usable, false);
  const restored = kernel.ingest(event("SNAPSHOT", null, {
    sequence: null,
    exchangeTimestampMs: 111,
    receivedTimestampMs: 230,
    bids: [{ price: 0.47, size: 4 }],
    asks: [{ price: 0.56, size: 6 }],
  }));
  assert.equal(restored.accepted, true);
  assert.equal(restored.stream.usable, true);
});

test("online replay can disable ledger retention without losing record ordinals", () => {
  const kernel = createReplayKernel({ retainLedger: false });
  const first = kernel.ingest(event("SNAPSHOT", 1, {
    bids: [{ price: 0.45, size: 5 }],
    asks: [{ price: 0.55, size: 5 }],
    raw: { payload: "not-retained" },
  }));
  const second = kernel.ingest(event("DELTA", 2, {
    changes: [{ side: "BUY", price: 0.46, size: 3 }],
  }));
  assert.equal(first.ledgerIndex, 0);
  assert.equal(second.ledgerIndex, 1);
  assert.deepEqual(kernel.exportLedger(), []);
  assert.equal(kernel.snapshot("token-up").lastSequence, 2);
});
