# BTC 5-minute execution research

This is a compact, **read-only research snapshot** from a larger local Polymarket BTC five-minute project. It demonstrates deterministic order-book replay and a fee/depth-aware, simulated IOC execution evaluation. It does not connect to a wallet, submit orders, or claim a profitable trading strategy.

## Provenance and attribution

The source project's README credits **[@angshengji48540](https://x.com/angshengji48540)** as its original author. This limited public snapshot was curated from that project with permission. The research snapshot preserves its original source filenames and test contracts. It is published here as a portfolio artifact with attribution; it is not presented as wholly original code by the account owner. No open-source reuse license is asserted for the original code.

## Included

- `src/replay/replay-kernel.mjs`: book snapshot/delta replay, sequence-gap invalidation, deterministic evidence ledger.
- `src/evaluation/btc5m-v6h1-economic-evaluator-v1.mjs`: simulated taker execution with order depth, minimum size, price ticks, and fees.
- Two deterministic test files with synthetic order books.

## Run

Node.js 20 or newer:

```bash
npm test
```

The snapshot contains no private keys, API credentials, live order wiring, trading history, captured market tapes, or Git history from the source project. Results are research checks, not investment advice or live execution evidence.
