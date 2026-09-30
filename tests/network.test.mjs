/**
 * Tests for multi-network support: STELLAR_NETWORK config, networkLabel,
 * and explorerNetworkSegment across testnet / mainnet / futurenet / custom.
 *
 * All tests are offline — no RPC calls, no Telegram, no credentials.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  networkLabel,
  NETWORK_PASSPHRASES,
  NETWORK_RPC_URLS,
  NETWORK_HORIZON_URLS,
  loadStellarConfig,
  ConfigError,
} from "../dist/config.js";
import {
  explorerNetworkSegment,
  txExplorerUrl,
  contractExplorerUrl,
} from "../dist/stellar/client.js";
import { MOCK_NETWORK_PASSPHRASE } from "../dist/stellar/mock-constants.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

const VALID_MARKET = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD  = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

const KEYS = [
  "STELLAR_NETWORK",
  "STELLAR_RPC_URL",
  "STELLAR_HORIZON_URL",
  "STELLAR_NETWORK_PASSPHRASE",
  "STELLAR_EXPLORER_BASE_URL",
  "MARKET_CONTRACT_ID",
  "SQUAD_CONTRACT_ID",
  "MIMIR_PROFILE",
];

function withEnv(overrides, fn) {
  const saved = new Map();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeConfig(overrides = {}) {
  return {
    marketContractId: VALID_MARKET,
    squadContractId: VALID_SQUAD,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASES.testnet,
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

// ── NETWORK_PASSPHRASES / NETWORK_RPC_URLS / NETWORK_HORIZON_URLS constants ──

test("NETWORK_PASSPHRASES has correct well-known values", () => {
  assert.equal(NETWORK_PASSPHRASES.testnet, "Test SDF Network ; September 2015");
  assert.equal(NETWORK_PASSPHRASES.mainnet, "Public Global Stellar Network ; September 2015");
  assert.equal(NETWORK_PASSPHRASES.futurenet, "Test SDF Future Network ; October 2022");
});

test("NETWORK_RPC_URLS keys match NETWORK_PASSPHRASES keys", () => {
  const rpcKeys = Object.keys(NETWORK_RPC_URLS).sort();
  const ppKeys = Object.keys(NETWORK_PASSPHRASES).sort();
  assert.deepEqual(rpcKeys, ppKeys);
});

test("NETWORK_HORIZON_URLS keys match NETWORK_PASSPHRASES keys", () => {
  const hKeys = Object.keys(NETWORK_HORIZON_URLS).sort();
  const ppKeys = Object.keys(NETWORK_PASSPHRASES).sort();
  assert.deepEqual(hKeys, ppKeys);
});

// ── networkLabel ──────────────────────────────────────────────────────────────

test("networkLabel: network=testnet returns 'testnet'", () => {
  assert.equal(networkLabel(makeConfig({ network: "testnet" })), "testnet");
});

test("networkLabel: network=mainnet returns 'mainnet'", () => {
  assert.equal(networkLabel(makeConfig({ network: "mainnet" })), "mainnet");
});

test("networkLabel: network=futurenet returns 'futurenet'", () => {
  assert.equal(networkLabel(makeConfig({ network: "futurenet" })), "futurenet");
});

test("networkLabel: network=custom with mock passphrase returns 'mock'", () => {
  assert.equal(
    networkLabel(makeConfig({ network: "custom", networkPassphrase: MOCK_NETWORK_PASSPHRASE })),
    "mock",
  );
});

test("networkLabel: network=custom with unknown passphrase returns 'custom'", () => {
  assert.equal(
    networkLabel(makeConfig({ network: "custom", networkPassphrase: "My Private Net ; 2024" })),
    "custom",
  );
});

// Backward-compat: no network field — infer from passphrase
test("networkLabel: no network field, testnet passphrase infers 'testnet'", () => {
  assert.equal(
    networkLabel(makeConfig({ networkPassphrase: NETWORK_PASSPHRASES.testnet })),
    "testnet",
  );
});

test("networkLabel: no network field, mainnet passphrase infers 'mainnet'", () => {
  assert.equal(
    networkLabel(makeConfig({ networkPassphrase: NETWORK_PASSPHRASES.mainnet })),
    "mainnet",
  );
});

test("networkLabel: no network field, futurenet passphrase infers 'futurenet'", () => {
  assert.equal(
    networkLabel(makeConfig({ networkPassphrase: NETWORK_PASSPHRASES.futurenet })),
    "futurenet",
  );
});

test("networkLabel: no network field, unknown passphrase returns 'custom'", () => {
  assert.equal(
    networkLabel(makeConfig({ networkPassphrase: "Some Unknown Net ; 2099" })),
    "custom",
  );
});

// ── explorerNetworkSegment ────────────────────────────────────────────────────

test("explorerNetworkSegment: mainnet → 'public'", () => {
  assert.equal(explorerNetworkSegment(makeConfig({ network: "mainnet" })), "public");
});

test("explorerNetworkSegment: testnet → 'testnet'", () => {
  assert.equal(explorerNetworkSegment(makeConfig({ network: "testnet" })), "testnet");
});

test("explorerNetworkSegment: futurenet → 'testnet' (no dedicated explorer segment)", () => {
  assert.equal(explorerNetworkSegment(makeConfig({ network: "futurenet" })), "testnet");
});

test("explorerNetworkSegment: custom → 'testnet' (safe fallback)", () => {
  assert.equal(explorerNetworkSegment(makeConfig({ network: "custom" })), "testnet");
});

// Backward-compat: no network field, falls back to passphrase
test("explorerNetworkSegment: no network field, mainnet passphrase → 'public'", () => {
  assert.equal(
    explorerNetworkSegment(makeConfig({ networkPassphrase: NETWORK_PASSPHRASES.mainnet })),
    "public",
  );
});

test("explorerNetworkSegment: no network field, testnet passphrase → 'testnet'", () => {
  assert.equal(
    explorerNetworkSegment(makeConfig({ networkPassphrase: NETWORK_PASSPHRASES.testnet })),
    "testnet",
  );
});

// ── Explorer URL helpers ──────────────────────────────────────────────────────

test("txExplorerUrl: mainnet produces /public/ segment", () => {
  const config = makeConfig({ network: "mainnet", networkPassphrase: NETWORK_PASSPHRASES.mainnet });
  assert.equal(txExplorerUrl(config, "abcd"), "https://stellar.expert/explorer/public/tx/abcd");
});

test("txExplorerUrl: futurenet falls back to /testnet/ segment", () => {
  const config = makeConfig({ network: "futurenet", networkPassphrase: NETWORK_PASSPHRASES.futurenet });
  assert.equal(txExplorerUrl(config, "abcd"), "https://stellar.expert/explorer/testnet/tx/abcd");
});

test("contractExplorerUrl: mainnet produces /public/ segment", () => {
  const config = makeConfig({ network: "mainnet", networkPassphrase: NETWORK_PASSPHRASES.mainnet });
  const url = contractExplorerUrl(config, VALID_MARKET);
  assert.equal(url, `https://stellar.expert/explorer/public/contract/${VALID_MARKET}`);
});

// ── STELLAR_NETWORK config loading ───────────────────────────────────────────

test("loadStellarConfig: STELLAR_NETWORK=testnet sets network field and correct defaults", () => {
  withEnv(
    {
      STELLAR_NETWORK: "testnet",
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.network, "testnet");
      assert.equal(config.rpcUrl, NETWORK_RPC_URLS.testnet);
      assert.equal(config.horizonUrl, NETWORK_HORIZON_URLS.testnet);
      assert.equal(config.networkPassphrase, NETWORK_PASSPHRASES.testnet);
      assert.equal(networkLabel(config), "testnet");
    },
  );
});

test("loadStellarConfig: STELLAR_NETWORK=mainnet sets mainnet defaults", () => {
  withEnv(
    {
      STELLAR_NETWORK: "mainnet",
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.network, "mainnet");
      assert.equal(config.rpcUrl, NETWORK_RPC_URLS.mainnet);
      assert.equal(config.horizonUrl, NETWORK_HORIZON_URLS.mainnet);
      assert.equal(config.networkPassphrase, NETWORK_PASSPHRASES.mainnet);
      assert.equal(networkLabel(config), "mainnet");
      assert.equal(explorerNetworkSegment(config), "public");
    },
  );
});

test("loadStellarConfig: STELLAR_NETWORK=futurenet sets futurenet defaults", () => {
  withEnv(
    {
      STELLAR_NETWORK: "futurenet",
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.network, "futurenet");
      assert.equal(config.rpcUrl, NETWORK_RPC_URLS.futurenet);
      assert.equal(config.networkPassphrase, NETWORK_PASSPHRASES.futurenet);
      assert.equal(networkLabel(config), "futurenet");
    },
  );
});

test("loadStellarConfig: explicit RPC URL overrides the network default", () => {
  withEnv(
    {
      STELLAR_NETWORK: "mainnet",
      STELLAR_RPC_URL: "https://my-rpc.example.com",
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.network, "mainnet");
      assert.equal(config.rpcUrl, "https://my-rpc.example.com");
      // passphrase still comes from the named network
      assert.equal(config.networkPassphrase, NETWORK_PASSPHRASES.mainnet);
    },
  );
});

test("loadStellarConfig: STELLAR_NETWORK=custom requires explicit RPC and passphrase to be useful", () => {
  withEnv(
    {
      STELLAR_NETWORK: "custom",
      STELLAR_RPC_URL: "https://my-private-rpc.example.com",
      STELLAR_NETWORK_PASSPHRASE: "My Private Net ; 2024",
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.network, "custom");
      assert.equal(config.rpcUrl, "https://my-private-rpc.example.com");
      assert.equal(config.networkPassphrase, "My Private Net ; 2024");
      assert.equal(networkLabel(config), "custom");
    },
  );
});

test("loadStellarConfig: unknown STELLAR_NETWORK value fails fast", () => {
  withEnv(
    {
      STELLAR_NETWORK: "devnet",
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
    },
    () => {
      assert.throws(
        () => loadStellarConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.match(err.message, /STELLAR_NETWORK must be one of/);
          assert.match(err.message, /devnet/);
          return true;
        },
      );
    },
  );
});

test("loadStellarConfig: no STELLAR_NETWORK defaults to testnet", () => {
  withEnv(
    {
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.network, "testnet");
      assert.equal(config.rpcUrl, NETWORK_RPC_URLS.testnet);
    },
  );
});
