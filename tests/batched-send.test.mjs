import assert from "node:assert/strict";
import test from "node:test";
import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";
import { nativeToScVal, Address, Keypair } from "@stellar/stellar-sdk";
import { Bot, GrammyError } from "grammy";
import { createNotifier } from "../dist/bot.js";
import { createAuditLog } from "../dist/audit.js";

const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const CREATOR = "G" + "A".repeat(55);

function baseConfig(overrides = {}) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "http://example.com/rpc",
    horizonUrl: "http://example.com/horizon",
    networkPassphrase: "Test SDF",
    explorerBaseUrl: "https://example.com",
    botToken: "fake-token",
    chatId: "123",
    pollIntervalMs: 9999999,
    maxNotificationsPerCycle: 5,
    operatorTelegramUserId: "42",
    ...overrides,
  };
}

const SHUT_TIP = 5000;
function claimCreatedEvent(claimId) {
  return {
    id: `${SHUT_TIP}-${claimId}`,
    contractId: MARKET_ID,
    ledger: SHUT_TIP,
    txHash: "ab".repeat(32),
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    topic: [
      nativeToScVal("claim_created", { type: "symbol" }),
      nativeToScVal(BigInt(claimId), { type: "u64" }),
      Address.account(Buffer.from(Keypair.fromPublicKey(CREATOR).rawPublicKey())).toScVal(),
    ],
    value: nativeToScVal({ category: "crypto" }),
  };
}

function mockServer(events) {
  let served = false;
  return {
    async getHealth() { return { status: "healthy", oldestLedger: 4000, latestLedger: SHUT_TIP }; },
    async getEvents(req) {
      const contractIds = req.filters?.[0]?.contractIds ?? [];
      if (contractIds.includes(MARKET_ID) && !served) {
        served = true;
        return { events, cursor: `${SHUT_TIP}-0`, latestLedger: SHUT_TIP };
      }
      return { events: [], cursor: `${SHUT_TIP}-0`, latestLedger: SHUT_TIP };
    }
  };
}

const dataDir = await createTempDataDir("mimir-batched-send-");
test.after(() => dataDir.cleanup());

test("batched-send: full success", async () => {
  const config = baseConfig({ cursorFile: dataDir.file("success.json") });
  const server = mockServer([claimCreatedEvent(1), claimCreatedEvent(2), claimCreatedEvent(3)]);
  
  const bot = new Bot(config.botToken);
  let sentCount = 0;
  bot.api.sendMessage = async (chatId, text, opts) => {
    sentCount++;
  };
  
  const notify = createNotifier(bot, config);
  const poller = createPoller({ 
    config, 
    server, 
    send: notify, 
    sendOptions: { sendSpacingMs: 0, maxSendRetries: 3 },
    audit: createAuditLog(),
    now: () => Date.now(),
  });
  
  await poller.start();
  await new Promise(r => setTimeout(r, 100)); // wait for cycle
  await poller.shutdown();
  
  assert.equal(sentCount, 3);
  const status = poller.status();
  assert.equal(status.notificationsSent, 3);
  assert.equal(status.notificationsFailed, 0);
  assert.equal(status.eventsSkipped, 0);
  
  // The cursor should have advanced past the 3 events
  assert.equal(status.targets[0].cursor, `${SHUT_TIP}-0`);
});

test("batched-send: partial failure", async () => {
  const config = baseConfig({ cursorFile: dataDir.file("partial.json") });
  const server = mockServer([claimCreatedEvent(1), claimCreatedEvent(2), claimCreatedEvent(3)]);
  
  const bot = new Bot(config.botToken);
  let attempts = 0;
  bot.api.sendMessage = async (chatId, text, opts) => {
    attempts++;
    // Make the second message fail completely
    if (text.includes("Claim 2")) {
      throw new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: "Bad Request" }, "sendMessage", {});
    }
  };
  
  const notify = createNotifier(bot, config);
  const poller = createPoller({ 
    config, 
    server, 
    send: notify, 
    sendOptions: { sendSpacingMs: 0, maxSendRetries: 3, initialBackoffMs: 1 },
    audit: createAuditLog(),
    now: () => Date.now(),
  });
  
  await poller.start();
  await new Promise(r => setTimeout(r, 200)); // wait for cycle and retries
  await poller.shutdown();
  
  const status = poller.status();
  assert.equal(status.notificationsSent, 2);
  assert.equal(status.notificationsFailed, 1);
  assert.equal(status.eventsSkipped, 0);
  assert.ok(attempts > 3, "should have retried the failed message");
});

test("batched-send: retry exhaustion outcomes", async () => {
  const config = baseConfig({ cursorFile: dataDir.file("exhaust.json") });
  const server = mockServer([claimCreatedEvent(1), claimCreatedEvent(2), claimCreatedEvent(3)]);
  
  const bot = new Bot(config.botToken);
  bot.api.sendMessage = async (chatId, text, opts) => {
    throw new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 429, description: "Too Many Requests" }, "sendMessage", {});
  };
  
  const notify = createNotifier(bot, config);
  const poller = createPoller({ 
    config, 
    server, 
    send: notify, 
    sendOptions: { sendSpacingMs: 0, maxSendRetries: 2, initialBackoffMs: 1 },
    audit: createAuditLog(),
    now: () => Date.now(),
  });
  
  await poller.start();
  await new Promise(r => setTimeout(r, 300)); // wait for cycle and retries
  await poller.shutdown();
  
  const status = poller.status();
  assert.equal(status.notificationsSent, 0);
  assert.equal(status.notificationsFailed, 3);
  assert.equal(status.eventsSkipped, 0);
});

test("batched-send: burst larger than cap", async () => {
  const config = baseConfig({ cursorFile: dataDir.file("burst.json"), maxNotificationsPerCycle: 2 });
  const server = mockServer([claimCreatedEvent(1), claimCreatedEvent(2), claimCreatedEvent(3), claimCreatedEvent(4)]);
  
  const bot = new Bot(config.botToken);
  let sentCount = 0;
  bot.api.sendMessage = async (chatId, text, opts) => {
    sentCount++;
  };
  
  const notify = createNotifier(bot, config);
  const poller = createPoller({ 
    config, 
    server, 
    send: notify, 
    sendOptions: { sendSpacingMs: 0, maxSendRetries: 1 },
    audit: createAuditLog(),
    now: () => Date.now(),
  });
  
  await poller.start();
  await new Promise(r => setTimeout(r, 100)); // wait for cycle
  await poller.shutdown();
  
  assert.equal(sentCount, 2);
  const status = poller.status();
  assert.equal(status.notificationsSent, 2);
  assert.equal(status.notificationsFailed, 0);
  assert.equal(status.eventsSkipped, 2);
});
