import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CALLBACK_FALLBACK_FEEDBACK,
  CALLBACK_FALLBACK_PAYLOAD,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
  CALLBACK_UNAUTHORIZED_PAYLOAD,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  TELEGRAM_OPTIONS,
  contractsKeyboard,
  contractsMessage,
  createBot,
  handleCallbackQuery,
  isOperator,
  operatorKeyboard,
  pauseMessage,
  registerCallbackHandlers,
  resumeMessage,
  statusKeyboard,
  statusMessage,
  validateCallbackData,
} from "../dist/bot.js";
import { safeErrorMessage } from "../dist/notifications/format.js";

const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const OPERATOR_ID = "42";

function fakeConfig(overrides = {}) {
  return {
    botToken: "123456789:SECRET-BOT-TOKEN-TEST",
    chatId: "-1001234567890",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    operatorTelegramUserId: OPERATOR_ID,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function fakeStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1_000_000,
    cycles: 12,
    lastPollAt: 1_000_500,
    lastSuccessAt: 1_000_500,
    latestLedger: 500_000,
    oldestLedger: 400_000,
    notificationsSent: 15,
    notificationsFailed: 1,
    eventsSkipped: 3,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: MARKET_ID,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 499_999,
        lastError: null,
      },
      {
        source: "squad",
        contractId: SQUAD_ID,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 499_998,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function harness(depsOverrides = {}) {
  const config = fakeConfig(depsOverrides.config ?? {});
  let currentStatus = fakeStatus(depsOverrides.statusData ?? {});
  let pauseResult = "paused";
  let resumeResult = "resumed";
  let pauseCalls = 0;
  let resumeCalls = 0;

  const deps = {
    config,
    status: () => currentStatus,
    pause: () => {
      pauseCalls += 1;
      return pauseResult;
    },
    resume: () => {
      resumeCalls += 1;
      return resumeResult;
    },
    ...depsOverrides,
  };

  const bot = createBot(deps);
  bot.botInfo = BOT_INFO;

  const apiCalls = [];
  let editMessageTextError = null;
  let answerCallbackQueryError = null;

  bot.api.config.use(async (prev, method, payload, signal) => {
    apiCalls.push({ method, payload });

    if (method === "editMessageText") {
      if (editMessageTextError) throw editMessageTextError;
      return { ok: true, result: true };
    }
    if (method === "answerCallbackQuery") {
      if (answerCallbackQueryError) throw answerCallbackQueryError;
      return { ok: true, result: true };
    }
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: 999 } };
    }

    return prev(method, payload, signal);
  });

  return {
    bot,
    deps,
    config,
    apiCalls,
    setStatus: (s) => {
      currentStatus = s;
    },
    setPauseResult: (r) => {
      pauseResult = r;
    },
    setResumeResult: (r) => {
      resumeResult = r;
    },
    getPauseCalls: () => pauseCalls,
    getResumeCalls: () => resumeCalls,
    setEditMessageTextError: (err) => {
      editMessageTextError = err;
    },
    setAnswerCallbackQueryError: (err) => {
      answerCallbackQueryError = err;
    },
  };
}

function callbackUpdate(data, userId = Number(OPERATOR_ID), updateId = 100, hasMessage = true) {
  return {
    update_id: updateId,
    callback_query: {
      id: `query_${updateId}`,
      from: { id: userId, is_bot: false, first_name: "OperatorUser" },
      ...(hasMessage
        ? {
            message: {
              message_id: 50 + updateId,
              date: 0,
              chat: { id: -1001234567890, type: "supergroup" },
              text: "initial text",
            },
          }
        : {}),
      data,
    },
  };
}

async function withoutConsoleWarnings(fn) {
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
    console.error = origErr;
  }
}

// ── 1. Unit Tests: validateCallbackData ────────────────────────────────────────

test("validateCallbackData accepts canonical action strings", () => {
  const actions = ["status", "contracts", "help", "pause", "resume"];
  for (const act of actions) {
    const res = validateCallbackData(act);
    assert.equal(res.ok, true, `Action ${act} should be valid`);
    assert.equal(res.action.type, act);
    assert.equal(res.action.raw, act);
  }
});

test("validateCallbackData accepts valid colon-delimited action formats", () => {
  const cases = [
    ["status:refresh", "status"],
    ["status:view", "status"],
    ["mimir:status", "status"],
    ["contracts:view", "contracts"],
    ["mimir:contracts", "contracts"],
    ["help:view", "help"],
    ["mimir:help", "help"],
    ["pause:toggle", "pause"],
    ["mimir:pause", "pause"],
    ["resume:now", "resume"],
    ["mimir:resume", "resume"],
  ];

  for (const [raw, expectedType] of cases) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, true, `Raw ${raw} should be valid`);
    assert.equal(res.action.type, expectedType);
    assert.equal(res.action.raw, raw);
  }
});

test("validateCallbackData accepts valid JSON action payloads", () => {
  const validJson = JSON.stringify({ action: "status" });
  const res = validateCallbackData(validJson);
  assert.equal(res.ok, true);
  assert.equal(res.action.type, "status");
  assert.equal(res.action.raw, validJson);
});

test("validateCallbackData rejects non-string inputs", () => {
  const invalids = [null, undefined, 42, true, false, {}, [], () => {}];
  for (const inv of invalids) {
    const res = validateCallbackData(inv);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "missing-or-non-string");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData rejects empty or whitespace-only strings", () => {
  const empties = ["", "   ", "\t", "\r\n"];
  for (const empty of empties) {
    const res = validateCallbackData(empty);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "empty");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData rejects unknown action strings", () => {
  const unknowns = [
    "bad_action",
    "deposit",
    "withdraw:100",
    "sign_tx",
    "rm_rf",
    "transfer:GABCD",
    "admin:change_oracle",
    "mimir:evil",
  ];
  for (const unk of unknowns) {
    const res = validateCallbackData(unk);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unknown-action");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData rejects malformed JSON or unknown JSON actions", () => {
  const malformed = "{action:status}";
  const res1 = validateCallbackData(malformed);
  assert.equal(res1.ok, false);
  assert.equal(res1.reason, "malformed-json");

  const unknownJson = JSON.stringify({ action: "drain_funds" });
  const res2 = validateCallbackData(unknownJson);
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "unknown-json-action");

  const noActionJson = JSON.stringify({ other_key: "value" });
  const res3 = validateCallbackData(noActionJson);
  assert.equal(res3.ok, false);
  assert.equal(res3.reason, "unknown-json-action");
});

test("validateCallbackData boundary: accepts exact 64-byte payload, rejects 65 bytes", () => {
  assert.equal(TELEGRAM_CALLBACK_DATA_MAX_BYTES, 64);

  // Exact 64 bytes: "status" padded with trailing spaces to 64 bytes
  const exactly64 = "status" + " ".repeat(58);
  assert.equal(Buffer.byteLength(exactly64, "utf8"), 64);
  const res64 = validateCallbackData(exactly64);
  assert.equal(res64.ok, true);
  assert.equal(res64.action.type, "status");

  // 65 bytes: 1 byte over limit
  const exactly65 = "status" + " ".repeat(59);
  assert.equal(Buffer.byteLength(exactly65, "utf8"), 65);
  const res65 = validateCallbackData(exactly65);
  assert.equal(res65.ok, false);
  assert.equal(res65.reason, "exceeds-max-length");

  // Extreme boundary: 10,000 bytes adversary input
  const huge = "status:".repeat(2000);
  const resHuge = validateCallbackData(huge);
  assert.equal(resHuge.ok, false);
  assert.equal(resHuge.reason, "exceeds-max-length");
});

test("validateCallbackData rejects control characters including null bytes", () => {
  const withNull = "status\0refresh";
  const resNull = validateCallbackData(withNull);
  assert.equal(resNull.ok, false);
  assert.equal(resNull.reason, "control-characters");

  const withControl = "status\x07bell";
  const resControl = validateCallbackData(withControl);
  assert.equal(resControl.ok, false);
  assert.equal(resControl.reason, "control-characters");
});

// ── 2. Keyboard Builders ──────────────────────────────────────────────────────

test("statusKeyboard renders refresh and contracts buttons, plus operator buttons if configured", () => {
  const publicKb = statusKeyboard(fakeConfig({ operatorTelegramUserId: null }));
  const publicJson = JSON.parse(JSON.stringify(publicKb));
  assert.deepEqual(publicJson, {
    inline_keyboard: [
      [
        { text: "🔄 Refresh", callback_data: "status" },
        { text: "📋 Contracts", callback_data: "contracts" },
      ],
    ],
  });

  const operatorKb = statusKeyboard(fakeConfig({ operatorTelegramUserId: "42" }));
  const operatorJson = JSON.parse(JSON.stringify(operatorKb));
  assert.deepEqual(operatorJson, {
    inline_keyboard: [
      [
        { text: "🔄 Refresh", callback_data: "status" },
        { text: "📋 Contracts", callback_data: "contracts" },
      ],
      [
        { text: "⏸ Pause", callback_data: "pause" },
        { text: "▶ Resume", callback_data: "resume" },
      ],
    ],
  });
});

test("contractsKeyboard renders status and help navigation buttons", () => {
  const kb = contractsKeyboard();
  const json = JSON.parse(JSON.stringify(kb));
  assert.deepEqual(json, {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "status" },
        { text: "❓ Help", callback_data: "help" },
      ],
    ],
  });
});

test("operatorKeyboard renders pause, resume, and status buttons", () => {
  const kb = operatorKeyboard();
  const json = JSON.parse(JSON.stringify(kb));
  assert.deepEqual(json, {
    inline_keyboard: [
      [
        { text: "⏸ Pause", callback_data: "pause" },
        { text: "▶ Resume", callback_data: "resume" },
      ],
      [{ text: "📊 Status", callback_data: "status" }],
    ],
  });
});

// ── 3. Positive Callback Queries: Exact MarkdownV2 Snapshots ──────────────────

test("positive 'status' callback query snapshots exact MarkdownV2 and answers query", async () => {
  const { bot, config, deps, apiCalls } = harness();
  const update = callbackUpdate("status", 42, 101);

  await bot.handleUpdate(update);

  const editCall = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(editCall, "editMessageText must be called");
  const expectedText = statusMessage(config, deps.status());
  assert.equal(editCall.payload.text, expectedText);
  assert.equal(editCall.payload.parse_mode, "MarkdownV2");
  assert.deepEqual(editCall.payload.link_preview_options, { is_disabled: true });

  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall, "answerCallbackQuery must be called");
  assert.equal(answerCall.payload.callback_query_id, "query_101");
  assert.equal(answerCall.payload.text, "Status refreshed");
});

test("positive 'contracts' callback query snapshots exact MarkdownV2 and answers query", async () => {
  const { bot, config, apiCalls } = harness();
  const update = callbackUpdate("contracts", 42, 102);

  await bot.handleUpdate(update);

  const editCall = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(editCall, "editMessageText must be called");
  const expectedText = contractsMessage(config);
  assert.equal(editCall.payload.text, expectedText);
  assert.equal(editCall.payload.parse_mode, "MarkdownV2");
  assert.deepEqual(editCall.payload.link_preview_options, { is_disabled: true });

  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall, "answerCallbackQuery must be called");
  assert.equal(answerCall.payload.callback_query_id, "query_102");
  assert.equal(answerCall.payload.text, "Contracts");
});

test("positive operator 'pause' callback query executes pause() and snapshots exact MarkdownV2", async () => {
  const { bot, apiCalls, getPauseCalls } = harness();
  const update = callbackUpdate("pause", Number(OPERATOR_ID), 103);

  await bot.handleUpdate(update);

  assert.equal(getPauseCalls(), 1);
  const editCall = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(editCall);
  assert.equal(editCall.payload.text, pauseMessage("paused"));
  assert.equal(editCall.payload.parse_mode, "MarkdownV2");

  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.text, "Polling paused");
});

test("positive operator 'resume' callback query executes resume() and snapshots exact MarkdownV2", async () => {
  const { bot, apiCalls, getResumeCalls } = harness();
  const update = callbackUpdate("resume", Number(OPERATOR_ID), 104);

  await bot.handleUpdate(update);

  assert.equal(getResumeCalls(), 1);
  const editCall = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(editCall);
  assert.equal(editCall.payload.text, resumeMessage("resumed"));
  assert.equal(editCall.payload.parse_mode, "MarkdownV2");

  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.text, "Polling resumed");
});

// ── 4. Negative Callback Queries: Authorization & Validation Rejections ────────

test("unauthorized user clicking 'pause' callback is rejected without mutating state", async () => {
  const { bot, apiCalls, getPauseCalls } = harness();
  // Non-operator user id (999 !== 42)
  const update = callbackUpdate("pause", 999, 105);

  await withoutConsoleWarnings(async () => {
    await bot.handleUpdate(update);
  });

  // State must not be mutated
  assert.equal(getPauseCalls(), 0);

  // Message must not be edited
  const editCall = apiCalls.find((c) => c.method === "editMessageText");
  assert.equal(editCall, undefined);

  // Callback query must be answered with unauthorized alert
  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.callback_query_id, "query_105");
  assert.equal(answerCall.payload.text, CALLBACK_UNAUTHORIZED_FEEDBACK);
  assert.equal(answerCall.payload.show_alert, true);
});

test("unauthorized user clicking 'resume' callback is rejected without mutating state", async () => {
  const { bot, apiCalls, getResumeCalls } = harness();
  const update = callbackUpdate("resume", 999, 106);

  await withoutConsoleWarnings(async () => {
    await bot.handleUpdate(update);
  });

  assert.equal(getResumeCalls(), 0);
  const editCall = apiCalls.find((c) => c.method === "editMessageText");
  assert.equal(editCall, undefined);

  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.text, CALLBACK_UNAUTHORIZED_FEEDBACK);
  assert.equal(answerCall.payload.show_alert, true);
});

test("operator callback is rejected when no operator ID is configured", async () => {
  const { bot, apiCalls, getPauseCalls } = harness({
    config: { operatorTelegramUserId: null },
  });
  const update = callbackUpdate("pause", 42, 107);

  await withoutConsoleWarnings(async () => {
    await bot.handleUpdate(update);
  });

  assert.equal(getPauseCalls(), 0);
  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.text, CALLBACK_UNAUTHORIZED_FEEDBACK);
});

test("malformed or unrecognized callback query data is rejected with fallback feedback", async () => {
  const { bot, apiCalls, getPauseCalls, getResumeCalls } = harness();
  const update = callbackUpdate("unrecognized_action_123", 42, 108);

  await withoutConsoleWarnings(async () => {
    await bot.handleUpdate(update);
  });

  assert.equal(getPauseCalls(), 0);
  assert.equal(getResumeCalls(), 0);
  assert.equal(apiCalls.find((c) => c.method === "editMessageText"), undefined);

  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.text, CALLBACK_FALLBACK_FEEDBACK);
  assert.equal(answerCall.payload.show_alert, false);
});

test("oversized callback query data (> 64 bytes) is rejected with fallback feedback", async () => {
  const { bot, apiCalls } = harness();
  const oversizedData = "status:" + "x".repeat(60); // > 64 bytes
  const update = callbackUpdate(oversizedData, 42, 109);

  await withoutConsoleWarnings(async () => {
    await bot.handleUpdate(update);
  });

  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.text, CALLBACK_FALLBACK_FEEDBACK);
});

// ── 5. Boundary & Failure Modes ───────────────────────────────────────────────

test("boundary: 'message is not modified' error during status refresh is handled cleanly", async () => {
  const { bot, apiCalls, setEditMessageTextError } = harness();
  setEditMessageTextError(
    new Error(
      "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
    ),
  );

  const update = callbackUpdate("status", 42, 110);
  await bot.handleUpdate(update);

  // answerCallbackQuery should still succeed with confirmation
  const answerCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.ok(answerCall);
  assert.equal(answerCall.payload.text, "Status refreshed");
});

test("boundary: editMessageText failure falls back to sendMessage", async () => {
  const { bot, apiCalls, setEditMessageTextError, config, deps } = harness();
  setEditMessageTextError(new Error("Bad Request: message to edit not found"));

  const update = callbackUpdate("status", 42, 111);
  await bot.handleUpdate(update);

  const sendCall = apiCalls.find((c) => c.method === "sendMessage");
  assert.ok(sendCall, "sendMessage fallback must be called");
  assert.equal(sendCall.payload.text, statusMessage(config, deps.status()));
  assert.equal(sendCall.payload.parse_mode, "MarkdownV2");
});

test("boundary: callback query without message object falls back to sendMessage", async () => {
  const { bot, apiCalls, config, deps } = harness();
  const update = callbackUpdate("status", 42, 112, false);

  await bot.handleUpdate(update);

  const sendCall = apiCalls.find((c) => c.method === "sendMessage");
  assert.ok(sendCall, "sendMessage must be called when callback has no message");
  assert.equal(sendCall.payload.text, statusMessage(config, deps.status()));
});

test("boundary: answerCallbackQuery failure does not crash the bot", async () => {
  const { bot, setAnswerCallbackQueryError } = harness();
  setAnswerCallbackQueryError(new Error("Bad Request: query is too old and response timeout expired"));

  const update = callbackUpdate("status", 42, 113);
  await withoutConsoleWarnings(async () => {
    await assert.doesNotReject(bot.handleUpdate(update));
  });
});

// ── 6. Restart & State Isolation ──────────────────────────────────────────────

test("restart isolation: callback query answers accurately before and after simulated restart", async () => {
  const { bot, config, setStatus, apiCalls } = harness();

  // First call before restart
  await bot.handleUpdate(callbackUpdate("status", 42, 114));
  const edit1 = apiCalls.filter((c) => c.method === "editMessageText")[0];
  assert.match(edit1.payload.text, /Chain tip: 500000/);

  // Simulate restart with new status
  setStatus(fakeStatus({ latestLedger: 500_100, cycles: 13 }));
  await bot.handleUpdate(callbackUpdate("status", 42, 115));
  const edit2 = apiCalls.filter((c) => c.method === "editMessageText")[1];
  assert.match(edit2.payload.text, /Chain tip: 500100/);
});

test("state isolation: callback queries never touch or corrupt the persisted cursor file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cb-cursor-"));
  const cursorFile = path.join(dir, "cursor.json");
  const initialContent = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    targets: {
      market: { cursor: "111-0", lastEventLedger: 50 },
      squad: { cursor: "222-0", lastEventLedger: 51 },
    },
  });
  await writeFile(cursorFile, initialContent, "utf8");

  const { bot } = harness({ config: { cursorFile } });

  // Send various callback updates
  await bot.handleUpdate(callbackUpdate("status", 42, 116));
  await bot.handleUpdate(callbackUpdate("contracts", 42, 117));
  await bot.handleUpdate(callbackUpdate("pause", 42, 118));
  await bot.handleUpdate(callbackUpdate("resume", 42, 119));

  // Verify file content is completely untouched
  const fileAfter = await readFile(cursorFile, "utf8");
  assert.equal(fileAfter, initialContent, "Cursor file must not be modified by callback queries");

  await rm(dir, { recursive: true, force: true });
});

// ── 7. Redaction & Safety Snapshots ───────────────────────────────────────────

test("exact fallback and unauthorized payloads match declared constants", () => {
  assert.equal(
    CALLBACK_FALLBACK_PAYLOAD,
    "*Invalid request*\nThe requested action is unrecognized or malformed\\.",
  );
  assert.equal(
    CALLBACK_UNAUTHORIZED_PAYLOAD,
    "*Unauthorized*\nThis action requires operator privileges\\.",
  );
});

test("isOperator correctly validates operator role", () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  assert.equal(isOperator({ from: { id: 42 } }, config), true);
  assert.equal(isOperator({ from: { id: 99 } }, config), false);
  assert.equal(isOperator({ from: undefined }, config), false);

  const disabledConfig = fakeConfig({ operatorTelegramUserId: null });
  assert.equal(isOperator({ from: { id: 42 } }, disabledConfig), false);
});

test("safeErrorMessage redacts bot tokens from callback handler errors", () => {
  const secretToken = "123456789:SECRET-BOT-TOKEN-TEST";
  const err = new Error(`Connection to Telegram failed with token ${secretToken}`);
  const safe = safeErrorMessage(err, [secretToken]);
  assert.equal(safe.includes(secretToken), false);
  assert.match(safe, /\[REDACTED]/);
});
