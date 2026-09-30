<!--
  Template for the Mimir Telegram notifier.
  Delete or fill every section; remove the <!-- … --> comments but keep the headings.
  The chain is the source of truth, and this bot is read-only: it never holds signing
  keys and never submits transactions.
-->

## Summary

<!-- What does this change do, and why? One short paragraph is fine. -->

## Linked issue

<!--
  Required by the project workflow. Reference the issue this PR closes/relates to, e.g.
  "Closes #123" or "Fixes #456". If there is no issue yet, file one first.
-->

## Failure modes

<!--
  The bot must survive long-running Stellar and Telegram failures with bounded behavior.
  For each phase this PR touches, state what stays true — especially for the cursor and
  for what ends up in the channel. Delete rows that are unchanged.

  Reference: docs/component-architecture.md#failure-handling and docs/incident-runbook.md.
-->

| Failure mode | Behavior before | Behavior after |
| --- | --- | --- |
| Malformed / unknown events | | |
| Stale cursor (below retained floor) | | |
| RPC failure (getEvents / getHealth) | | |
| Telegram failure / rate limit | | |
| Restart / resume / shutdown | | |
| Per-cycle notification cap | | |

## Cursor safety

<!--
  What does the cursor file do here? Unchanged on RPC failure, committed after partial
  delivery, quarantined on corrupt JSON, rewound to the retained floor with the budget and
  `rewindFromLedger` semantics. If the version-1 schema shape, the `recentEventIds` dedup
  window, or the `chainClockAt` field changes, older cursor files must still load — state
  the migration.
-->

## Logs and security

<!--
  Confirm logs and status output never include bot tokens, private keys, payment proofs,
  or unbounded remote payloads (scrubbing is centralized in src/redact.ts). Quote any new
  or changed log lines and the config-provenance summary if a variable was added.
-->

## Configuration and deployment impact

<!--
  Any new/modified environment variables, profile defaults, or documented operational
  behavior. Deployment impact (Dockerfile, railway.json, health probes, status.json) and
  whether data/ layout changed. If nothing changes, say so explicitly.
-->

## Test coverage

<!--
  Focused positive, negative, boundary, restart, and regression coverage under tests/.
  Confirm the suite runs without live Testnet or Telegram credentials. Add fixtures under
  tests/fixtures/ and update the fixture guide if ops-visible behavior changed.
-->

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm test` passes (no live Testnet, no Telegram credentials required)
- [ ] Fixture guide / README updated where behavior affecting ops changed
- [ ] No real bot tokens, chat ids, or signing keys added to the repo