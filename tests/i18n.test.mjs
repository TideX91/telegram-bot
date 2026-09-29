/**
 * Localization coverage tests for src/i18n.ts.
 *
 * Strategy:
 *  - Positive: every key/template exists and produces the expected string.
 *  - Negative: null/undefined/empty dynamic parts are handled gracefully.
 *  - Boundary: long dynamic values don't break the format.
 *  - Snapshot: the exact MarkdownV2 and plain-text payloads sent to Telegram
 *    for each event type, derived from i18n keys.
 *  - Regression: the i18n strings match what callers expect (format.ts
 *    integration smoke tests so that a text change is always visible).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_CLI_HINT,
  COMMAND_DESCRIPTIONS,
  EXPLORER_BUTTON_TEXT,
  HELP_INTRO,
  HELP_TITLE,
  NOTIFICATION_MD,
  NOTIFICATION_PLAIN,
  PAUSE_MESSAGES,
  RESUME_MESSAGES,
} from "../dist/i18n.js";

import {
  escapeMd,
  explorerKeyboard,
  formatEvent,
  formatFallbackEvent,
  formatPlainTextEvent,
} from "../dist/notifications/format.js";

import {
  pauseMessage,
  resumeMessage,
  registerCommandHandlers,
} from "../dist/bot.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function testnetConfig(overrides = {}) {
  return {
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    chatId: "-1001234567890",
    ...overrides,
  };
}

function marketEvent(payloadOverrides = {}, eventOverrides = {}) {
  return {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 7,
      category: "crypto",
      creator: "GABCD",
      ...payloadOverrides,
    },
    ...eventOverrides,
  };
}

function squadEvent(payloadOverrides = {}, eventOverrides = {}) {
  return {
    source: "squad",
    contractId: "squad",
    ledger: 99,
    txHash: "",
    at: 0,
    eventId: "99-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "market_created",
      marketId: 3,
      question: "Will it rain?",
      captain: "GABCD",
      feeBps: 50,
      deadline: 1800000000,
      ...payloadOverrides,
    },
    ...eventOverrides,
  };
}

function mockedBot(deps) {
  const handlers = new Map();
  const bot = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerCommandHandlers(bot, deps);
  return { handlers };
}

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

// ── HELP_TITLE / HELP_INTRO ──────────────────────────────────────────────────

test("HELP_TITLE and HELP_INTRO are non-empty strings", () => {
  assert.equal(HELP_TITLE, "*Mimir notifier*");
  assert.equal(typeof HELP_INTRO, "string");
  assert.ok(HELP_INTRO.length > 0);
});

test("/help renders the title, escaped intro and registry descriptions", async () => {
  const { handlers } = mockedBot({ config: baseConfig(), status: () => baseStatus() });
  const replies = [];
  await handlers.get("help")({ reply: async (text) => replies.push(text) });
  const text = replies[0];
  assert.ok(text.startsWith(HELP_TITLE));
  assert.ok(text.includes("on\\-chain event"));
  assert.ok(text.includes(COMMAND_DESCRIPTIONS.pause));
  assert.ok(text.includes(COMMAND_DESCRIPTIONS.resume));
});

// ── PAUSE_MESSAGES / RESUME_MESSAGES ─────────────────────────────────────────

test("PAUSE_MESSAGES keys produce exact MarkdownV2 strings", () => {
  assert.match(PAUSE_MESSAGES.paused, /\*Polling paused\*/);
  assert.match(PAUSE_MESSAGES.paused, /Cursors were not changed\\\./);
  assert.equal(typeof PAUSE_MESSAGES.alreadyPaused, "string");
  assert.match(PAUSE_MESSAGES.alreadyPaused, /already paused/i);
  assert.match(PAUSE_MESSAGES.stopped, /process is stopping/i);
});

test("RESUME_MESSAGES keys produce exact MarkdownV2 strings", () => {
  assert.match(RESUME_MESSAGES.resumed, /\*Polling resumed\*/);
  assert.match(RESUME_MESSAGES.resumed, /Cursors were not changed\\\./);
  assert.equal(typeof RESUME_MESSAGES.alreadyRunning, "string");
  assert.match(RESUME_MESSAGES.alreadyRunning, /already running/i);
  assert.match(RESUME_MESSAGES.stopped, /process is stopping/i);
});

test("pauseMessage delegates to PAUSE_MESSAGES and returns exact strings", () => {
  assert.equal(pauseMessage("paused"), PAUSE_MESSAGES.paused);
  assert.equal(pauseMessage("already-paused"), PAUSE_MESSAGES.alreadyPaused);
  assert.equal(pauseMessage("stopped"), PAUSE_MESSAGES.stopped);
});

test("resumeMessage delegates to RESUME_MESSAGES and returns exact strings", () => {
  assert.equal(resumeMessage("resumed"), RESUME_MESSAGES.resumed);
  assert.equal(resumeMessage("already-running"), RESUME_MESSAGES.alreadyRunning);
  assert.equal(resumeMessage("stopped"), RESUME_MESSAGES.stopped);
});

// ── AUDIT_CLI_HINT ────────────────────────────────────────────────────────────

test("AUDIT_CLI_HINT is a non-empty string mentioning npm run audit", () => {
  assert.equal(typeof AUDIT_CLI_HINT, "string");
  assert.ok(AUDIT_CLI_HINT.length > 0);
  assert.ok(AUDIT_CLI_HINT.includes("npm run audit"));
});

// ── COMMAND_DESCRIPTIONS ─────────────────────────────────────────────────────

test("COMMAND_DESCRIPTIONS has all nine commands with non-empty descriptions", () => {
  const required = ["start", "help", "status", "audit", "contracts", "health", "preview", "pause", "resume"];
  for (const cmd of required) {
    assert.ok(cmd in COMMAND_DESCRIPTIONS, `missing command: ${cmd}`);
    assert.ok(COMMAND_DESCRIPTIONS[cmd].length > 0, `empty description for: ${cmd}`);
  }
});

test("COMMAND_DESCRIPTIONS values are plain text (no MarkdownV2 formatting syntax)", () => {
  // Command descriptions are shown in Telegram's UI autocomplete and are not
  // parsed as Markdown — they are plain strings. The only restriction is they
  // should not use MarkdownV2 *formatting* chars that would appear in messages.
  // Parentheses are allowed in plain text (Telegram uses them there natively).
  const mdFormattingRe = /[*_`[\]~>#+|{}.!\\]/;
  for (const [cmd, desc] of Object.entries(COMMAND_DESCRIPTIONS)) {
    assert.equal(
      mdFormattingRe.test(desc),
      false,
      `command '${cmd}' description contains MarkdownV2 formatting char: "${desc}"`,
    );
  }
});

// ── EXPLORER_BUTTON_TEXT ──────────────────────────────────────────────────────

test("EXPLORER_BUTTON_TEXT is a non-empty string", () => {
  assert.equal(typeof EXPLORER_BUTTON_TEXT, "string");
  assert.ok(EXPLORER_BUTTON_TEXT.length > 0);
});

test("explorerKeyboard uses EXPLORER_BUTTON_TEXT for the inline button", () => {
  const config = testnetConfig();
  const event = marketEvent({}, {
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  const keyboard = explorerKeyboard(config, event);
  assert.ok(keyboard !== undefined);
  assert.equal(keyboard.inline_keyboard[0][0].text, EXPLORER_BUTTON_TEXT);
});

// ── NOTIFICATION_MD: market events ───────────────────────────────────────────

test("NOTIFICATION_MD.claimCreated produces correct MarkdownV2 headline snapshot", () => {
  const result = NOTIFICATION_MD.claimCreated("7", escapeMd("crypto"), "`GABCD`");
  assert.equal(
    result,
    "🆕 *New claim* \\#7\nCategory: crypto\nCreator: `GABCD`",
  );
});

test("NOTIFICATION_MD.claimChallenged produces correct MarkdownV2 headline snapshot", () => {
  const result = NOTIFICATION_MD.claimChallenged("7", "2\\.0000000 USDC", "`GABCD`");
  assert.equal(
    result,
    "⚔️ *Claim \\#7 challenged*\nStake: *2\\.0000000 USDC*\nChallenger: `GABCD`",
  );
});

test("NOTIFICATION_MD.claimResolved with summary produces correct snapshot", () => {
  const result = NOTIFICATION_MD.claimResolved(
    "7",
    "challengers",
    "100",
    "Onchain smoke \\— challengers awarded",
  );
  assert.match(result, /⚖️ \*Claim \\#7 resolved\* — winner: \*challengers\*/);
  assert.match(result, /Confidence: 100%/);
  assert.match(result, /_Onchain smoke/);
});

test("NOTIFICATION_MD.claimResolved without summary omits the summary line", () => {
  const result = NOTIFICATION_MD.claimResolved("7", "claimant", "85", null);
  assert.match(result, /⚖️ \*Claim \\#7 resolved\*/);
  assert.equal(result.trimEnd(), result); // no trailing whitespace/newline
  assert.equal(result.includes("_"), false); // no italic syntax
});

test("NOTIFICATION_MD.claimCancelled produces correct snapshot", () => {
  const result = NOTIFICATION_MD.claimCancelled("7");
  assert.equal(result, "🚫 *Claim \\#7 cancelled* — stakes returned");
});

test("NOTIFICATION_MD.marketSettled produces correct snapshot", () => {
  const result = NOTIFICATION_MD.marketSettled(
    "7",
    "*10\\.0000000 USDC*",
    "0\\.5000000 USDC",
    "5\\.0000000 USDC",
  );
  assert.match(result, /💰 \*Claim \\#7 settled\*/);
  assert.match(result, /Paid out/);
  assert.match(result, /Owed to challengers/);
});

test("NOTIFICATION_MD.challengerPaid produces correct snapshot", () => {
  const result = NOTIFICATION_MD.challengerPaid(
    "7", "`GABCD`", "2\\.0000000 USDC", "*1\\.5000000 USDC*",
    "2\\.0000000 USDC", "0\\.5000000 USDC",
  );
  assert.match(result, /🏆 \*Challenger paid\* on claim \\#7/);
  assert.match(result, /→ net/);
});

test("NOTIFICATION_MD.feeClaimed produces correct snapshot", () => {
  const result = NOTIFICATION_MD.feeClaimed("1\\.0000000 USDC", "`GABCD`");
  assert.equal(result, "🧾 *Fees claimed* — 1\\.0000000 USDC to `GABCD`");
});

test("NOTIFICATION_MD.withdrawal produces correct snapshot", () => {
  const result = NOTIFICATION_MD.withdrawal("5\\.0000000 USDC", "`GABCD`");
  assert.equal(result, "📤 *Withdrawal* — 5\\.0000000 USDC to `GABCD`");
});

test("NOTIFICATION_MD.withdrawalPending produces correct snapshot", () => {
  const result = NOTIFICATION_MD.withdrawalPending("5\\.0000000 USDC", "`GABCD`");
  assert.equal(result, "⏳ *Withdrawal parked* — 5\\.0000000 USDC claimable by `GABCD`");
});

// ── NOTIFICATION_MD: squad events ────────────────────────────────────────────

test("NOTIFICATION_MD.marketCreated produces correct snapshot", () => {
  const result = NOTIFICATION_MD.marketCreated(
    "3",
    "Will it rain\\?",
    "`GABCD`",
    "50",
    "2027\\-01\\-01T00:00:00\\.000Z",
  );
  assert.match(result, /🆕 \*New squad market\* \\#3/);
  assert.match(result, /Captain:/);
  assert.match(result, /deadline/);
});

test("NOTIFICATION_MD.deposited produces correct snapshot", () => {
  const result = NOTIFICATION_MD.deposited("3", "10\\.0000000 USDC", "*side A*", "`GABCD`");
  assert.match(result, /➕ \*Squad \\#3\*/);
  assert.match(result, /Participant:/);
});

test("NOTIFICATION_MD.withdrawn produces correct snapshot", () => {
  const result = NOTIFICATION_MD.withdrawn("3", "`GABCD`", "5\\.0000000 USDC", "side A");
  assert.match(result, /➖ \*Squad \\#3\*/);
  assert.match(result, /pulled/);
});

test("NOTIFICATION_MD.resolved produces correct snapshot", () => {
  const result = NOTIFICATION_MD.resolved("3", "*side A*", "10\\.0 USDC", "5\\.0 USDC");
  assert.match(result, /🏁 \*Squad \\#3 resolved\*/);
  assert.match(result, /Pools: A/);
});

test("NOTIFICATION_MD.claimed produces correct snapshot", () => {
  const result = NOTIFICATION_MD.claimed("3", "`GABCD`", "*9\\.0 USDC*", "10\\.0 USDC", "1\\.0 USDC");
  assert.match(result, /💸 \*Squad payout\* on \\#3/);
  assert.match(result, /→ net/);
  // The MarkdownV2 template uses \( for the literal parenthesis
  assert.ok(result.includes("\\(gross"), "expected escaped parenthesis in claimed");
});

test("NOTIFICATION_MD.feesClaimedSquad produces correct snapshot", () => {
  const result = NOTIFICATION_MD.feesClaimedSquad("2\\.0000000 USDC", "`GABCD`");
  assert.equal(result, "🧾 *Squad fees claimed* — 2\\.0000000 USDC to `GABCD`");
});

// ── NOTIFICATION_MD: fallback ────────────────────────────────────────────────

test("NOTIFICATION_MD.fallbackEvent produces correct snapshot", () => {
  const result = NOTIFICATION_MD.fallbackEvent(
    "market", "CDVC\\.\\.\\.", "42", "malformed payload", "",
  );
  assert.match(result, /⚠️ \*Event Notification Fallback\*/);
  // The template escapes the parentheses with MarkdownV2 backslashes
  assert.ok(result.includes("\\(market\\)"), "expected \\(market\\) in fallback");
  assert.match(result, /Contract:/);
  assert.match(result, /Reason:/);
});

test("NOTIFICATION_MD.fallbackEvent includes txPart when provided", () => {
  const result = NOTIFICATION_MD.fallbackEvent(
    "market", "CDVC\\.\\.\\.", "42", "error", " · [tx](https://example.test/tx/abc)",
  );
  assert.ok(result.includes("[tx]"));
});

test("NOTIFICATION_MD.fallbackEvent omits tx link when txPart is empty", () => {
  const result = NOTIFICATION_MD.fallbackEvent("squad", "CX\\.\\.\\.", "10", "oops", "");
  assert.equal(result.includes("[tx]"), false);
  assert.match(result, /Reason: _oops_/);
});

// ── NOTIFICATION_MD: preview headers ─────────────────────────────────────────

test("NOTIFICATION_MD.previewModePrefix is a MarkdownV2 prefix string", () => {
  assert.ok(NOTIFICATION_MD.previewModePrefix.startsWith("🧪"));
  assert.ok(NOTIFICATION_MD.previewModePrefix.includes("[PREVIEW MODE]"));
});

test("NOTIFICATION_MD.channelPreviewMarket and channelPreviewSquad are distinct MarkdownV2 headers", () => {
  assert.ok(NOTIFICATION_MD.channelPreviewMarket.includes("mimir"));
  assert.ok(NOTIFICATION_MD.channelPreviewSquad.includes("mimir"));
  assert.notEqual(NOTIFICATION_MD.channelPreviewMarket, NOTIFICATION_MD.channelPreviewSquad);
  assert.ok(NOTIFICATION_MD.channelPreviewMarket.includes("market"));
  assert.ok(NOTIFICATION_MD.channelPreviewSquad.includes("squad"));
});

// ── NOTIFICATION_PLAIN: market events ────────────────────────────────────────

test("NOTIFICATION_PLAIN.claimCreated produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.claimCreated(7, "crypto", "GABCD");
  assert.equal(result, "New claim #7\nCategory: crypto\nCreator: GABCD");
  // Must contain no Markdown syntax
  assert.equal(result.includes("*"), false);
  assert.equal(result.includes("\\"), false);
});

test("NOTIFICATION_PLAIN.claimChallenged produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.claimChallenged(7, "2.0000000 USDC", "GABCD");
  assert.equal(result, "Claim #7 challenged\nStake: 2.0000000 USDC\nChallenger: GABCD");
});

test("NOTIFICATION_PLAIN.claimResolved with summary", () => {
  const result = NOTIFICATION_PLAIN.claimResolved(7, "challengers", "100", "summary text");
  assert.match(result, /Claim #7 resolved — winner: challengers/);
  assert.match(result, /\nsummary text/);
});

test("NOTIFICATION_PLAIN.claimResolved without summary omits the line", () => {
  const result = NOTIFICATION_PLAIN.claimResolved(7, "claimant", "85", null);
  assert.match(result, /Confidence: 85%/);
  assert.equal(result.endsWith("%"), true);
});

test("NOTIFICATION_PLAIN.claimCancelled produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.claimCancelled(7);
  assert.equal(result, "Claim #7 cancelled — stakes returned");
});

test("NOTIFICATION_PLAIN.marketSettled produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.marketSettled(7, "10.0 USDC", "0.5 USDC", "5.0 USDC");
  assert.match(result, /Claim #7 settled/);
  assert.match(result, /Owed to challengers/);
});

test("NOTIFICATION_PLAIN.challengerPaid produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.challengerPaid(7, "GABCD", "2.0 USDC", "1.5 USDC", "2.0 USDC", "0.5 USDC");
  assert.match(result, /Challenger paid on claim #7/);
  assert.match(result, /→ net/);
  assert.equal(result.includes("*"), false);
});

test("NOTIFICATION_PLAIN.feeClaimed produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.feeClaimed("1.0000000 USDC", "GABCD");
  assert.equal(result, "Fees claimed — 1.0000000 USDC to GABCD");
});

test("NOTIFICATION_PLAIN.withdrawal produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.withdrawal("5.0000000 USDC", "GABCD");
  assert.equal(result, "Withdrawal — 5.0000000 USDC to GABCD");
});

test("NOTIFICATION_PLAIN.withdrawalPending produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.withdrawalPending("5.0000000 USDC", "GABCD");
  assert.equal(result, "Withdrawal parked — 5.0000000 USDC claimable by GABCD");
});

// ── NOTIFICATION_PLAIN: squad events ─────────────────────────────────────────

test("NOTIFICATION_PLAIN.marketCreated produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.marketCreated(3, "Will it rain?", "GABCD", "50", "2027-01-01T00:00:00.000Z");
  assert.match(result, /New squad market #3/);
  assert.match(result, /Captain: GABCD/);
  assert.equal(result.includes("*"), false);
});

test("NOTIFICATION_PLAIN.deposited produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.deposited(3, "10.0 USDC", "side A", "GABCD");
  assert.match(result, /Squad #3/);
  assert.match(result, /Participant:/);
});

test("NOTIFICATION_PLAIN.withdrawn produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.withdrawn(3, "GABCD", "5.0 USDC", "side A");
  assert.match(result, /Squad #3/);
  assert.match(result, /pulled/);
});

test("NOTIFICATION_PLAIN.resolved produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.resolved(3, "side A", "10.0 USDC", "5.0 USDC");
  assert.match(result, /Squad #3 resolved — side A/);
  assert.match(result, /Pools: A/);
});

test("NOTIFICATION_PLAIN.claimed produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.claimed(3, "GABCD", "9.0 USDC", "10.0 USDC", "1.0 USDC");
  assert.match(result, /Squad payout on #3/);
  assert.match(result, /→ net/);
  assert.match(result, /\(gross/);
  assert.equal(result.includes("\\"), false); // no Markdown escaping
});

test("NOTIFICATION_PLAIN.feesClaimedSquad produces plain-text snapshot", () => {
  const result = NOTIFICATION_PLAIN.feesClaimedSquad("2.0000000 USDC", "GABCD");
  assert.equal(result, "Squad fees claimed — 2.0000000 USDC to GABCD");
});

// ── NOTIFICATION_PLAIN: minimal fallback ─────────────────────────────────────

test("NOTIFICATION_PLAIN.minimal with full args produces bounded line", () => {
  const result = NOTIFICATION_PLAIN.minimal("market", "ledger 42", "42-0");
  assert.equal(result, "Mimir event (market) — ledger 42 (42-0)");
  assert.equal(result.includes("*"), false);
  assert.equal(result.includes("\\"), false);
});

test("NOTIFICATION_PLAIN.minimal with empty eventId omits parentheses", () => {
  const result = NOTIFICATION_PLAIN.minimal("squad", "ledger unknown", "");
  assert.equal(result, "Mimir event (squad) — ledger unknown");
});

test("NOTIFICATION_PLAIN.minimal never returns an empty string", () => {
  assert.ok(NOTIFICATION_PLAIN.minimal("", "", "").length > 0);
  assert.ok(NOTIFICATION_PLAIN.minimal("market", "ledger 0", "").length > 0);
});

// ── Integration: i18n keys are used by the formatters ────────────────────────

test("formatEvent uses NOTIFICATION_MD.previewModePrefix for channelPreviewMode", () => {
  const config = testnetConfig({ channelPreviewMode: true });
  const event = marketEvent();
  const result = formatEvent(config, event);
  assert.ok(result.startsWith(NOTIFICATION_MD.previewModePrefix + "\n"));
});

test("formatEvent does NOT use preview prefix when channelPreviewMode is false", () => {
  const config = testnetConfig({ channelPreviewMode: false });
  const event = marketEvent();
  const result = formatEvent(config, event);
  assert.equal(result.startsWith(NOTIFICATION_MD.previewModePrefix), false);
});

test("formatFallbackEvent uses NOTIFICATION_MD.fallbackEvent template", () => {
  const config = testnetConfig();
  const event = marketEvent({ name: "unknown" }, { source: "market", ledger: 55 });
  const result = formatFallbackEvent(config, event, "test reason");
  assert.match(result, /⚠️ \*Event Notification Fallback\*/);
  assert.match(result, /market/);
  assert.match(result, /55/);
  assert.match(result, /test reason/);
});

test("formatPlainTextEvent for claim_created uses NOTIFICATION_PLAIN.claimCreated format", () => {
  const config = testnetConfig();
  const event = marketEvent({ name: "claim_created", claimId: 99, category: "sports", creator: "GABCDEFGH" });
  const result = formatPlainTextEvent(config, event);
  assert.ok(result !== null);
  assert.match(result, /New claim #99/);
  assert.match(result, /Category: sports/);
  assert.equal(result.includes("*"), false); // no Markdown
});

test("formatPlainTextEvent for claim_challenged uses NOTIFICATION_PLAIN.claimChallenged format", () => {
  const config = testnetConfig();
  const event = marketEvent({
    name: "claim_challenged",
    claimId: 5,
    challenger: "GABCD",
    stake: 10_000_000n,
  });
  const result = formatPlainTextEvent(config, event);
  assert.ok(result !== null);
  assert.match(result, /Claim #5 challenged/);
  assert.match(result, /1\.0000000 USDC/);
  assert.equal(result.includes("*"), false);
});

test("formatPlainTextEvent for squad deposited uses NOTIFICATION_PLAIN.deposited format", () => {
  const config = testnetConfig();
  const event = squadEvent({
    name: "deposited",
    marketId: 8,
    amount: 20_000_000n,
    side: { tag: "A" },
    participant: "GABCD",
  });
  const result = formatPlainTextEvent(config, event);
  assert.ok(result !== null);
  assert.match(result, /Squad #8/);
  assert.equal(result.includes("*"), false);
});

test("formatPlainTextEvent never returns Markdown characters for any market event", () => {
  const config = testnetConfig();
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "test", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 2, challenger: "GABCD", stake: 1n }),
    marketEvent({ name: "claim_cancelled", claimId: 3 }),
    marketEvent({ name: "claim_resolved", claimId: 4, winnerSide: { tag: "Claimant" }, confidence: 90, summary: null }),
    marketEvent({ name: "fee_claimed", amount: 100n, recipient: "GABCD" }),
    marketEvent({ name: "withdrawal", amount: 100n, to: "GABCD" }),
    marketEvent({ name: "withdrawal_pending", amount: 100n, to: "GABCD" }),
  ];
  for (const event of events) {
    const result = formatPlainTextEvent(config, event);
    if (result !== null) {
      assert.equal(result.includes("*"), false, `Markdown * found for event ${event.payload.name}`);
      assert.equal(result.includes("_"), false, `Markdown _ found for event ${event.payload.name}`);
    }
  }
});

// ── Regression: MarkdownV2 snapshots for key event types ─────────────────────

test("claim_created MarkdownV2 snapshot matches i18n template exactly", () => {
  const config = testnetConfig();
  const event = marketEvent({ name: "claim_created", claimId: 7, category: "crypto", creator: "GABCD" });
  const result = formatEvent(config, event);
  const expected =
    "🆕 *New claim* \\#7\nCategory: crypto\nCreator: `GABCD`\n_ledger 42_";
  assert.equal(result, expected);
});

test("claim_challenged MarkdownV2 snapshot matches i18n template exactly", () => {
  const config = testnetConfig();
  const event = marketEvent({
    name: "claim_challenged",
    claimId: 7,
    challenger: "GABCD",
    stake: 20_000_000n,
  });
  const result = formatEvent(config, event);
  assert.match(result, /⚔️ \*Claim \\#7 challenged\*/);
  assert.match(result, /Stake: \*2\\\.0000000 USDC\*/);
  assert.match(result, /Challenger: `GABCD`/);
});

test("claim_cancelled MarkdownV2 snapshot matches i18n template", () => {
  const config = testnetConfig();
  const event = marketEvent({ name: "claim_cancelled", claimId: 7 });
  const result = formatEvent(config, event);
  assert.match(result, /🚫 \*Claim \\#7 cancelled\* — stakes returned/);
});

test("squad market_created MarkdownV2 snapshot matches i18n template", () => {
  const config = testnetConfig();
  const event = squadEvent({
    name: "market_created",
    marketId: 5,
    question: "Will Stellar succeed?",
    captain: "GABCD",
    feeBps: 100,
    deadline: 1800000000,
  });
  const result = formatEvent(config, event);
  assert.match(result, /🆕 \*New squad market\* \\#5/);
  assert.match(result, /Will Stellar succeed\?/);
  assert.match(result, /Captain:/);
  assert.match(result, /deadline/);
});

// ── Regression: operator command replies are wired through i18n ───────────────

test("/pause and /resume bot replies are sourced from PAUSE_MESSAGES and RESUME_MESSAGES", async () => {
  const TELEGRAM_OPTIONS = { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } };
  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
  });

  const pauseReplies = [];
  const pauseCtx = {
    from: { id: 42 },
    update: { update_id: 200 },
    reply: async (...args) => pauseReplies.push(args),
  };
  await handlers.get("pause")(pauseCtx);
  assert.equal(pauseReplies.length, 1);
  assert.equal(pauseReplies[0][0], PAUSE_MESSAGES.paused);
  assert.deepEqual(pauseReplies[0][1], TELEGRAM_OPTIONS);

  const resumeReplies = [];
  const resumeCtx = {
    from: { id: 42 },
    update: { update_id: 201 },
    reply: async (...args) => resumeReplies.push(args),
  };
  await handlers.get("resume")(resumeCtx);
  assert.equal(resumeReplies.length, 1);
  assert.equal(resumeReplies[0][0], RESUME_MESSAGES.resumed);
  assert.deepEqual(resumeReplies[0][1], TELEGRAM_OPTIONS);
});

test("/pause already-paused reply matches PAUSE_MESSAGES.alreadyPaused", async () => {
  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "already-paused",
    resume: () => "already-running",
  });

  const replies = [];
  const ctx = {
    from: { id: 42 },
    update: { update_id: 202 },
    reply: async (...args) => replies.push(args),
  };
  await handlers.get("pause")(ctx);
  assert.equal(replies[0][0], PAUSE_MESSAGES.alreadyPaused);
});

test("/pause stopped reply matches PAUSE_MESSAGES.stopped", async () => {
  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "stopped",
    resume: () => "stopped",
  });

  const replies = [];
  const ctx = {
    from: { id: 42 },
    update: { update_id: 203 },
    reply: async (...args) => replies.push(args),
  };
  await handlers.get("pause")(ctx);
  assert.equal(replies[0][0], PAUSE_MESSAGES.stopped);
});

// ── Boundary: no reserved character in plain-text templates ──────────────────

test("all NOTIFICATION_PLAIN template functions return strings without MarkdownV2 syntax", () => {
  const mdSyntaxRe = /[*_`[\]\\]/;

  // Sample calls for all plain templates
  const results = [
    NOTIFICATION_PLAIN.claimCreated(1, "cat", "ADDR"),
    NOTIFICATION_PLAIN.claimChallenged(1, "1.0 USDC", "ADDR"),
    NOTIFICATION_PLAIN.claimResolved(1, "claimant", "100", null),
    NOTIFICATION_PLAIN.claimResolved(1, "claimant", "100", "a summary"),
    NOTIFICATION_PLAIN.claimCancelled(1),
    NOTIFICATION_PLAIN.marketSettled(1, "10.0 USDC", "0.5 USDC", "5.0 USDC"),
    NOTIFICATION_PLAIN.challengerPaid(1, "ADDR", "2.0 USDC", "1.5 USDC", "2.0 USDC", "0.5 USDC"),
    NOTIFICATION_PLAIN.feeClaimed("1.0 USDC", "ADDR"),
    NOTIFICATION_PLAIN.withdrawal("5.0 USDC", "ADDR"),
    NOTIFICATION_PLAIN.withdrawalPending("5.0 USDC", "ADDR"),
    NOTIFICATION_PLAIN.marketCreated(1, "Will it?", "ADDR", "50", "2027-01-01T00:00:00.000Z"),
    NOTIFICATION_PLAIN.deposited(1, "10.0 USDC", "side A", "ADDR"),
    NOTIFICATION_PLAIN.withdrawn(1, "ADDR", "5.0 USDC", "side A"),
    NOTIFICATION_PLAIN.resolved(1, "side A", "10.0 USDC", "5.0 USDC"),
    NOTIFICATION_PLAIN.claimed(1, "ADDR", "9.0 USDC", "10.0 USDC", "1.0 USDC"),
    NOTIFICATION_PLAIN.feesClaimedSquad("2.0 USDC", "ADDR"),
    NOTIFICATION_PLAIN.minimal("market", "ledger 42", "42-0"),
  ];

  for (const r of results) {
    assert.equal(typeof r, "string");
    assert.ok(r.length > 0, "plain text template returned empty string");
    assert.equal(
      mdSyntaxRe.test(r),
      false,
      `plain text template contains MarkdownV2 syntax: "${r}"`,
    );
  }
});
