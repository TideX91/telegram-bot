#!/usr/bin/env node
/**
 * Deterministic secret scanning for the Mimir Telegram notifier (issue #109).
 *
 * ── Why a tiny bespoke scanner ────────────────────────────────────────────────
 *
 * This bot's whole security story is "reads only, holds no signing keys": the
 * only secrets it could ever leak are a Telegram bot token, an `S…` secret
 * seed, a `PRIVATE KEY` PEM block, and the usual `apiKey=` / `Bearer …` /
 * `TOKEN="…"` shapes a scratch script picks up. A zero-dependency scanner
 * covers exactly those, runs on any runner with no download and no network,
 * and its patterns are pinned by `tests/secrets.test.mjs` — which is the
 * difference between "a linter ran" and "a checked property of this repo".
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 *
 *  - Exit 0: no findings. Stdout is one line, safe for a CI summary.
 *  - Exit 1: at least one finding. The report prints `file:line`, the pattern
 *    name, and a REDACTED context — never the secret itself — so the report
 *    can be pasted into an issue without leaking what it found.
 *  - Exit 2: the scanner could not run (unreadable file it was pointed at is
 *    skipped silently; exit 2 is reserved for a broken invocation).
 *
 * Scope: the working tree as `git ls-files --cached --others
 * --exclude-standard` sees it, so git-ignored files (`.env`, `data/`, `dist/`,
 * `node_modules/`) are never scanned and a real local token in `.env` cannot
 * turn every local run red. Untracked-but-not-ignored files ARE scanned, so a
 * secret sitting in a new scratch file is caught before it is ever staged.
 *
 * ── Safe rollback ────────────────────────────────────────────────────────────
 *
 * The scanner is additive only: it introduces no runtime behavior, no
 * configuration surface and no schema change, so reverting the single commit
 * that added it removes the workflow step and the script without touching the
 * bot, the poller, the cursor format or `.env.example`.
 */

import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * The signatures this repo actually cares about. Keep the list short: every
 * entry is pinned by a test, and a pattern nobody tests is a pattern nobody
 * can trust.
 */
export const PATTERNS = [
  {
    name: "telegram-bot-token",
    // Bot id, colon, base64url-ish secret part of 35+ chars — the real
    // BotFather shape, and nothing shorter looks like one.
    re: /\b\d{9,10}:[A-Za-z0-9_-]{35,}\b/g,
  },
  {
    name: "stellar-secret-seed",
    // Secret strkeys start with `S` and are 56 chars total. Public keys are
    // `G`, contracts `C`, so only an actual seed matches.
    re: /\bS[A-Z2-7]{55}\b/g,
  },
  {
    name: "private-key-block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "query-api-key",
    re: /[?&](api_?key|access_?token|auth_?token)=[^\s"'&<>]{8,}/gi,
  },
  {
    name: "bearer-token",
    // `Authorization: Bearer <token>`, `Authorization: <token>`, or a bare
    // `bearer=<token>` / `Bearer <token>` — the shapes a leaked header or a
    // pasted curl command actually take.
    re: /\b(?:authorization\s*[:=]\s*(?:bearer\s+)?|bearer\s*[:=]\s*|bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    name: "generic-assignment",
    // `BOT_TOKEN = "..."` style assignment to a suspiciously named variable,
    // including identifiers that merely END in a trigger word (BOT_TOKEN,
    // TELEGRAM_TOKEN, …) — the [^A-Za-z] bridge allows an underscore join.
    re: /(?:^|[^A-Za-z])(secret|password|token|api_key|apikey)[a-z_]*\s*[:=]\s*["'][^"']{12,}["']/gi,
  },
];

/** Never scanned, on top of whatever git reports as ignored. */
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "dist", "data", "coverage"]);

/** Scanning a lockfile only proves npm wrote a lockfile. */
const SKIP_FILES = new Set(["package-lock.json"]);

/** Read as text, line by line, so findings carry line numbers. */
const TEXT_SUFFIXES = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".txt",
  ".toml",
  ".html",
  ".css",
  ".example",
];

/** Hard cap so one accidental binary in the tree cannot stall CI. */
const MAX_BYTES_PER_FILE = 1_000_000;

/** Unredacted context characters shown around a redaction. */
const CONTEXT_CHARS = 16;

export function isScannable(relPath) {
  if (SKIP_FILES.has(relPath)) return false;
  if (relPath.split(path.sep).some((part) => SKIP_DIRS.has(part))) return false;
  const base = path.basename(relPath);
  // `.env.example` ships tracked placeholders; it is exactly the file a
  // careless edit turns into a real `.env`, so it is scanned on purpose.
  if (base === ".env.example" || base.startsWith(".env.")) return true;
  return TEXT_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

/**
 * Enough of the line to locate the finding, with the match itself replaced.
 * The preview is what CI prints, so it must not contain the secret.
 */
export function redactPreview(line, match) {
  const start = Math.max(0, match.index - CONTEXT_CHARS);
  const end = Math.min(line.length, match.index + match[0].length + CONTEXT_CHARS);
  const before = start > 0 ? "…" : "";
  const after = end < line.length ? "…" : "";
  return `${before}${line.slice(start, match.index)}[REDACTED]${line.slice(
    match.index + match[0].length,
    end,
  )}${after}`;
}

export function scanText(relPath, text) {
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        findings.push({
          file: relPath,
          line: i + 1,
          pattern: name,
          preview: redactPreview(line, m),
        });
        if (m[0].length === 0) re.lastIndex += 1; // zero-width guard
      }
    }
  }
  return findings;
}

async function listFiles(root) {
  // Git's own ignore rules decide the scope, so local ignores and CI agree.
  // Without git (e.g. a tarball checkout), fall back to a filtered walk.
  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root },
    );
    return stdout.split("\n").filter(Boolean);
  } catch {
    const walk = async (dir) => {
      const out = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".git")) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) out.push(...(await walk(abs)));
        } else {
          out.push(path.relative(root, abs).split(path.sep).join("/"));
        }
      }
      return out;
    };
    return walk(root);
  }
}

async function scanFile(root, relPath) {
  if (!isScannable(relPath)) return [];
  const abs = path.join(root, relPath);
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > MAX_BYTES_PER_FILE) return [];
  } catch {
    return []; // vanished between listing and reading; not a scan failure
  }
  try {
    const fh = await open(abs, "r");
    try {
      const text = await fh.readFile({ encoding: "utf8" });
      return scanText(relPath, text);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

export async function scanRepo(root = process.cwd()) {
  const files = await listFiles(root);
  const scannable = files.filter((f) => isScannable(f));
  const findings = [];
  for (const rel of scannable) {
    findings.push(...(await scanFile(root, rel)));
  }
  return { findings, scanned: scannable.length };
}

export function applyIgnores(findings, ignores = {}) {
  const files = new Set(ignores.files ?? []);
  const patterns = new Set(ignores.patterns ?? []);
  return findings.filter((f) => !files.has(f.file) && !patterns.has(f.pattern));
}

/** Human/CI report. Contains only redacted previews, by the test that pins it. */
export function formatReport(findings) {
  if (findings.length === 0) return "no secrets found";
  const perFile = new Map();
  for (const f of findings) {
    perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1);
  }
  const summary = [...perFile.entries()].map(([file, n]) => `${file} (${n})`).join(", ");
  return [
    `secret scan failed: ${findings.length} finding(s) in ${perFile.size} file(s) — ${summary}`,
    ...findings.map((f) => `  ${f.file}:${f.line}  [${f.pattern}]  ${f.preview}`),
    "",
    "Real finding? Rotate the secret first, then remove it from history.",
    "False positive? Narrow the pattern or extend the ignore options in scripts/scan-secrets.mjs.",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { files: [], patterns: [], help: false, extra: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ignore-file") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--ignore-file needs a path argument");
      parsed.files.push(value);
      i += 1;
    } else if (arg === "--ignore-pattern") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--ignore-pattern needs a pattern name");
      parsed.patterns.push(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      parsed.extra.push(arg);
    }
  }
  return parsed;
}

export const USAGE = `usage: node scripts/scan-secrets.mjs [--ignore-file <path>] [--ignore-pattern <name>]

Scans every tracked (and untracked-but-not-ignored) text file for secret-shaped
strings. Exits 0 when clean, 1 with a redacted report when not.`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.extra.length > 0) {
    console.error(`unknown arguments: ${args.extra.join(" ")}\n${USAGE}`);
    return 2;
  }

  const { findings, scanned } = await scanRepo();
  const remaining = applyIgnores(findings, { files: args.files, patterns: args.patterns });
  if (remaining.length > 0) {
    console.error(formatReport(remaining));
    return 1;
  }
  console.log(`secret scan ok — ${scanned} file(s) scanned, 0 findings`);
  return 0;
}

// Only when executed directly, not when imported by the tests.
const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`secret scan could not run: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    },
  );
}
