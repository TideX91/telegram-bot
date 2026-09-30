import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  configProvenance,
  formatProvenanceSummary,
  loadStellarConfig,
  networkLabel,
} from "../dist/config.js";

const CONTRACTS = {
  MARKET_CONTRACT_ID: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  SQUAD_CONTRACT_ID: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
};

const BOT_CREDS = {
  BOT_TOKEN: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
  TELEGRAM_CHAT_ID: "-1001234567890",
};

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const MAINNET_RPC = "https://soroban-rpc.stellar.org";

/** Run `fn` with a clean env so a developer's `.env` cannot change the result. */
function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, CONTRACTS, BOT_CREDS, overrides);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

/** Same as `withEnv` but omits the Telegram credentials (chain-only). */
function withChainOnlyEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, CONTRACTS, overrides);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

/* ── Well-known named networks ──────────────────────────────────────────── */

test("defaults to the testnet named network when no env override is set", () => {
  const stellar = withEnv({}, () => loadStellarConfig());
  assert.equal(stellar.networkPassphrase, TESTNET_PASSPHRASE);
  assert.equal(stellar.rpcUrl, TESTNET_RPC);
  assert.equal(networkLabel(stellar), "testnet");
});

test("STELLAR_NETWORK_PASSPHRASE=public resolves to the public named network", () => {
  const stellar = withEnv(
    { STELLAR_NETWORK_PASSPHRASE: PUBLIC_PASSPHRASE, STELLAR_RPC_URL: MAINNET_RPC },
    () => loadStellarConfig(),
  );
  assert.equal(stellar.networkPassphrase, PUBLIC_PASSPHRASE);
  assert.equal(stellar.rpcUrl, MAINNET_RPC);
  assert.equal(networkLabel(stellar), "public");
});

test("an unrecognised passphrase is labelled 'custom', not rejected", () => {
  const stellar = withEnv(
    { STELLAR_NETWORK_PASSPHRASE: "Standalone Network ; February 2017" },
    () => loadStellarConfig(),
  );
  assert.equal(networkLabel(stellar), "custom");
});

test("explicit STELLAR_RPC_URL wins over the built-in testnet default", () => {
  const stellar = withEnv(
    { STELLAR_RPC_URL: "https://custom-rpc.example" },
    () => loadStellarConfig(),
  );
  assert.equal(stellar.rpcUrl, "https://custom-rpc.example");
  // Passphrase still defaults to testnet.
  assert.equal(networkLabel(stellar), "testnet");
});

/* ── Precedence: environment beats profile ──────────────────────────────── */

test("MIMIR_PROFILE=mock selects the mock network and loopback RPC", () => {
  const stellar = withEnv({ MIMIR_PROFILE: "mock" }, () => loadStellarConfig());
  assert.equal(networkLabel(stellar), "mock");
  assert.match(stellar.rpcUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("explicit env vars beat the mock profile's defaults", () => {
  const stellar = withEnv(
    {
      MIMIR_PROFILE: "mock",
      STELLAR_RPC_URL: "https://explicit.example",
      STELLAR_NETWORK_PASSPHRASE: PUBLIC_PASSPHRASE,
    },
    () => loadStellarConfig(),
  );
  assert.equal(stellar.rpcUrl, "https://explicit.example");
  assert.equal(networkLabel(stellar), "public");
});

/* ── Unknown profile fails boot ─────────────────────────────────────────── */

test("an unknown MIMIR_PROFILE fails fast with an actionable message", () => {
  assert.throws(
    () => withEnv({ MIMIR_PROFILE: "staging" }, () => loadStellarConfig()),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /MIMIR_PROFILE/);
      assert.match(err.message, /staging/);
      return true;
    },
  );
});

/* ── Boundary: blank passphrase treated as unset ────────────────────────── */

test("a blank STELLAR_NETWORK_PASSPHRASE falls back to the built-in default", () => {
  for (const blank of ["", "   "]) {
    const stellar = withEnv(
      { STELLAR_NETWORK_PASSPHRASE: blank },
      () => loadStellarConfig(),
    );
    assert.equal(
      stellar.networkPassphrase,
      TESTNET_PASSPHRASE,
      `STELLAR_NETWORK_PASSPHRASE=${JSON.stringify(blank)} must fall back to the default`,
    );
  }
});

/* ── Restart safety: same env, same result ──────────────────────────────── */

test("two consecutive loads with the same env resolve identically", () => {
  const env = { STELLAR_NETWORK_PASSPHRASE: PUBLIC_PASSPHRASE, STELLAR_RPC_URL: MAINNET_RPC };
  const first = withEnv(env, () => loadStellarConfig());
  const second = withEnv(env, () => loadStellarConfig());
  assert.deepEqual(first, second);
});

/* ── Provenance never leaks secrets ────────────────────────────────────── */

test("configProvenance output never contains the bot token value", () => {
  const token = "9999999999:SHOULD-NEVER-APPEAR-ANYWHERE";
  withEnv({ MIMIR_PROFILE: "mock", BOT_TOKEN: token }, () => {
    const prov = configProvenance();
    const summary = formatProvenanceSummary(prov);
    const serialized = JSON.stringify(prov);
    assert.doesNotMatch(summary, new RegExp(token));
    assert.doesNotMatch(serialized, new RegExp(token));
  });
});

test("configProvenance reports the mock profile and flags profile-supplied settings", () => {
  withEnv({ MIMIR_PROFILE: "mock" }, () => {
    const prov = configProvenance();
    assert.equal(prov.profile, "mock");
    assert.ok(prov.counts["profile-default"] > 0);
    assert.ok(prov.warnings.some((w) => /mock profile/.test(w)));
  });
});

/* ── Chain-only config never requires Telegram credentials ─────────────── */

test("loadStellarConfig succeeds without any Telegram credentials", () => {
  const stellar = withChainOnlyEnv({}, () => loadStellarConfig());
  assert.equal(stellar.marketContractId, CONTRACTS.MARKET_CONTRACT_ID);
  assert.equal(stellar.squadContractId, CONTRACTS.SQUAD_CONTRACT_ID);
});

/* ── Negative: malformed RPC URL fails boot ─────────────────────────────── */

test("a malformed STELLAR_RPC_URL fails boot instead of silently defaulting", () => {
  assert.throws(
    () => withEnv({ STELLAR_RPC_URL: "not-a-url" }, () => loadStellarConfig()),
    ConfigError,
  );
});