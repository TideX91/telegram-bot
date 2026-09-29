/**
 * Localization strings for the Mimir Telegram notifier.
 *
 * All user-facing text lives here. Callers interpolate dynamic values (ledger
 * numbers, addresses, amounts) at the call site — the localization layer
 * provides the template; the caller provides the variables.
 *
 * ── MarkdownV2 notes ────────────────────────────────────────────────────────
 * Static strings that will be sent to Telegram via MarkdownV2 are stored
 * pre-escaped where they contain reserved characters. Dynamic interpolations
 * are the caller's responsibility and must pass through `escapeMd` before
 * being spliced in. Plain-text strings (used without a parse_mode) are stored
 * as-is; they never contain Markdown syntax.
 *
 * ── Adding a string ─────────────────────────────────────────────────────────
 * 1. Add the constant to the appropriate namespace below.
 * 2. Replace the inline literal in the source file with a reference.
 * 3. Add a test in tests/i18n.test.mjs that imports the key and asserts both
 *    the value and that the caller substitutes dynamic parts correctly.
 */

// ── Bot: help and lifecycle ──────────────────────────────────────────────────

/** Help title (MarkdownV2). */
export const HELP_TITLE = "*Mimir notifier*";

/**
 * Help intro (plain text). The caller escapes it with `escapeMd`; the command
 * lines are generated from the command registry and COMMAND_DESCRIPTIONS.
 */
export const HELP_INTRO =
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts.";

// ── Bot: operator controls (MarkdownV2) ─────────────────────────────────────

export const PAUSE_MESSAGES = {
  paused:
    "*Polling paused*\nThe current scan may finish, but no new cycle will start\\. Cursors were not changed\\.",
  alreadyPaused: "*Polling is already paused*",
  stopped: "*Polling cannot pause* — the process is stopping\\.",
} as const;

export const RESUME_MESSAGES = {
  resumed: "*Polling resumed*\nThe next scan starts now\\. Cursors were not changed\\.",
  alreadyRunning: "*Polling is already running*",
  stopped: "*Polling cannot resume* — the process is stopping\\.",
} as const;

// ── Bot: audit command ───────────────────────────────────────────────────────

/**
 * Hint displayed after the audit report, pointing operators to the standalone
 * CLI. Plain text (the audit reply has no parse_mode).
 */
export const AUDIT_CLI_HINT =
  "See `npm run audit -- --help` for the standalone report tool.";

// ── Telegram command descriptions (shown in the UI autocomplete) ─────────────

/** Descriptions registered with `setMyCommands`. */
export const COMMAND_DESCRIPTIONS = {
  start: "What this bot does",
  help: "Show help",
  status: "Last-seen ledger and watched contracts",
  audit: "Operator only: audit report (redacted, bounded)",
  contracts: "Contract ids and explorer links",
  health: "Health assessment and operational readiness",
  preview: "Preview channel notification formatting",
  pause: "Operator only: pause new scans",
  resume: "Operator only: resume polling now",
} as const;

// ── Notifications: event headlines (MarkdownV2) ──────────────────────────────
// Template functions. Every dynamic value is supplied by the caller and must
// already be escapeMd-escaped before being passed in. Static reserved chars
// inside the template strings are pre-escaped here.

export const NOTIFICATION_MD = {
  // ── mimir-market ────────────────────────────────────────────────────────
  /** @param claimId already-escaped string, e.g. "7" */
  claimCreated: (claimId: string, category: string, creator: string): string =>
    `🆕 *New claim* \\#${claimId}\nCategory: ${category}\nCreator: ${creator}`,

  claimChallenged: (claimId: string, stake: string, challenger: string): string =>
    `⚔️ *Claim \\#${claimId} challenged*\nStake: *${stake}*\nChallenger: ${challenger}`,

  claimResolved: (
    claimId: string,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string =>
    (
      `⚖️ *Claim \\#${claimId} resolved* — winner: *${winnerSide}*\n` +
      `Confidence: ${confidence}%\n` +
      (summary ? `_${summary}_` : "")
    ).trimEnd(),

  claimCancelled: (claimId: string): string =>
    `🚫 *Claim \\#${claimId} cancelled* — stakes returned`,

  marketSettled: (
    claimId: string,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
  ): string =>
    `💰 *Claim \\#${claimId} settled*\nPaid out: *${totalPaid}* · fees ${totalFees}\nOwed to challengers: ${owedToChallengers}`,

  challengerPaid: (
    claimId: string,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `🏆 *Challenger paid* on claim \\#${claimId}\n${challenger} staked ${stake} → net *${net}*\nGross ${gross} · fee ${fee}`,

  feeClaimed: (amount: string, recipient: string): string =>
    `🧾 *Fees claimed* — ${amount} to ${recipient}`,

  withdrawal: (amount: string, to: string): string =>
    `📤 *Withdrawal* — ${amount} to ${to}`,

  withdrawalPending: (amount: string, to: string): string =>
    `⏳ *Withdrawal parked* — ${amount} claimable by ${to}`,

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated: (
    marketId: string,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
  ): string =>
    `🆕 *New squad market* \\#${marketId}\n${question}\nCaptain: ${captain} · fee ${feeBps} bps · deadline ${deadline}`,

  deposited: (marketId: string, amount: string, side: string, participant: string): string =>
    `➕ *Squad \\#${marketId}* — ${amount} on *${side}*\nParticipant: ${participant}`,

  withdrawn: (marketId: string, participant: string, amount: string, side: string): string =>
    `➖ *Squad \\#${marketId}* — ${participant} pulled ${amount} from ${side}`,

  resolved: (marketId: string, result: string, poolA: string, poolB: string): string =>
    `🏁 *Squad \\#${marketId} resolved* — *${result}*\nPools: A ${poolA} · B ${poolB}`,

  claimed: (
    marketId: string,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `💸 *Squad payout* on \\#${marketId}\n${participant} → net *${net}* \\(gross ${gross}, fee ${fee}\\)`,

  feesClaimedSquad: (amount: string, recipient: string): string =>
    `🧾 *Squad fees claimed* — ${amount} to ${recipient}`,

  // ── Fallback ─────────────────────────────────────────────────────────────
  /**
   * Sent when an event payload is malformed or the formatter throws.
   * All parameters must already be escapeMd-escaped.
   */
  fallbackEvent: (
    source: string,
    contract: string,
    ledger: string,
    reason: string,
    txPart: string,
  ): string =>
    `⚠️ *Event Notification Fallback* \\(${source}\\)\nContract: \`${contract}\` · Ledger: ${ledger}${txPart}\nReason: _${reason}_`,

  // ── Preview mode prefix ──────────────────────────────────────────────────
  previewModePrefix: "🧪 *[PREVIEW MODE]*",

  // ── Channel preview headers ──────────────────────────────────────────────
  channelPreviewMarket: "🧪 *Channel Preview — mimir\\-market*",
  channelPreviewSquad: "🧪 *Channel Preview — mimir\\-squad*",
} as const;

// ── Notifications: event headlines (plain text) ──────────────────────────────
// Mirror of NOTIFICATION_MD for use without a parse_mode. No Markdown at all.

export const NOTIFICATION_PLAIN = {
  // ── mimir-market ────────────────────────────────────────────────────────
  claimCreated: (claimId: string | number, category: string, creator: string): string =>
    `New claim #${claimId}\nCategory: ${category}\nCreator: ${creator}`,

  claimChallenged: (
    claimId: string | number,
    stake: string,
    challenger: string,
  ): string =>
    `Claim #${claimId} challenged\nStake: ${stake}\nChallenger: ${challenger}`,

  claimResolved: (
    claimId: string | number,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string =>
    `Claim #${claimId} resolved — winner: ${winnerSide}\nConfidence: ${confidence}%` +
    (summary ? `\n${summary}` : ""),

  claimCancelled: (claimId: string | number): string =>
    `Claim #${claimId} cancelled — stakes returned`,

  marketSettled: (
    claimId: string | number,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
  ): string =>
    `Claim #${claimId} settled\nPaid out: ${totalPaid} · fees ${totalFees}\nOwed to challengers: ${owedToChallengers}`,

  challengerPaid: (
    claimId: string | number,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `Challenger paid on claim #${claimId}\n${challenger} staked ${stake} → net ${net}\nGross ${gross} · fee ${fee}`,

  feeClaimed: (amount: string, recipient: string): string =>
    `Fees claimed — ${amount} to ${recipient}`,

  withdrawal: (amount: string, to: string): string =>
    `Withdrawal — ${amount} to ${to}`,

  withdrawalPending: (amount: string, to: string): string =>
    `Withdrawal parked — ${amount} claimable by ${to}`,

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated: (
    marketId: string | number,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
  ): string =>
    `New squad market #${marketId}\n${question}\nCaptain: ${captain} · fee ${feeBps} bps · deadline ${deadline}`,

  deposited: (
    marketId: string | number,
    amount: string,
    side: string,
    participant: string,
  ): string =>
    `Squad #${marketId} — ${amount} on ${side}\nParticipant: ${participant}`,

  withdrawn: (
    marketId: string | number,
    participant: string,
    amount: string,
    side: string,
  ): string =>
    `Squad #${marketId} — ${participant} pulled ${amount} from ${side}`,

  resolved: (
    marketId: string | number,
    result: string,
    poolA: string,
    poolB: string,
  ): string =>
    `Squad #${marketId} resolved — ${result}\nPools: A ${poolA} · B ${poolB}`,

  claimed: (
    marketId: string | number,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `Squad payout on #${marketId}\n${participant} → net ${net} (gross ${gross}, fee ${fee})`,

  feesClaimedSquad: (amount: string, recipient: string): string =>
    `Squad fees claimed — ${amount} to ${recipient}`,

  /**
   * Last-resort one-liner when even the plain-text formatter cannot render.
   * Never returns an empty string.
   */
  minimal: (source: string, ledger: string, eventId: string): string => {
    const idPart = eventId ? ` (${eventId})` : "";
    return `Mimir event (${source}) — ${ledger}${idPart}`;
  },
} as const;

// ── Explorer button ──────────────────────────────────────────────────────────

/** Text shown on the Telegram inline keyboard button for explorer links. */
export const EXPLORER_BUTTON_TEXT = "View on Explorer";
