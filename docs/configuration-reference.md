# Configuration and Operational Reference

This document outlines the expected behavior of the Mimir Telegram bot under long-running failure scenarios, operational safeguards, and how configuration drives these behaviors.

## Guiding Principles
- **Read-Only**: The bot strictly reads from the chain and writes to Telegram. It holds no signing keys and never signs or submits transactions. The blockchain is the sole source of truth.
- **Fail Fast on Boot**: Configuration is validated synchronously on startup. If environment variables are missing, malformed, or internally inconsistent, the bot crashes immediately with a detailed error listing all problems, preventing silent failures.
- **Resilience During Operation**: Once running, the bot gracefully handles transient errors from the Stellar RPC and Telegram APIs. It will retry without crashing the process.

## Environment Variables (`.env`)

The `.env.example` file contains the base configuration. The bot uses strict environment variable loading.

### Telegram Settings
- `BOT_TOKEN`: The API token for the Telegram bot. Required.
- `TELEGRAM_CHAT_ID`: The numeric ID or `@channelusername` where notifications are posted. Required.

### Mimir Contract Settings
- `MARKET_CONTRACT_ID`: The Mimir market Soroban contract address. Required. Must be a valid `C...` strkey.
- `SQUAD_CONTRACT_ID`: The Mimir squad Soroban contract address. Required. Must be a valid `C...` strkey.

### Network Settings
- `STELLAR_RPC_URL`: The Soroban RPC endpoint used to poll for events. (e.g., `https://soroban-testnet.stellar.org`).
- `STELLAR_HORIZON_URL`: Used for generating transaction links.
- `STELLAR_NETWORK_PASSPHRASE`: Must match the RPC network's passphrase.

### Poller Tuning & Safeguards
- `POLL_INTERVAL_MS`: How often to query the RPC for new events. Minimum is 5000ms. Testnet ledgers close roughly every 5 seconds.
- `START_LOOKBACK_LEDGERS`: On a cold start (no cursor file), the number of recent ledgers to check for events. Defaults to 60. Limits unbounded backfilling.
- `CURSOR_FILE`: Path to a persistent JSON file where the bot stores its last-seen ledger cursor. 
- `MAX_NOTIFICATIONS_PER_CYCLE`: Operational safeguard. The maximum number of notifications to dispatch in a single poll cycle. Defaults to 20. Prevents Telegram rate limiting if a massive burst of events occurs on-chain. Additional events are skipped (logged), but the cursor advances.

### Health Reporting
- `HEALTH_HOST` & `HEALTH_PORT`: Binds a local HTTP endpoint for health probes (e.g., Kubernetes liveness probes). Set port to 0 to disable.
- `HEALTH_STALE_MS`: Marks the health endpoint as degraded if no successful poll completes within this window (e.g., 90000ms).

## Operational Behavior

### RPC Failures and Rate Limits
- **Behavior**: If the Stellar RPC is unreachable, returns HTTP 5xx, or rate-limits the bot (HTTP 429), the polling cycle catches the error, logs a warning, and skips the cycle.
- **Safeguard**: The bot does not crash. The next cycle attempts the poll again from the same cursor. The health endpoint will start reporting degraded if the failure duration exceeds `HEALTH_STALE_MS`.

### Telegram Failures and Rate Limits
- **Behavior**: If Telegram's API is unreachable or rate-limits the bot (HTTP 429), the `grammy` framework handles standard retry-after backoffs. If the dispatch completely fails, the bot logs the failure.
- **Safeguard**: `MAX_NOTIFICATIONS_PER_CYCLE` prevents internal bursts from hitting Telegram's strict anti-spam rate limits.

### Cursor Management and Restarts
- **Behavior**: The cursor (the last ingested event's ledger sequence and ID) is persisted to `CURSOR_FILE` after events are dispatched.
- **Cold Start (No Cursor)**: The bot calculates a start ledger using the current network ledger minus `START_LOOKBACK_LEDGERS`. This prevents it from attempting to fetch all historical events.
- **Warm Start (Existing Cursor)**: The bot reads `CURSOR_FILE`. It validates the format.
- **Corrupt Cursor**: If the cursor file is missing, empty, or structurally invalid, it's treated as a Cold Start. If it contains data but is stale (far behind the network tip), the RPC's retention window might clip the query. The poller automatically resets to the lookback window if the cursor is too old.

### Malformed On-Chain Events
- **Behavior**: If a parsed event matches the watched topics but has a payload that doesn't match expected XDR/contract semantics, the decoding step will safely catch the discrepancy.
- **Safeguard**: The event is skipped (with a debug log) and the cursor continues to advance. The bot does not crash and does not log raw, unbounded payloads to prevent log stuffing.

### Logs
- Operational outputs are structured and actionable.
- **Redaction**: Bot tokens and private payloads are never logged.

## Deployment & Rollback

### Assumptions
- Node.js version 20+.
- `CURSOR_FILE` exists on a persistent volume. If the deployment is ephemeral and restarts frequently, mounting a volume for `data/cursor.json` ensures the bot doesn't spam recent events on every restart.

### Rollback
- Since the bot is read-only, rolling back to an older version requires no on-chain coordination or state migrations.
- **Cursor Compatibility**: If a rollback happens, ensure the older version is compatible with the format in `CURSOR_FILE` (a JSON object with `ledger` and `id`). If incompatible, clear the cursor file for a cold start lookback.
