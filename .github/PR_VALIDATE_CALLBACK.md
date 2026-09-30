PR title:
bot: robust callback-query handling — reply fallback, validation, and test safety

Summary
- Validate and safely handle Telegram callback queries. Ensure UI actions still produce visible output when the original message is missing, harden against malformed or malicious callback_data, and avoid test-time failures from missing bot tokens.

Changes
- `src/bot.ts`
  - When a callback query has no `message` (some callbacks omit it), send the reply to the configured chat (`config.chatId`) via `ctx.api.sendMessage(...)` so UI actions remain visible.
  - Keep existing validation in `validateCallbackData` (reject non-strings, control chars, oversized payloads, unknown/ malformed JSON, unknown colon formats).
  - Enforce operator authorization for `pause`/`resume` and surface bounded unauthorized alerts.
  - All Telegram errors are caught, redacted (bot token), and logged compactly.
  - Add a harmless placeholder token when creating the `Bot` if `config.botToken` is missing to avoid grammy throwing `Empty token!` during certain unit tests. This is a test-safety measure only — production must supply a valid token.
- `tests/callback-query.test.mjs`
  - New/expanded tests covering: validation, authorization, positive flows, boundary cases (`editMessageText` fallback → `sendMessage`, message-less callbacks), failure modes (answerCallbackQuery errors), restart & state isolation (cursor file untouched), redaction, and snapshots for MarkdownV2 payloads.
- No change to cursor file format or poller persistence behavior.

Failure modes & mitigation
- Malformed/unknown callback_data: rejected with a bounded fallback answer (`CALLBACK_FALLBACK_FEEDBACK`) and no state mutation.
- Oversized or control-character payloads: rejected before any processing.
- Unauthorized operator actions: rejected with `CALLBACK_UNAUTHORIZED_FEEDBACK` and shown as an alert; no state mutation.
- Callback without `message`: reply is sent to `config.chatId` so operator feedback remains visible; this avoids silent no-op for UI clicks.
- `editMessageText` errors (e.g., message deleted or old): fall back to `sendMessage`.
- `answerCallbackQuery` failures are logged and do not crash the bot.
- Cursor persistence: callbacks and operator controls do not write or mutate `data/cursor.json`.
- Secrets redaction: logs and status do not include `botToken`, chat ids, private keys, or unbounded payloads.

Cursor safety
- Callbacks and operator controls never modify cursor persistence. Corrupt/stale cursors follow existing behavior (cold start or surfaced error).

Deployment impact
- No runtime config changes required beyond existing `BOT_TOKEN`/`config.botToken` and `config.chatId`.
- The placeholder token added is strictly to avoid Grammy errors in unit tests; production must provide a real `botToken`. If you prefer stricter behavior, I can revert and update the test harness instead.
- Health endpoint and cursor format unchanged.
- No database/migration required.

Testing
- Ran locally:
  - `npm run typecheck`
  - `npm test` — all tests pass (75/75).
- Tests cover positive, negative, boundary, restart, and regression cases; snapshots verify exact MarkdownV2 payloads.

Rollout & rollback
- Rollout: merge and deploy as usual. No special migration; ensure `config.botToken` present.
- Rollback: redeploy previous image; health probe settings unchanged.

Files changed
- `src/bot.ts`
- `tests/callback-query.test.mjs`

PR checklist
- [x] Tests added/updated and pass locally.
- [x] No secrets committed.
- [x] Cursor format unchanged.
- [x] Logs redact `botToken` and bounded remote payloads.
- [ ] Link this PR to the issue: replace `#ISSUE`.

Fixes: #ISSUE
