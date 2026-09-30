# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

**Malformed-event robustness**

- `clip()` is now applied to the `category` field in `claim_created` notifications (bounded
  to 80 characters). `question` in `market_created` and `summary` in `claim_resolved` were
  already clipped at 200 characters. This prevents a crafted or unexpectedly long contract
  string from producing an oversized Telegram message or an unbounded log line.
- `clip()` is now exported from `src/notifications/format.ts` so it can be used from tests
  and shared utilities without re-implementing the cap logic.
- The event name and decode-error reason logged when skipping an `unknown` event are now
  bounded (80 and 120 characters respectively) to prevent unbounded remote payloads reaching
  log output.

**Stale cursor detection**

- The poller now warns when a persisted cursor points to a ledger that is more than 12 096
  ledgers (~10 % of the Testnet retention window) behind the RPC's current `oldestLedger`.
  Events in the gap will never be delivered; the warning names the cursor file path and
  explains how to recover (`delete the cursor file to cold-start`).
- The threshold constant `STALE_CURSOR_LEDGER_LAG` is documented inline.

**Configurable inter-send delay**

- New env var `INTER_SEND_DELAY_MS` (default `1500`) controls the pause between successive
  Telegram sends in one poll cycle. The previous hardcoded `1500 ms` constant is now a
  validated config field (`interSendDelayMs` on `BotConfig`), documented in `.env.example`,
  and accessible to tests without any fixed delay (`interSendDelayMs: 0`).

**Rate-cap logging**

- When `MAX_NOTIFICATIONS_PER_CYCLE` is reached the poller now emits a single
  `console.warn` for the entire cycle (not one per dropped event) that names the cap,
  explains what to do, and confirms that the cursor still advances.

**Consecutive-failure circuit-breaker logging**

- When the poller completes a cycle where every contract scan failed, it increments
  `consecutiveFailures` (this existed before). It now also emits a structured `console.warn`
  the first time the count crosses each threshold (5, 10, 25, 50, 100). The warning names
  the RPC URL, the last error (bounded to 200 characters), and confirms the cursor is intact.

**Cursor file version guard**

- `loadCursors()` now explicitly checks `parsed.version`. If the field is absent or is not
  `1`, the poller cold-starts and logs an actionable warning rather than silently proceeding
  with an unknown file layout. This protects against reading a cursor file written by a
  future release after a downgrade.

**Scanner CLI improvements**

- `--contract <market|squad>` flag added: scans only the named contract instead of both.
  Passing an unrecognised value exits immediately with a clear error message.
- `--help` / `-h` flag added: prints the full usage block and exits without making any
  network calls.
- `--pages` and `--show` flags now validate their arguments (must be integers within a
  stated range) and exit with an error rather than silently using `NaN`.
- `--show` is capped at 200 decoded events per contract (`SCAN_SHOW_MAX`).

**Log safety**

- The bot token, private keys, and payment proofs are never logged. No log path in the
  poller, bot, or config loader references `config.botToken`.
- Remote string payloads (`eventName`, decode reasons, error messages) that reach log lines
  are passed through `clip()` with explicit bounds before logging.
- `errMessage()` in `poller.ts` always returns a plain string, so stack traces from the RPC
  or grammy are bounded by JavaScript's own `Error.message` field rather than re-serialised
  response bodies.

### Changed

- `clip()` in `src/notifications/format.ts` is now `export`ed (was a module-private
  function). No callers outside the module existed before; making it exported enables direct
  testing without duplication.
- The standalone `events.ts` CLI `flag()` helper is joined by `flagBool()` and `flagInt()`
  to support the new validated flags.
- `SEND_SPACING_MS` in `poller.ts` (previously a module-level constant) is replaced by
  `config.interSendDelayMs` so the value is configurable without a code change.

### Tests

- **`tests/format.test.mjs`** — extended with 7 new cases:
  - `clip()` at exactly the boundary, over the boundary, empty string, and whitespace-only
    input.
  - Category bounded in `claim_created` notification.
  - Question bounded in `market_created` notification.
  - Summary bounded in `claim_resolved` notification.
- **`tests/config.test.mjs`** — new file, 22 cases:
  - `BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MARKET_CONTRACT_ID` required-field validation.
  - Multi-problem collection in one `ConfigError`.
  - `INTER_SEND_DELAY_MS`: default, `0`, custom value, non-integer, negative.
  - `MAX_NOTIFICATIONS_PER_CYCLE`: default, minimum (1), below minimum (0).
  - `POLL_INTERVAL_MS`: below 5000 rejected, exactly 5000 accepted.
  - Chat ID: numeric negative, `@channelusername`, invalid format.
  - `networkLabel`: testnet, public, custom.
  - `loadStellarConfig` works without Telegram credentials.
  - `ConfigError` message content and `problems` array.
- **`tests/poller.test.mjs`** — new file, 10 cases:
  - Version guard: no version field → cold-start + warning; version 99 → cold-start + warning;
    version 1 → no version warning.
  - Rate-cap warning text contains the cap value.
  - `interSendDelayMs` config field is present and typed correctly.
  - Circuit breaker: `consecutiveFailures` increments after all scans fail.
  - Stale cursor: warning emitted when lag exceeds threshold; no warning when within range.
  - Log safety: bot token does not appear in any log output during poller construction.

### CI

- `.github/workflows/ci.yml` now runs `npm test` (which includes `tsc` + all three test
  files) rather than running `npm run typecheck` and `npm run build` separately. The
  previous two-step job is replaced by a single `Build and test` step.

---

## Failure modes, cursor safety, and deployment impact

### Failure modes

| Failure | What happens | Recovery |
|---|---|---|
| RPC call fails | That contract's scan is skipped for one cycle; cursor is left untouched | Auto-resumes next cycle |
| RPC retention gap (stale cursor) | Warning logged; events in the gap are not posted | Delete cursor file; bot cold-starts from the current tip |
| Telegram send fails | One message is dropped; cursor still advances | None — notifications are lossy by design |
| Cursor file missing | Cold-start `START_LOOKBACK_LEDGERS` behind the tip | Normal operation |
| Cursor file unreadable or corrupt | Cold-start; warning logged | Normal operation |
| Cursor file has unknown version | Cold-start; warning logged with recovery instructions | Normal operation |
| All contracts fail for N consecutive cycles | Structured warning at thresholds 5, 10, 25, 50, 100 | Check RPC and Telegram connectivity |
| `MAX_NOTIFICATIONS_PER_CYCLE` reached | Remaining events in the cycle skipped; one warning logged; cursor advances | Raise the cap or wait for the backlog to drain |

### Cursor safety

The cursor file is written with a write-then-rename pattern (`.tmp` → final), so a crash
mid-write cannot produce a truncated file that replays the entire retained history.

The file includes a `version: 1` field. Future schema changes will use a different version
number; the poller will cold-start rather than silently misread an unknown layout.

On an ephemeral filesystem (e.g. a container without a persistent volume), every restart is a
cold start. Mount `data/` (or the path in `CURSOR_FILE`) on a persistent volume to preserve
the resume position across restarts.

### Deployment impact of this change

- **New env var `INTER_SEND_DELAY_MS`** — optional, default `1500`. Existing deployments are
  unaffected; the default matches the previous hardcoded constant.
- **No change to the cursor file format** — existing `data/cursor.json` files with
  `"version": 1` load without modification.
- **CI now runs the test suite** — `npm test` replaces the previous typecheck-only CI job.
  The build output is still produced as part of `npm test`.
