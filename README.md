# Mimir Telegram bot

A Telegram notifier for [Mimir](https://github.com/mimir-stellar), the AI-settled
prediction market on Stellar. It polls Mimir's two Soroban contracts for new
on-chain events and posts them, human-readable, into a chat or channel:

```
🆕 New claim #7
Category: crypto
Creator: GBMGZ…IR2Y
ledger 4226691 · tx

⚔️ Claim #7 challenged
Stake: 2.0000000 USDC
Challenger: GDZCB…X4UH
ledger 4226692 · tx

⚖️ Claim #7 resolved — winner: challengers
Confidence: 100%
Onchain smoke — challengers awarded so the payout pull can be exercised
ledger 4226728 · tx
```

Built with [grammy](https://grammy.dev) and
[`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk). Reads only —
it holds no keys and signs nothing.

## What it watches

| Contract | Events it notifies on |
|---|---|
| `mimir-market` | `claim_created`, `claim_challenged`, `claim_resolved`, `claim_cancelled`, `market_settled`, `challenger_paid`, `fee_claimed`, `withdrawal`, `withdrawal_pending` |
| `mimir-squad` | `market_created`, `deposited`, `withdrawn`, `resolved`, `claimed`, `fees_claimed` |

Admin events (`oracle_changed`, `ownership_transferred`, `fee_policy_*`,
`fee_accrued`, `agent_attributed`) are decoded far enough to be recognised and
then skipped — they are logged, not posted.

## Setup

### 1. Get a bot token

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow
the prompts, and copy the token it gives you (`123456789:AA…`).

### 2. Get the chat id

- **Private chat:** message [@userinfobot](https://t.me/userinfobot); it replies
  with your numeric id.
- **Group:** add your bot to the group, send any message, then open
  `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and read
  `result[].message.chat.id`. Group and supergroup ids are negative
  (`-1001234567890`).
- **Channel:** add the bot as an administrator with "Post messages" permission.
  Either use the numeric id from `getUpdates` or, for a public channel, the
  `@channelusername`.

If your group has [privacy mode](https://core.telegram.org/bots/features#privacy-mode)
on (the default), the bot only sees messages that are commands or replies to it —
which is all `/status` needs.

### 3. Configure and run

```bash
cp .env.example .env     # then fill in BOT_TOKEN and TELEGRAM_CHAT_ID
npm install
npm run dev              # tsx, restarts on change
```

For production:

```bash
npm run build
npm start
```

`.env.example` ships with the live Stellar Testnet contract ids, so the only two
values you must supply are `BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Every other
variable is documented inline there. A missing or malformed value aborts startup
with all the problems listed at once — the bot never boots into a state where it
looks healthy but notifies nobody.

## Commands

| Command | What it does |
|---|---|
| `/start` | What the bot is |
| `/help` | Same, plus the command list |
| `/status` | Chain tip, the RPC's retained-history floor, both watched contract ids, the last ledger an event was seen in per contract, the persisted cursor, any restart gap (ledgers lost + when the cursor was reset), poll/send counters and the last error |
| `/contracts` | The two contract ids this bot watches (`mimir-market`, `mimir-squad`) and a [stellar.expert](https://stellar.expert) link for each. Reads only from config, so it answers the same during a cold start, a run of RPC failures, or between restarts — unlike `/status`, there is nothing here that can be "unhealthy" |

## Reading events without a bot token

The chain reader runs standalone. Testnet's Soroban RPC is public and
unauthenticated, so this needs nothing but the contract ids:

```bash
npm run scan                     # both contracts, from the RPC's retained floor
npm run scan -- --pages 40       # walk further
npm run scan -- --show 20        # print 20 decoded events per contract
npm run scan -- --from 4226500   # explicit start ledger
```

It prints the ledger window, an event-name histogram, and the decoded payloads.
This is how the decoder was verified against the live deployment.

## How the polling works

Soroban's `getEvents` is **not** `eth_getLogs`, and the difference is the whole
design of `src/stellar/events.ts`:

- Paging is by **opaque cursor**, not block range, so the walk is inherently
  sequential — there is no chunk fan-out to parallelise.
- `startLedger`/`endLedger` and `cursor` are **mutually exclusive** in one
  request.
- The RPC keeps only a **rolling window** of events (~120,960 ledgers, roughly a
  week, on Testnet). A `startLedger` below the retained floor is an *error*, not
  an empty result, so the floor is clamped from `getHealth()` first.
- **An empty page does not mean the scan is finished.** One request covers a
  bounded slice of ledgers and returns whatever was in it — frequently nothing —
  plus a cursor to continue from. Terminating on a short page (the correct
  instinct for `eth_getLogs`) silently yields zero events. Verified against the
  live deployment: reading the market contract from the retained floor takes 13
  pages, 12 of which are empty, to reach the page holding all 11 of its events.

So the walk terminates on the cursor, never on the payload.

Events are also not a source of truth for current state — a claim's stakes and
status come from the contract's own getters. This bot is a timeline, not an
index.

## Cursor persistence

The poller writes its resume position to `data/cursor.json` (write-then-rename,
so a crash mid-write cannot truncate it):

```json
{
  "version": 1,
  "updatedAt": "2026-08-21T10:00:00.000Z",
  "targets": {
    "market": { "cursor": "0018276211125911551-4294967295", "lastEventLedger": 4226729 },
    "squad":  { "cursor": "0018276211125911551-4294967295", "lastEventLedger": 4226733 }
  }
}
```

On a cold start (no file) it begins `START_LOOKBACK_LEDGERS` behind the chain tip
rather than replaying the whole retained window into your chat.

### Restart gaps

The RPC keeps a **rolling window** of events and drops everything older, so a
long enough downtime leaves the persisted cursor *behind the retained floor*.
The events between the cursor and the floor can never be read again — there is
nothing to recover them from — so the poller:

1. compares each resumed cursor with the retained floor reported by
   `getHealth()` (at boot, and again whenever a scan fails and the window may
   have moved);
2. logs one warning naming the target, the cursor's ledger, the floor, and how
   many ledgers were skipped;
3. **resets that target to a cold start**, because retrying a cursor below the
   floor fails the same way every cycle and would wedge the target until someone
   edited the file by hand. Resetting to the configured lookback — not to the
   floor — avoids replaying up to a week of events into the chat.

The gap is visible afterwards in `/status` (per target) and in `/health`
(`restartGaps`, `lastRestartGap`, and per-target `gapLedgers`). A cursor is never
reset while it is inside the window: an RPC failure alone leaves it exactly
where it was. A cursor whose ledger cannot be parsed is reported as
`cursorUnreadable` and left untouched, because the RPC cursor is opaque by
design — parse failure here is not evidence that the RPC will reject it.

**Deployment note:** a flat file is fine for v0 but it must survive restarts. On
an always-on host, put `data/` on a persistent volume (or point `CURSOR_FILE`
at one). On an ephemeral filesystem every restart is a cold start, and events
that happened while the bot was down are never posted. Swapping this for a real
KV store is a deliberate future step, not something this repo does today.

## Failure behaviour

This process is meant to stay up for weeks, so a single failure never ends it:

- **A failed RPC call** fails one contract's scan for one cycle. Its cursor is
  left untouched, so the next cycle resumes exactly where it stopped.
- **A failed Telegram send** drops one message; the cursor still advances. That
  is deliberate: holding the cursor back would turn a revoked token or a chat
  the bot was removed from into an infinite replay, and recovery would flood the
  channel. Notifications are lossy on purpose — the chain is the record.
- **A corrupt cursor file** is treated as a cold start rather than a crash.
- **A cursor that has fallen below the RPC's retained window** (a restart longer
  than the window) is detected against the floor, reported once, and reset to a
  cold start — see [Restart gaps](#restart-gaps). The events in that gap are
  already unrecoverable, so the one thing the poller must not do is retry that
  cursor forever.
- **A burst** is capped at `MAX_NOTIFICATIONS_PER_CYCLE` messages per cycle,
  spaced out, so Telegram's rate limiter is never the thing that takes the bot
  down.

## Health endpoint

The process exposes a **loopback HTTP** probe for supervisors and deploy
checks (default `http://127.0.0.1:8787`):

| Path | Meaning |
| --- | --- |
| `GET /health` (alias `/healthz`) | Readiness-style status. `200` when the poller is running and healthy; `503` when stopped or degraded (repeated RPC failures or a stale success window). |
| `GET /health/live` (alias `/livez`) | Liveness only — the process and HTTP server are up. Always `200` while listening. |

The JSON body is operational status only: poller counters, ledgers, truncated
cursors, restart-gap ledger counts, and whether a target has an error. It never
includes `BOT_TOKEN`, chat ids, private keys, or unbounded remote payloads.

Configuration (see `.env.example`):

- `HEALTH_HOST` — bind address (default `127.0.0.1`)
- `HEALTH_PORT` — TCP port (default `8787`; `0` disables)
- `HEALTH_STALE_MS` — degraded if no successful poll within this window after the first success (default `90000`; `0` disables)

**Rollback:** set `HEALTH_PORT=0` (or omit the new env keys to keep defaults) and
redeploy the previous image — the health module is additive and does not change
cursor format or Telegram behaviour.

**Failure modes:** binding fails only if the port is already taken (process
exits via the listen error path after logging). Client disconnects and probe
errors are logged and ignored so they cannot stop the notifier.

## Layout

```
src/
  index.ts                 entry point: config -> RPC -> bot -> poller -> health HTTP
  health.ts                local loopback GET /health for supervisors
  config.ts                env loading and validation, fails fast
  bot.ts                   grammy setup: /start, /help, /status, /contracts
  poller.ts                the loop: scan, notify, persist the cursor
  stellar/
    client.ts              Soroban RPC client + explorer links (tx + contract)
    events.ts              cursor-paginated getEvents (+ the standalone CLI)
    decode.ts              typed decoding of both contracts' events
  notifications/
    format.ts              decoded event -> MarkdownV2 message
```

## Development checks

Run `npm run typecheck` for a no-emit TypeScript check, `npm test` for the build plus the deterministic format, fixture, and poller restart-gap suites, or `npm run build` to produce the production output.

Contributor workflow for credential-free fixtures (event catalogs, cursor samples, failure-mode expectations) lives in [docs/contributor-fixtures.md](docs/contributor-fixtures.md). Automated tests never require live Testnet RPC access, Telegram credentials, or signing keys.

## License

[AGPL-3.0-or-later](./LICENSE), matching the rest of Mimir.
