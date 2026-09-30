/**
 * Config validation unit tests.
 *
 * Tests the loadConfig / loadStellarConfig fail-fast behaviour, including
 * the new INTER_SEND_DELAY_MS env var and boundary conditions.
 * No live network calls or real credentials needed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig, loadStellarConfig, networkLabel } from "../dist/config.js";

// Valid minimal env for a full bot config.
const VALID_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4";

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function validBotEnv(overrides = {}) {
  return {
    BOT_TOKEN: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: VALID_CONTRACT_A,
    SQUAD_CONTRACT_ID: VALID_CONTRACT_B,
    // Clear any values from the test environment that could interfere.
    POLL_INTERVAL_MS: undefined,
    START_LOOKBACK_LEDGERS: undefined,
    CURSOR_FILE: undefined,
    MAX_NOTIFICATIONS_PER_CYCLE: undefined,
    INTER_SEND_DELAY_MS: undefined,
    STELLAR_RPC_URL: undefined,
    STELLAR_HORIZON_URL: undefined,
    STELLAR_NETWORK_PASSPHRASE: undefined,
    ...overrides,
  };
}

// ── Required fields ───────────────────────────────────────────────────────────

test("loadConfig: throws ConfigError when BOT_TOKEN is missing", () => {
  withEnv(validBotEnv({ BOT_TOKEN: undefined }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.some((p) => p.includes("BOT_TOKEN")));
      return true;
    });
  });
});

test("loadConfig: throws ConfigError when TELEGRAM_CHAT_ID is missing", () => {
  withEnv(validBotEnv({ TELEGRAM_CHAT_ID: undefined }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.some((p) => p.includes("TELEGRAM_CHAT_ID")));
      return true;
    });
  });
});

test("loadConfig: throws ConfigError when MARKET_CONTRACT_ID is malformed", () => {
  withEnv(validBotEnv({ MARKET_CONTRACT_ID: "not-a-contract-id" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.some((p) => p.includes("MARKET_CONTRACT_ID")));
      return true;
    });
  });
});

test("loadConfig: collects ALL problems in one error", () => {
  withEnv(
    validBotEnv({
      BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
      MARKET_CONTRACT_ID: "bad",
    }),
    () => {
      assert.throws(() => loadConfig(), (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.problems.length >= 3, `Expected >= 3 problems, got ${err.problems.length}`);
        return true;
      });
    },
  );
});

// ── INTER_SEND_DELAY_MS ───────────────────────────────────────────────────────

test("loadConfig: INTER_SEND_DELAY_MS defaults to 1500", () => {
  withEnv(validBotEnv(), () => {
    const config = loadConfig();
    assert.equal(config.interSendDelayMs, 1500);
  });
});

test("loadConfig: INTER_SEND_DELAY_MS=0 is accepted (min is 0)", () => {
  withEnv(validBotEnv({ INTER_SEND_DELAY_MS: "0" }), () => {
    const config = loadConfig();
    assert.equal(config.interSendDelayMs, 0);
  });
});

test("loadConfig: INTER_SEND_DELAY_MS=500 is loaded correctly", () => {
  withEnv(validBotEnv({ INTER_SEND_DELAY_MS: "500" }), () => {
    const config = loadConfig();
    assert.equal(config.interSendDelayMs, 500);
  });
});

test("loadConfig: INTER_SEND_DELAY_MS with non-integer value is rejected", () => {
  withEnv(validBotEnv({ INTER_SEND_DELAY_MS: "1.5" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("INTER_SEND_DELAY_MS")),
        `Expected problem about INTER_SEND_DELAY_MS; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
});

test("loadConfig: INTER_SEND_DELAY_MS with negative value is rejected", () => {
  withEnv(validBotEnv({ INTER_SEND_DELAY_MS: "-1" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("INTER_SEND_DELAY_MS")),
        `Expected problem about INTER_SEND_DELAY_MS; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
});

// ── MAX_NOTIFICATIONS_PER_CYCLE ───────────────────────────────────────────────

test("loadConfig: MAX_NOTIFICATIONS_PER_CYCLE defaults to 20", () => {
  withEnv(validBotEnv(), () => {
    const config = loadConfig();
    assert.equal(config.maxNotificationsPerCycle, 20);
  });
});

test("loadConfig: MAX_NOTIFICATIONS_PER_CYCLE=1 is accepted (min is 1)", () => {
  withEnv(validBotEnv({ MAX_NOTIFICATIONS_PER_CYCLE: "1" }), () => {
    const config = loadConfig();
    assert.equal(config.maxNotificationsPerCycle, 1);
  });
});

test("loadConfig: MAX_NOTIFICATIONS_PER_CYCLE=0 is rejected (min is 1)", () => {
  withEnv(validBotEnv({ MAX_NOTIFICATIONS_PER_CYCLE: "0" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.some((p) => p.includes("MAX_NOTIFICATIONS_PER_CYCLE")));
      return true;
    });
  });
});

// ── POLL_INTERVAL_MS ──────────────────────────────────────────────────────────

test("loadConfig: POLL_INTERVAL_MS below 5000 is rejected", () => {
  withEnv(validBotEnv({ POLL_INTERVAL_MS: "4999" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.some((p) => p.includes("POLL_INTERVAL_MS")));
      return true;
    });
  });
});

test("loadConfig: POLL_INTERVAL_MS=5000 is accepted", () => {
  withEnv(validBotEnv({ POLL_INTERVAL_MS: "5000" }), () => {
    const config = loadConfig();
    assert.equal(config.pollIntervalMs, 5000);
  });
});

// ── Chat ID ───────────────────────────────────────────────────────────────────

test("loadConfig: numeric negative chat id is accepted", () => {
  withEnv(validBotEnv({ TELEGRAM_CHAT_ID: "-1001234567890" }), () => {
    const config = loadConfig();
    assert.equal(config.chatId, "-1001234567890");
  });
});

test("loadConfig: @channelusername is accepted", () => {
  withEnv(validBotEnv({ TELEGRAM_CHAT_ID: "@mychannelname" }), () => {
    const config = loadConfig();
    assert.equal(config.chatId, "@mychannelname");
  });
});

test("loadConfig: invalid chat id format is rejected", () => {
  withEnv(validBotEnv({ TELEGRAM_CHAT_ID: "not-valid" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems.some((p) => p.includes("TELEGRAM_CHAT_ID")));
      return true;
    });
  });
});

// ── networkLabel ──────────────────────────────────────────────────────────────

test("networkLabel: returns testnet for the Testnet passphrase", () => {
  const config = {
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    marketContractId: VALID_CONTRACT_A,
    squadContractId: VALID_CONTRACT_B,
  };
  assert.equal(networkLabel(config), "testnet");
});

test("networkLabel: returns public for the Mainnet passphrase", () => {
  const config = {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    marketContractId: VALID_CONTRACT_A,
    squadContractId: VALID_CONTRACT_B,
  };
  assert.equal(networkLabel(config), "public");
});

test("networkLabel: returns custom for an unknown passphrase", () => {
  const config = {
    networkPassphrase: "My Custom Network ; 2025",
    rpcUrl: "http://localhost:8000",
    horizonUrl: "http://localhost:8000",
    marketContractId: VALID_CONTRACT_A,
    squadContractId: VALID_CONTRACT_B,
  };
  assert.equal(networkLabel(config), "custom");
});

// ── loadStellarConfig ─────────────────────────────────────────────────────────

test("loadStellarConfig: succeeds without BOT_TOKEN or TELEGRAM_CHAT_ID", () => {
  withEnv(
    {
      MARKET_CONTRACT_ID: VALID_CONTRACT_A,
      SQUAD_CONTRACT_ID: VALID_CONTRACT_B,
      BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
      STELLAR_RPC_URL: undefined,
      STELLAR_HORIZON_URL: undefined,
      STELLAR_NETWORK_PASSPHRASE: undefined,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.marketContractId, VALID_CONTRACT_A);
      assert.equal(config.squadContractId, VALID_CONTRACT_B);
    },
  );
});

// ── ConfigError ───────────────────────────────────────────────────────────────

test("ConfigError: message lists all problems and includes copy hint", () => {
  const err = new ConfigError(["problem one", "problem two"]);
  assert.match(err.message, /problem one/);
  assert.match(err.message, /problem two/);
  assert.match(err.message, /\.env/);
  assert.equal(err.name, "ConfigError");
  assert.deepEqual(err.problems, ["problem one", "problem two"]);
});

// ── METRICS_PORT ──────────────────────────────────────────────────────────────

test("loadConfig: METRICS_PORT absent defaults to null (server disabled)", () => {
  withEnv(validBotEnv({ METRICS_PORT: undefined }), () => {
    const config = loadConfig();
    assert.equal(config.metricsPort, null);
  });
});

test("loadConfig: METRICS_PORT empty string defaults to null (server disabled)", () => {
  withEnv(validBotEnv({ METRICS_PORT: "" }), () => {
    const config = loadConfig();
    assert.equal(config.metricsPort, null);
  });
});

test("loadConfig: METRICS_PORT=9090 is accepted and parsed as a number", () => {
  withEnv(validBotEnv({ METRICS_PORT: "9090" }), () => {
    const config = loadConfig();
    assert.equal(config.metricsPort, 9090);
  });
});

test("loadConfig: METRICS_PORT=1 is accepted (minimum valid port)", () => {
  withEnv(validBotEnv({ METRICS_PORT: "1" }), () => {
    const config = loadConfig();
    assert.equal(config.metricsPort, 1);
  });
});

test("loadConfig: METRICS_PORT=65535 is accepted (maximum valid port)", () => {
  withEnv(validBotEnv({ METRICS_PORT: "65535" }), () => {
    const config = loadConfig();
    assert.equal(config.metricsPort, 65535);
  });
});

test("loadConfig: METRICS_PORT=0 is rejected (below minimum)", () => {
  withEnv(validBotEnv({ METRICS_PORT: "0" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("METRICS_PORT")),
        `Expected METRICS_PORT problem; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
});

test("loadConfig: METRICS_PORT=65536 is rejected (above maximum)", () => {
  withEnv(validBotEnv({ METRICS_PORT: "65536" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("METRICS_PORT")),
        `Expected METRICS_PORT problem; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
});

test("loadConfig: METRICS_PORT=-1 is rejected (negative)", () => {
  withEnv(validBotEnv({ METRICS_PORT: "-1" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("METRICS_PORT")),
        `Expected METRICS_PORT problem; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
});

test("loadConfig: METRICS_PORT=9090.5 is rejected (non-integer)", () => {
  withEnv(validBotEnv({ METRICS_PORT: "9090.5" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("METRICS_PORT")),
        `Expected METRICS_PORT problem; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
});

test("loadConfig: METRICS_PORT=notanumber is rejected", () => {
  withEnv(validBotEnv({ METRICS_PORT: "notanumber" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("METRICS_PORT")),
        `Expected METRICS_PORT problem; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
});

test("loadConfig: METRICS_PORT problem is collected alongside other problems", () => {
  // METRICS_PORT=0 is invalid AND BOT_TOKEN is missing — both should appear.
  withEnv(validBotEnv({ BOT_TOKEN: undefined, METRICS_PORT: "0" }), () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        err.problems.some((p) => p.includes("BOT_TOKEN")),
        `Expected BOT_TOKEN problem; got: ${JSON.stringify(err.problems)}`,
      );
      assert.ok(
        err.problems.some((p) => p.includes("METRICS_PORT")),
        `Expected METRICS_PORT problem; got: ${JSON.stringify(err.problems)}`,
      );
      return true;
    });
  });
import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  loadConfig,
} from "../dist/config.js";

const REQUIRED = {
  MARKET_CONTRACT_ID: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  SQUAD_CONTRACT_ID: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
  BOT_TOKEN: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
  TELEGRAM_CHAT_ID: "-1001234567890",
};

/** Run `fn` with a clean env so a developer's `.env` cannot change the result. */
function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, REQUIRED, overrides);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

test("SHUTDOWN_TIMEOUT_MS defaults to the documented drain budget", () => {
  const config = withEnv({}, () => loadConfig());
  assert.equal(config.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
  assert.equal(config.shutdownTimeoutMs, 10_000);
});

test("SHUTDOWN_TIMEOUT_MS accepts an explicit budget and the 0 opt-out", () => {
  assert.equal(withEnv({ SHUTDOWN_TIMEOUT_MS: "250" }, () => loadConfig()).shutdownTimeoutMs, 250);
  assert.equal(withEnv({ SHUTDOWN_TIMEOUT_MS: "0" }, () => loadConfig()).shutdownTimeoutMs, 0);
});

test("SHUTDOWN_TIMEOUT_MS falls back to the default when set to nothing", () => {
  const config = withEnv({ SHUTDOWN_TIMEOUT_MS: "  " }, () => loadConfig());
  assert.equal(config.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
});

test("SHUTDOWN_TIMEOUT_MS rejects negative and non-numeric budgets at boot", () => {
  for (const value of ["-1", "2.5", "soon"]) {
    assert.throws(
      () => withEnv({ SHUTDOWN_TIMEOUT_MS: value }, () => loadConfig()),
      ConfigError,
      `SHUTDOWN_TIMEOUT_MS=${JSON.stringify(value)} must not boot`,
    );
  }
});

// Health-port resolution: Railway injects `PORT` and probes it for the deploy
// healthcheck, so the health endpoint falls back to it when `HEALTH_PORT` is
// unset — without changing the loopback default where `PORT` does not exist.
function healthPortWith(patch) {
  return withEnv(patch, () => loadConfig().healthPort);
}

test("explicit HEALTH_PORT wins over an injected PORT", () => {
  assert.equal(healthPortWith({ HEALTH_PORT: "9999", PORT: "8888" }), 9999);
});

test("falls back to the injected PORT when HEALTH_PORT is unset", () => {
  assert.equal(healthPortWith({ PORT: "8080" }), 8080);
});

test("keeps the loopback default when neither HEALTH_PORT nor PORT is set", () => {
  assert.equal(healthPortWith({}), 8787);
});

test("ignores a non-numeric injected PORT", () => {
  assert.equal(healthPortWith({ PORT: "not-a-port" }), 8787);
});

test("ignores a zero injected PORT (Railway disables it in some plans)", () => {
  assert.equal(healthPortWith({ PORT: "0" }), 8787);
});

test("HEALTH_PORT=0 still disables the listener on a platform with PORT", () => {
  assert.equal(healthPortWith({ HEALTH_PORT: "0", PORT: "8443" }), 0);
});
