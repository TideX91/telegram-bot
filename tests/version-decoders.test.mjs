import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeEvent,
  DEFAULT_CONTRACT_VERSION,
  MARKET_DECODERS,
  normalizeContractVersion,
  SQUAD_DECODERS,
} from "../dist/stellar/decode.js";
import { loadStellarConfig } from "../dist/config.js";
import { contractsMessage, statusMessage } from "../dist/bot.js";
import { buildHealthReport } from "../dist/health.js";
import { Address, xdr } from "@stellar/stellar-sdk";

test("normalizeContractVersion handles defaults, trimming, and casing", () => {
  assert.equal(normalizeContractVersion(""), DEFAULT_CONTRACT_VERSION);
  assert.equal(normalizeContractVersion(undefined), DEFAULT_CONTRACT_VERSION);
  assert.equal(normalizeContractVersion(" V2 "), "v2");
  assert.equal(normalizeContractVersion("v1"), "v1");
});

test("MARKET_DECODERS and SQUAD_DECODERS registries contain v1 and v2 decoders", () => {
  assert.ok(typeof MARKET_DECODERS.v1 === "function");
  assert.ok(typeof MARKET_DECODERS.v2 === "function");
  assert.ok(typeof SQUAD_DECODERS.v1 === "function");
  assert.ok(typeof SQUAD_DECODERS.v2 === "function");
});

test("decodeEvent positive: market v1 event claim_created", () => {
  const creatorAddr = xdr.ScVal.scvString("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW");
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 100,
    txHash: "tx123",
    ledgerClosedAt: "2026-09-25T00:00:00Z",
    id: "100-1",
    topic: [
      xdr.ScVal.scvSymbol("claim_created"),
      xdr.ScVal.scvU64(new xdr.Uint64(1, 0)),
      creatorAddr,
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("category"),
        val: xdr.ScVal.scvString("crypto"),
      }),
    ]),
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.source, "market");
  assert.equal(decoded.version, "v1");
  assert.equal(decoded.payload.name, "claim_created");
  if (decoded.payload.name === "claim_created") {
    assert.equal(decoded.payload.claimId, 1);
    assert.equal(decoded.payload.category, "crypto");
  }
});

test("decodeEvent positive: market v2 event claim_created with title extension", () => {
  const creatorAddr = xdr.ScVal.scvString("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW");
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 101,
    txHash: "tx124",
    ledgerClosedAt: "2026-09-25T00:00:00Z",
    id: "101-1",
    topic: [
      xdr.ScVal.scvSymbol("claim_created"),
      xdr.ScVal.scvU64(new xdr.Uint64(2, 0)),
      creatorAddr,
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("category"),
        val: xdr.ScVal.scvString("crypto"),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("title"),
        val: xdr.ScVal.scvString("Stellar Protocol 22"),
      }),
    ]),
  };

  const decoded = decodeEvent("market", event, "v2");
  assert.equal(decoded.version, "v2");
  assert.equal(decoded.payload.name, "claim_created");
  if (decoded.payload.name === "claim_created") {
    assert.equal(decoded.payload.claimId, 2);
    assert.equal(decoded.payload.title, "Stellar Protocol 22");
  }
});

test("decodeEvent negative: unknown event name becomes unknown payload", () => {
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 102,
    txHash: "tx125",
    topic: [xdr.ScVal.scvSymbol("unknown_future_event")],
    value: xdr.ScVal.scvVoid(),
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.payload.name, "unknown");
  if (decoded.payload.name === "unknown") {
    assert.equal(decoded.payload.eventName, "unknown_future_event");
  }
});

test("decodeEvent boundary: malformed XDR value never crashes decoder", () => {
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 103,
    txHash: "tx126",
    topic: [xdr.ScVal.scvSymbol("claim_created")],
    value: {
      // Intentionally invalid ScVal object that will fail scValToNative
      switch: () => {
        throw new Error("Invalid XDR discriminator");
      },
    },
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.payload.name, "unknown");
  if (decoded.payload.name === "unknown") {
    assert.match(decoded.payload.reason, /malformed XDR value/);
  }
});

test("decodeEvent boundary: invalid strkey address in topic yields unknown payload", () => {
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 104,
    txHash: "tx127",
    topic: [
      xdr.ScVal.scvSymbol("claim_created"),
      xdr.ScVal.scvU64(new xdr.Uint64(1, 0)),
      xdr.ScVal.scvString("NOT_A_VALID_STELLAR_ADDRESS"),
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("category"),
        val: xdr.ScVal.scvString("tech"),
      }),
    ]),
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.payload.name, "unknown");
  if (decoded.payload.name === "unknown") {
    assert.match(decoded.payload.reason, /expected a Stellar address strkey/);
  }
});

test("loadStellarConfig loads MARKET_CONTRACT_VERSION and SQUAD_CONTRACT_VERSION", () => {
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.MARKET_CONTRACT_VERSION = "v2";
  process.env.SQUAD_CONTRACT_VERSION = "v1";

  const config = loadStellarConfig();
  assert.equal(config.marketContractVersion, "v2");
  assert.equal(config.squadContractVersion, "v1");
});

test("contractsMessage formats contract version in output", () => {
  const config = {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    marketContractVersion: "v2",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };

  const msg = contractsMessage(config);
  assert.match(msg, /mimir\\-market\* \\\(v2\\\)/);
  assert.match(msg, /mimir\\-squad\* \\\(v1\\\)/);
});

test("statusMessage and buildHealthReport display contract versions", () => {
  const config = {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    marketContractVersion: "v2",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    pollIntervalMs: 30000,
    channelPreviewMode: false,
    healthPort: 0,
  };

  const pollerStatus = {
    running: true,
    paused: false,
    startedAt: 1000,
    cycles: 5,
    lastPollAt: 5000,
    lastSuccessAt: 5000,
    latestLedger: 120,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: config.marketContractId,
        version: "v2",
        cursor: "100-1",
        lastEventLedger: 110,
        lastError: null,
      },
      {
        source: "squad",
        contractId: config.squadContractId,
        version: "v1",
        cursor: "100-2",
        lastEventLedger: 115,
        lastError: null,
      },
    ],
  };

  const msg = statusMessage(config, pollerStatus);
  assert.match(msg, /mimir\\-market \\\(v2\\\)/);
  assert.match(msg, /mimir\\-squad \\\(v1\\\)/);

  const report = buildHealthReport(config, pollerStatus, 10000);
  assert.equal(report.poller.targets[0].version, "v2");
  assert.equal(report.poller.targets[1].version, "v1");
});
