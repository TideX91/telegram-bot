# Contributor fixture guide

This guide explains how to add **credential-free fixtures** for the Mimir
Telegram notifier. Automated tests must stay deterministic: no Soroban RPC
calls, no Telegram API calls, no bot tokens, and no signing keys.

The chain is the source of truth. This bot is a read-only notifier — fixtures
model decoded events and cursor files, never private material.

## Quick start (clean checkout)

```bash
npm ci
npm run typecheck
npm test
```

`npm test` builds `src/` → `dist/`, then runs every `tests/*.test.mjs` file with
Node's built-in test runner (the same path CI uses).

Live Testnet scanning is **manual and separate**:

```bash
npm run scan -- --pages 5 --show 5
```

Do not wire `npm run scan` into automated tests.

## Where fixtures live

| Path | Purpose |
| --- | --- |
| `tests/fixtures/events.json` | Decoded event cases for `formatEvent` / notifier fakes |
| `tests/fixtures/cursor-valid.json` | Well-formed `data/cursor.json` shape for restart docs |
| `tests/fixtures/cursor-stale.json` | Cursor that fell below the RPC's retained window (restart gap) |
| `tests/fixtures/cursor-corrupt.txt` | Unreadable cursor sample (cold-start path) |
| `tests/fixtures.test.mjs` | Loads the fixture catalog and asserts notify / skip / boundary behaviour |
| `tests/format.test.mjs` | Inline unit cases (MarkdownV2 escape, USDC decimals, send failures) |
| `tests/poller.test.mjs` | Restart-gap detection and cursor-window boundary cases against a fake RPC |

## Event fixture schema

`events.json` is a catalog:

```json
{
  "config": {
    "chatId": "-1001234567890",
    "marketContractId": "CFIXTUREMARKET00000000000000000000000000000000000000000",
    "squadContractId": "CFIXTURESQUAD0000000000000000000000000000000000000000000",
    "rpcUrl": "https://example.invalid/rpc",
    "horizonUrl": "https://example.invalid/horizon",
    "networkPassphrase": "Test SDF Network ; September 2015"
  },
  "cases": [
    {
      "id": "claim_challenged_happy",
      "kind": "positive",
      "expect": "notify",
      "messageIncludes": ["challenged", "2\\.0000000 USDC"],
      "event": { "...": "DecodedEvent shape; money fields are decimal strings" }
    }
  ]
}
```

Rules:

1. **Money fields are decimal strings** (`"20000000"`), never live JSON numbers
   for large `i128` values. The fixture loader converts known money keys to
   `bigint` before calling `formatEvent`.
2. **Contract ids, addresses, tx hashes, and cursors are stable fakes.** Prefer
   `CFIXTURE…` / `GFIXTURE…` prefixes so grepping the suite never looks like
   production secrets.
3. **RPC / Horizon URLs must be non-routable** (`example.invalid`) so a buggy
   test cannot accidentally hit Testnet.
4. **Never put `BOT_TOKEN`, payment proofs, or private keys in fixtures or
   assertions.** Logs and error messages under test must stay free of those.

### Case kinds (what to cover)

| `kind` | Intent | Typical `expect` |
| --- | --- | --- |
| `positive` | Happy-path notification for a known market/squad event | `notify` |
| `negative` | Malformed / unknown / admin-shaped payload → no chat message | `skip` |
| `boundary` | Clipping, reserved MarkdownV2 chars, zero/max amounts | `notify` or `skip` |
| `restart` | Documents cursor resume, restart-gap reset, and corrupt-file cold start (see cursor fixtures) | n/a in format suite |

`expect: "notify"` requires a non-null MarkdownV2 string from `formatEvent`.
`expect: "skip"` requires `null` (or an `unknown` payload that the poller would
log and not post).

## Cursor fixtures and restart safety

- **Valid cursor** (`cursor-valid.json`): version `1`, per-target opaque
  `cursor` string + `lastEventLedger`. Matches what the poller write-then-renames
  under `CURSOR_FILE` (default `./data/cursor.json`).
- **Stale cursor** (`cursor-stale.json`): same shape, but the cursor's ledger
  (`4250000`, i.e. `TOID >> 32`) sits below a sample retained floor of `4300000`.
  The poller must classify it as a **restart gap**, log it once, and reset that
  target to a cold start — never retry it forever behind a floor that has
  already moved past it.
- **Corrupt cursor** (`cursor-corrupt.txt`): not JSON. The poller must treat this
  as a **cold start**, not a crash — leave the in-memory cursor null and begin
  `START_LOOKBACK_LEDGERS` behind tip.

When you add persistence tests:

- Point `CURSOR_FILE` at a path under `os.tmpdir()`.
- Always unlink the temp file in `finally`, including after failed assertions.
- Never commit a real runtime `data/cursor.json` from a live bot.

## Failure-mode expectations (keep fixtures aligned)

| Failure | Cursor | Notification | Fixture tip |
| --- | --- | --- | --- |
| RPC error for one contract | **unchanged** for that target | none that cycle | Fake rejected `readContractEvents`; assert cursor string identical |
| Telegram send error | **still advances** | counted as failed | Fake `sendMessage` reject; assert no token in the Error message |
| Corrupt cursor file | cold start | n/a | Use `cursor-corrupt.txt` contents |
| Cursor below the retained floor | **reset to cold start** | n/a | Use `cursor-stale.json`; assert `classifyCursorWindow` says `stale` |
| Cursor string with no readable ledger | **unchanged**, flagged `cursorUnreadable` | n/a | Pass a non-TOID cursor; assert no gap is recorded |
| Burst over cap | advances | extras skipped | Cap `MAX_NOTIFICATIONS_PER_CYCLE` in the fake config |

## Adding a new fixture case

1. Pick the contract event from `src/stellar/decode.ts` (topic order + value map).
2. Append a case to `tests/fixtures/events.json` with a unique `id`.
3. Run `npm test` and extend assertions in `tests/fixtures.test.mjs` only if the
   catalog runner needs a new expect mode.
4. If behaviour changes ops (env vars, cursor shape), update this guide and the
   README "Development checks" link in the same PR.

## Out of scope for fixtures

- Signing transactions or holding keys
- Real `@BotFather` tokens or production chat ids
- Changing Mimir contract semantics
- Making CI depend on live RPC or Telegram
