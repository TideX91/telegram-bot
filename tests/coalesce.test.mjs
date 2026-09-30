import assert from "node:assert/strict";
import test from "node:test";
import { buildDigests } from "../dist/poller.js";
import { createNotifier } from "../dist/bot.js";

test("buildDigests chunks events to keep messages under 4000 characters", () => {
  const config = { maxNotificationsPerCycle: 20 };
  const mockFormatFn = (cfg, event) => {
    if (event.skip) return null;
    return "A".repeat(1000);
  };

  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({ payload: { name: "test" } });
  }

  const digests = buildDigests(events, config, mockFormatFn);
  
  assert.equal(digests.length, 4);
  assert.equal(digests[0].count, 3);
  assert.equal(digests[1].count, 3);
  assert.equal(digests[2].count, 3);
  assert.equal(digests[3].count, 1);
  assert.equal(digests[0].skipped, 0);
});

test("coalesced payload sent to Telegram using mock grammy bot", async () => {
  const config = { chatId: "-100123", maxNotificationsPerCycle: 20 };
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const send = createNotifier(fakeBot, config);
  
  const mockFormatFn = (cfg, event) => {
    return event.payload.text;
  };
  
  const events = [
    { payload: { name: "test", text: "*Event 1*" } },
    { payload: { name: "test", text: "_Event 2_" } },
  ];

  const digests = buildDigests(events, config, mockFormatFn);
  for (const digest of digests) {
      if (digest.text) {
          await send(digest.text);
      }
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "-100123");
  assert.equal(sent[0][1], "*Event 1*\n\n_Event 2_");
  assert.equal(sent[0][2].parse_mode, "MarkdownV2");
});
