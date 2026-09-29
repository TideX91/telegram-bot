import assert from "node:assert/strict";
import test from "node:test";
import { registerCommandHandlers, registerCommands } from "../dist/bot.js";

const OPTIONS = {
  parse_mode: "MarkdownV2",
  link_preview_options: { is_disabled: true },
};
const INTRO = "*Mimir notifier*\n\nI watch Mimir's two Soroban contracts on Stellar and post every new on\\-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.\n\n";
const PUBLIC_LINES = [
  "/start — What this bot does",
  "/help — Show help",
  "/status — Last\\-seen ledger and watched contracts",
  "/contracts — Contract ids and explorer links",
  "/health — Health assessment and operational readiness",
  "/preview — Preview channel notification formatting",
];
const ALL_LINES = [
  ...PUBLIC_LINES.slice(0, 3),
  "/audit — Operator only: audit report \\(redacted, bounded\\)",
  ...PUBLIC_LINES.slice(3),
  "/pause — Operator only: pause new scans",
  "/resume — Operator only: resume polling now",
];

function fixture(operatorTelegramUserId) {
  const config = { operatorTelegramUserId };
  const handlers = new Map();
  const menus = [];
  const unexpected = () => { throw new Error("help must not access poller state"); };
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
    api: { setMyCommands: async (commands) => menus.push(commands) },
  };
  registerCommandHandlers(bot, { config, status: unexpected, pause: unexpected, resume: unexpected });
  return { bot, config, handlers, menus };
}

for (const operatorId of [null, "42"]) {
  test(`help and start snapshot the registered command list (operator=${operatorId})`, async () => {
    const { bot, config, handlers, menus } = fixture(operatorId);
    await registerCommands(bot, config);
    const lines = operatorId === null ? PUBLIC_LINES : ALL_LINES;
    for (const command of ["help", "start"]) {
      const replies = [];
      await handlers.get(command)({ reply: async (...args) => replies.push(args) });
      assert.deepEqual(replies, [[INTRO + lines.join("\n"), OPTIONS]]);
      assert.ok(replies[0][0].length < 4096);
    }
    assert.deepEqual(menus[0].map(({ command }) => command), lines.map((line) => line.split(" ")[0].slice(1)));
    for (const { command, description } of menus[0]) {
      assert.ok(handlers.has(command), `${command} has a handler`);
      assert.ok(description.length >= 1 && description.length <= 256);
    }
    assert.equal(handlers.size, 9, "disabled operator handlers still enforce authorization");
  });
}

test("a new registration reflects operator configuration after restart", async () => {
  const first = fixture("42");
  await registerCommands(first.bot, first.config);
  const restarted = fixture(null);
  await registerCommands(restarted.bot, restarted.config);
  assert.equal(first.menus[0].some(({ command }) => command === "audit"), true);
  assert.equal(restarted.menus[0].some(({ command }) => ["audit", "pause", "resume"].includes(command)), false);
});

test("Telegram help failures propagate once without accessing poller state", async () => {
  const { handlers } = fixture("42");
  const failure = new Error("Telegram unavailable");
  let calls = 0;
  await assert.rejects(handlers.get("help")({ reply: async () => { calls++; throw failure; } }), (error) => error === failure);
  assert.equal(calls, 1);
});

test("command-menu failure is cosmetic, bounded, and redacts token-shaped text", async () => {
  const { bot, config } = fixture(null);
  const token = "123456789:TEST-TOKEN-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  bot.api.setMyCommands = async () => { throw new Error(`${token} ${"remote".repeat(200)}`); };
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    await registerCommands(bot, config);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(token), false);
  assert.ok(warnings[0].length <= 280);
});
