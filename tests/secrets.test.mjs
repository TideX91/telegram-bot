import assert from "node:assert/strict";
import test from "node:test";

import {
  applyIgnores,
  formatReport,
  isScannable,
  redactPreview,
  scanRepo,
  scanText,
} from "../scripts/scan-secrets.mjs";

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Deterministic lookalikes assembled at runtime so this file itself contains
// no secret-shaped literal and scans clean (pinned by the regression test).

const FAKE_BOT_TOKEN = ["123456789:AA", "x".repeat(33)].join("");
const FAKE_SEED = ["S", "A".repeat(55)].join("");
const FAKE_PUBLIC_KEY = ["G", "A".repeat(55)].join("");
const FAKE_CONTRACT_ID = ["C", "A".repeat(55)].join("");
const HEX16 = "abcdef1234567890";
const HEX20 = "fedcba0987654321ab12";

function fakeMatch(line, index, text) {
  return { 0: text, index, input: line, length: 1 };
}

// ── Positive: every pattern fires on its real shape ──────────────────────────

test("telegram-bot-token pattern matches the BotFather shape", () => {
  const findings = scanText("x.ts", `const t = "${FAKE_BOT_TOKEN}";`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "telegram-bot-token");
  assert.equal(findings[0].line, 1);
});

test("stellar-secret-seed matches an S-strkey but not G/C strkeys", () => {
  assert.equal(scanText("x.ts", FAKE_SEED).length, 1);
  assert.equal(scanText("x.ts", FAKE_PUBLIC_KEY).length, 0);
  assert.equal(scanText("x.ts", FAKE_CONTRACT_ID).length, 0);
});

test("private-key-block matches PEM headers", () => {
  const findings = scanText("x.md", ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "private-key-block");
});

test("query-api-key matches apikey/access_token/auth_token query params", () => {
  for (const param of ["api_key", "apiKey", "access_token", "auth_token"]) {
    const url = ["https://api.example.com/v1?", param, "=", HEX16].join("");
    const findings = scanText("x.ts", `"${url}"`);
    assert.equal(findings.length, 1, url);
    assert.equal(findings[0].pattern, "query-api-key");
  }
});

test("bearer-token matches Authorization headers and Bearer schemes", () => {
  const cases = [
    `headers["Authorization"] = "Bearer ${HEX20}";`,
    "curl -H 'authorization: Bearer " + HEX20 + "'",
    "curl -H 'Authorization: " + HEX20 + "'",
    "btoa(`bearer=" + HEX20 + "`)",
  ];
  for (const line of cases) {
    const findings = scanText("x.ts", line);
    assert.equal(findings.length, 1, line);
    assert.equal(findings[0].pattern, "bearer-token");
  }
});

test("generic-assignment matches trigger-named assignments", () => {
  const cases = [
    `const BOT_TOKEN = "${HEX20}";`,
    `let password = "${HEX20}";`,
    `api_key: "${HEX20}"`,
    `config.secretKey = "${HEX20}";`,
  ];
  for (const line of cases) {
    const findings = scanText("x.ts", line);
    assert.equal(findings.length, 1, line);
    assert.equal(findings[0].pattern, "generic-assignment");
  }
});

test("token-named variable holding non-secret data is NOT flagged", () => {
  // The value contains trigger words, not the assignment name; and short
  // values stay under the 12-char quoted-literal boundary.
  assert.deepEqual(scanText("x.ts", `const KIND = "token";`), []);
  assert.deepEqual(scanText("x.ts", `const topic = "user:tokens:v2";`), []);
});

// ── Negative: nothing fires on clean, ordinary content ───────────────────────

test("clean source text produces no findings", () => {
  const clean = [
    "import { config } from \"./config.js\";",
    "export function poll(): void {}",
    "const usdc = 20_000_000n;",
    "// ledger 4226691",
    "TELEGRAM_CHAT_ID=-1001234567890",
  ].join("\n");
  assert.deepEqual(scanText("clean.ts", clean), []);
});

test("public and contract strkeys, short ids and numbers are not secrets", () => {
  const text = [
    FAKE_PUBLIC_KEY,
    FAKE_CONTRACT_ID,
    "https://horizon-testnet.stellar.org/transactions/abc",
    "const ledger = 4226691;",
  ].join("\n");
  assert.deepEqual(scanText("keys.ts", text), []);
});

test("git-ignored real-token files are out of scope", () => {
  // .env is ignored by git (see .gitignore), so scanRepo never reads it — a
  // real local token cannot turn every CI/local run red.
  assert.equal(isScannable(".env"), false);
  assert.equal(isScannable("data/cursor.json"), false);
  assert.equal(isScannable("node_modules/x/index.js"), false);
  assert.equal(isScannable("dist/bot.js"), false);
  assert.equal(isScannable("package-lock.json"), false);
});

test(".env.example IS scanned but its placeholders are clean", async () => {
  assert.equal(isScannable(".env.example"), true);
  const { findings } = await scanRepo(process.cwd());
  const envFindings = findings.filter((f) => f.file === ".env.example");
  assert.deepEqual(envFindings, []);
});

test("the repo itself scans clean (regression guard)", async () => {
  const { findings, scanned } = await scanRepo(process.cwd());
  assert.ok(scanned >= 10, `expected a real scan, got ${scanned} file(s)`);
  assert.deepEqual(findings, []);
});

// ── Boundary: pattern edges ──────────────────────────────────────────────────

test("34-char secret part is under the token boundary, 35+ matches", () => {
  const short = ["123456789:AA", "x".repeat(32)].join(""); // 34 after colon
  const long = ["123456789:AA", "x".repeat(33)].join(""); // 35 after colon
  assert.deepEqual(scanText("x.ts", short), []);
  assert.equal(scanText("x.ts", long).length, 1);
});

test("55-char S-prefix body is under the seed boundary, 56 matches", () => {
  assert.deepEqual(scanText("x.ts", ["S", "A".repeat(54)].join("")), []);
  assert.equal(scanText("x.ts", FAKE_SEED).length, 1);
});

test("findings report the line they were found on", () => {
  const text = ["clean", "still clean", `token "${FAKE_BOT_TOKEN}" here`].join("\n");
  const findings = scanText("x.ts", text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
});

test("every match on one line is reported", () => {
  const findings = scanText("x.ts", `${FAKE_BOT_TOKEN} ${FAKE_SEED}`);
  assert.equal(findings.length, 2);
});

// ── Redaction: reports never contain the secret ──────────────────────────────

test("redactPreview replaces the match with [REDACTED]", () => {
  const trigger = ["to", "ken"].join(""); // avoids a self-tripping literal
  const line = `const ${trigger} = "${FAKE_BOT_TOKEN}";`;
  const preview = redactPreview(line, fakeMatch(line, 14, FAKE_BOT_TOKEN));
  assert.ok(preview.includes("[REDACTED]"));
  assert.ok(!preview.includes(FAKE_BOT_TOKEN));
});

test("redactPreview keeps bounded context and ellipses", () => {
  const long = "a".repeat(60) + FAKE_BOT_TOKEN + "b".repeat(60);
  const preview = redactPreview(long, fakeMatch(long, 60, FAKE_BOT_TOKEN));
  assert.ok(preview.startsWith("…"));
  assert.ok(preview.endsWith("…"));
  assert.ok(preview.length < 80);
  assert.ok(!preview.includes(FAKE_BOT_TOKEN));
});

test("formatReport never leaks the secret and lists file:line", () => {
  const trigger = ["to", "ken"].join("");
  const findings = scanText("src/leaky.ts", `${trigger} = "${FAKE_BOT_TOKEN}"`);
  const report = formatReport(findings);
  assert.ok(report.includes("src/leaky.ts:1"));
  assert.ok(report.includes("[telegram-bot-token]"));
  assert.ok(!report.includes(FAKE_BOT_TOKEN));
});

test("formatReport with no findings is a one-liner", () => {
  assert.equal(formatReport([]), "no secrets found");
});

// ── Ignores and CLI contract ─────────────────────────────────────────────────

test("applyIgnores drops ignored files and patterns", () => {
  const findings = [
    { file: "fixture.ts", line: 1, pattern: "bearer-token", preview: "[REDACTED]" },
    { file: "real.ts", line: 2, pattern: "stellar-secret-seed", preview: "[REDACTED]" },
  ];
  assert.deepEqual(applyIgnores(findings, { files: ["fixture.ts"] }), [findings[1]]);
  assert.deepEqual(applyIgnores(findings, { patterns: ["stellar-secret-seed"] }), [findings[0]]);
  assert.deepEqual(
    applyIgnores(findings, { files: ["fixture.ts"], patterns: ["stellar-secret-seed"] }),
    [],
  );
  assert.deepEqual(applyIgnores(findings, {}), findings);
});

test("multi-line text scans line by line with no cross-line bleed", () => {
  // A seed split across two lines must not match; the whole pattern must
  // never swallow a second finding on the same line.
  const split = ["SAAAA", "A".repeat(55)].join("\n");
  assert.deepEqual(scanText("x.ts", split), []);
});

test("scanner is deterministic: same input, same findings", () => {
  const text = ["a", FAKE_BOT_TOKEN, `c ${FAKE_SEED}`].join("\n");
  assert.deepEqual(scanText("x.ts", text), scanText("x.ts", text));
});
