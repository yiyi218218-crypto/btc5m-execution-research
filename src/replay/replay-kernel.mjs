export const REPLAY_STREAM_STATES = Object.freeze({
  WAITING_SNAPSHOT: "WAITING_SNAPSHOT",
  READY: "READY",
});

export const REPLAY_EVENT_TYPES = Object.freeze({
  SNAPSHOT: "SNAPSHOT",
  DELTA: "DELTA",
});

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integer(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeLevel(level) {
  const price = finite(level?.price ?? level?.p);
  const size = finite(level?.size ?? level?.s ?? level?.shares);
  if (!(price > 0) || !(size >= 0)) return null;
  return { price, size };
}

function normalizeLevels(levels, descending) {
  const byPrice = new Map();
  for (const input of Array.isArray(levels) ? levels : []) {
    const level = normalizeLevel(input);
    if (!level) continue;
    if (level.size === 0) byPrice.delete(level.price);
    else byPrice.set(level.price, level);
  }
  return [...byPrice.values()].sort((left, right) =>
    descending ? right.price - left.price : left.price - right.price);
}

function normalizedBook(input = {}) {
  const book = {
    bids: normalizeLevels(input.bids, true),
    asks: normalizeLevels(input.asks, false),
  };
  if (book.bids.length && book.asks.length
    && book.bids[0].price >= book.asks[0].price) {
    throw new Error("REPLAY_CROSSED_BOOK");
  }
  return book;
}

function applyChanges(book, changes) {
  const bids = new Map(book.bids.map((level) => [level.price, { ...level }]));
  const asks = new Map(book.asks.map((level) => [level.price, { ...level }]));
  for (const input of Array.isArray(changes) ? changes : []) {
    const level = normalizeLevel(input);
    const side = String(input?.side || "").toUpperCase();
    if (!level || !["BUY", "SELL", "BID", "ASK"].includes(side)) {
      throw new Error("REPLAY_INVALID_DELTA_LEVEL");
    }
    const target = side === "BUY" || side === "BID" ? bids : asks;
    if (level.size === 0) target.delete(level.price);
    else target.set(level.price, level);
  }
  return normalizedBook({
    bids: [...bids.values()],
    asks: [...asks.values()],
  });
}

function initialStream(streamId) {
  return {
    streamId,
    state: REPLAY_STREAM_STATES.WAITING_SNAPSHOT,
    usable: false,
    lastSequence: null,
    lastExchangeTimestampMs: null,
    lastReceivedTimestampMs: null,
    sequenceMode: "UNKNOWN",
    gapCount: 0,
    book: null,
  };
}

function normalizeEvent(input = {}) {
  const streamId = String(input.streamId ?? input.assetId ?? "").trim();
  const type = String(input.type ?? input.kind ?? "").trim().toUpperCase();
  const sequence = integer(input.sequence);
  const exchangeTimestampMs = finite(
    input.exchangeTimestampMs ?? input.exchangeTs ?? input.timestamp,
  );
  const receivedTimestampMs = finite(
    input.receivedTimestampMs ?? input.receivedAtMs ?? input.receiveTimestampMs,
  );
  if (!streamId) throw new Error("REPLAY_STREAM_ID_REQUIRED");
  if (!Object.values(REPLAY_EVENT_TYPES).includes(type)) {
    throw new Error("REPLAY_EVENT_TYPE_INVALID");
  }
  if (!(exchangeTimestampMs > 0) || !(receivedTimestampMs > 0)) {
    throw new Error("REPLAY_TIMESTAMP_INVALID");
  }
  return {
    streamId,
    type,
    sequence,
    exchangeTimestampMs,
    receivedTimestampMs,
    hash: input.hash == null ? null : String(input.hash),
    bids: clone(input.bids),
    asks: clone(input.asks),
    changes: clone(input.changes ?? input.priceChanges),
    raw: clone(input.raw ?? null),
  };
}

export class ReplayKernel {
  constructor(options = {}) {
    this.maximumClockSkewMs = Math.max(0, finite(options.maximumClockSkewMs) ?? 30_000);
    this.retainLedger = options.retainLedger !== false;
    this.streams = new Map();
    this.ledger = [];
    this.ledgerRecordCount = 0;
  }

  stream(streamId) {
    const key = String(streamId || "");
    if (!this.streams.has(key)) this.streams.set(key, initialStream(key));
    return this.streams.get(key);
  }

  record(event, accepted, reason, stream) {
    const ledgerIndex = this.ledgerRecordCount;
    this.ledgerRecordCount += 1;
    if (this.retainLedger) {
      this.ledger.push(Object.freeze({
        index: ledgerIndex,
        accepted,
        reason,
        event: clone(event),
        streamState: stream.state,
        usable: stream.usable,
        lastSequence: stream.lastSequence,
      }));
    }
    return {
      accepted,
      reason,
      stream: this.snapshot(event.streamId),
      ledgerIndex,
    };
  }

  ingest(input = {}) {
    const event = normalizeEvent(input);
    const stream = this.stream(event.streamId);
    if (event.exchangeTimestampMs
      > event.receivedTimestampMs + this.maximumClockSkewMs) {
      return this.record(event, false, "REPLAY_EXCHANGE_CLOCK_AHEAD", stream);
    }

    if (event.type === REPLAY_EVENT_TYPES.SNAPSHOT) {
      if (stream.lastSequence != null && event.sequence != null
        && event.sequence < stream.lastSequence) {
        return this.record(event, false, "REPLAY_STALE_SNAPSHOT", stream);
      }
      if (stream.lastExchangeTimestampMs != null
        && event.exchangeTimestampMs < stream.lastExchangeTimestampMs) {
        return this.record(event, false, "REPLAY_STALE_SNAPSHOT_TIMESTAMP", stream);
      }
      let book;
      try {
        book = normalizedBook(event);
      } catch (error) {
        return this.record(event, false, error.message, stream);
      }
      stream.state = REPLAY_STREAM_STATES.READY;
      stream.usable = true;
      stream.lastSequence = event.sequence;
      stream.sequenceMode = event.sequence == null
        ? "UNSEQUENCED_SNAPSHOT_ONLY"
        : "TRUSTED_CONTIGUOUS";
      stream.lastExchangeTimestampMs = event.exchangeTimestampMs;
      stream.lastReceivedTimestampMs = event.receivedTimestampMs;
      stream.book = book;
      return this.record(event, true, "REPLAY_SNAPSHOT_APPLIED", stream);
    }

    if (stream.state !== REPLAY_STREAM_STATES.READY || !stream.book) {
      return this.record(event, false, "REPLAY_WAITING_FOR_SNAPSHOT", stream);
    }
    if (event.sequence == null
      || stream.sequenceMode !== "TRUSTED_CONTIGUOUS"
      || stream.lastSequence == null) {
      stream.state = REPLAY_STREAM_STATES.WAITING_SNAPSHOT;
      stream.usable = false;
      stream.book = null;
      stream.gapCount += 1;
      stream.lastExchangeTimestampMs = Math.max(
        stream.lastExchangeTimestampMs ?? 0,
        event.exchangeTimestampMs,
      );
      stream.lastReceivedTimestampMs = Math.max(
        stream.lastReceivedTimestampMs ?? 0,
        event.receivedTimestampMs,
      );
      return this.record(event, false, "REPLAY_TRUSTED_SEQUENCE_REQUIRED", stream);
    }
    if (event.sequence <= stream.lastSequence) {
      return this.record(event, false, "REPLAY_STALE_SEQUENCE", stream);
    }
    if (event.sequence !== stream.lastSequence + 1) {
      stream.state = REPLAY_STREAM_STATES.WAITING_SNAPSHOT;
      stream.usable = false;
      stream.book = null;
      stream.gapCount += 1;
      return this.record(event, false, "REPLAY_SEQUENCE_GAP", stream);
    }
    if (event.exchangeTimestampMs < stream.lastExchangeTimestampMs
      || event.receivedTimestampMs < stream.lastReceivedTimestampMs) {
      stream.state = REPLAY_STREAM_STATES.WAITING_SNAPSHOT;
      stream.usable = false;
      stream.book = null;
      stream.gapCount += 1;
      return this.record(event, false, "REPLAY_TIMESTAMP_REGRESSION", stream);
    }

    let book;
    try {
      book = applyChanges(stream.book, event.changes);
    } catch (error) {
      stream.state = REPLAY_STREAM_STATES.WAITING_SNAPSHOT;
      stream.usable = false;
      stream.book = null;
      return this.record(event, false, error.message, stream);
    }
    stream.book = book;
    stream.lastSequence = event.sequence;
    stream.lastExchangeTimestampMs = event.exchangeTimestampMs;
    stream.lastReceivedTimestampMs = event.receivedTimestampMs;
    return this.record(event, true, "REPLAY_DELTA_APPLIED", stream);
  }

  snapshot(streamId) {
    const stream = this.streams.get(String(streamId || ""));
    return stream ? clone(stream) : clone(initialStream(String(streamId || "")));
  }

  exportLedger() {
    return clone(this.ledger);
  }

  static replay(events, options = {}) {
    const kernel = new ReplayKernel(options);
    const results = [];
    for (const event of events || []) results.push(kernel.ingest(event));
    return { kernel, results };
  }
}

export function createReplayKernel(options = {}) {
  return new ReplayKernel(options);
}
