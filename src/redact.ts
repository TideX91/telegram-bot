/**
 * Shared redaction for operator-facing error text: logs, `/status`, and
 * `GET /health`.
 *
 * `audit.ts` already redacts the operator audit trail with a proven rule set
 * (`DEFAULT_REDACTION_RULES`) and clamps every detail. Error text that leaves
 * the process the other way — the lines an operator reads in `docker logs`, the
 * `lastError` in the status snapshot, the `poller.lastError` in the health JSON
 * — had a weaker story: only caller-supplied secrets and the Telegram bot token
 * shape were scrubbed. A seed strkey pasted into the wrong variable, or an RPC
 * endpoint carrying credentials in its userinfo, would have been printed
 * verbatim.
 *
 * This module closes that gap with the same shapes the audit trail uses, minus
 * the one rule that must not apply here: the audit trail replaces any ≥40-char
 * opaque token, which is right for a trail that is meant to be pasted into an
 * issue, but wrong for error text, where a transaction hash or a resume cursor
 * is the most useful part of the message. Everything else — the Telegram token,
 * secret strkeys, URL userinfo and credential-bearing query strings, and
 * `token=…`/`authorization: …` pairs — is scrubbed, and the result is length
 * bounded so a hostile endpoint cannot write an unbounded blob into a log line
 * or a health response.
 */

/** Placeholder, matching the wording the status/health surfaces already use. */
export const REDACTED = "[REDACTED]";

/**
 * Default cap for redacted error text. Matches `safeErrorMessage`'s historical
 * bound so this module is a drop-in for the callers that already rely on it.
 */
export const DEFAULT_MAX_LEN = 240;

/**
 * Values registered at runtime (config secrets) in addition to the shape rules.
 *
 * Boot registers the bot token and the chat id here so a new call site cannot
 * leak them by forgetting to pass a `secrets` argument: the registration is
 * process-wide, and `format.ts` consults it on every call.
 */
const registered = new Set<string>();

/**
 * Register a value that must never appear in operator-facing text. Values
 * shorter than 4 characters are ignored: they would match inside ordinary words
 * and redact the whole message into noise.
 */
export function registerSecret(value: string): void {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length >= 4) registered.add(trimmed);
}

/** Register several secrets at once (boot config). */
export function registerSecrets(values: Iterable<string>): void {
  for (const value of values) registerSecret(value);
}

/** Registered secrets, longest first, so a substring never wins over its host. */
export function registeredSecrets(): string[] {
  return [...registered].sort((a, b) => b.length - a.length);
}

/** Test helper — clears the registry between cases. */
export function clearSecrets(): void {
  registered.clear();
}

/**
 * One redaction rule: a pattern and its replacement. A function replacement
 * decides per match, which is how public chain identifiers survive.
 */
export interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

interface FnRedactionRule {
  pattern: RegExp;
  replacement: (match: string) => string;
}

/** Credentials in a URL's userinfo: `https://user:pass@rpc.example`. */
const URL_USERINFO: RedactionRule = {
  pattern: /(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
  replacement: `$1${REDACTED}@`,
};

/** Credentials in a query string, which error text routinely echoes whole. */
const URL_QUERY_CREDENTIAL: RedactionRule = {
  pattern: /([?&](?:token|api[_-]?key|key|secret|password|auth)=)[^&\s]+/gi,
  replacement: `$1${REDACTED}`,
};

/**
 * Shape-based rules, in order. Every replacement is `[REDACTED]` (or names the
 * thing it hid) so one convention covers the log, `/status`, and `/health`.
 *
 * Order matters: the bot token is removed before the URL rules, because a token
 * inside `api.telegram.org/bot<token>/…` would otherwise be replaced twice and
 * lose the fact that a token was involved at all.
 */
export const ERROR_REDACTION_RULES: readonly (RedactionRule | FnRedactionRule)[] = [
  // Telegram bot tokens: `bot123456:AA…` (in a URL) and the bare `123456:AA…`.
  // The lookarounds are main's, and they are not interchangeable with `\b`: a
  // token that ends in URL punctuation (`…-`, `…_`) must be redacted whole, and
  // `\b` would back-track off the trailing `-` because it is not a word
  // character. `tests/bot.test.mjs` pins exactly that case.
  { pattern: /\bbot\d{6,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, replacement: REDACTED },
  {
    pattern: /(?<![A-Za-z0-9_-])\d{6,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  // The 56-char ed25519 seed strkey, the same shape `audit.ts` scrubs. Public
  // `G…` account and `C…` contract ids are chain identifiers the bot prints on
  // purpose, so they are deliberately not matched.
  { pattern: /\bS[A-Z2-7]{55}\b/g, replacement: REDACTED },
  URL_USERINFO,
  URL_QUERY_CREDENTIAL,
  // Bearer / Authorization echoes.
  { pattern: /\bBearer\s+[A-Za-z0-9._+/=-]{8,}/gi, replacement: `Bearer ${REDACTED}` },
  // `TOKEN=…`, `Authorization: …`, `TELEGRAM_BOT_TOKEN=…` style key/value dumps.
  // The name may carry a prefix, which is exactly how the env names arrive in a
  // config error. The value must be at least 8 opaque characters, so the
  // actionable `token: unset` stays readable.
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:token|secret|password|authorization)[A-Za-z0-9_]*)\s*[:=]\s*\S{8,}/gi,
    replacement: `$1=${REDACTED}`,
  },
];

/**
 * Hide credentials in a URL while keeping the endpoint readable: an operator
 * needs to see *which* RPC refused them, not the password that was refused.
 * Only the URL rules apply, so a URL in a boot line is never replaced wholesale.
 */
export function redactUrl(url: string): string {
  return url.replace(URL_USERINFO.pattern, URL_USERINFO.replacement)
    .replace(URL_QUERY_CREDENTIAL.pattern, URL_QUERY_CREDENTIAL.replacement);
}

/**
 * Clamp after redaction so no single message can dominate a log or a response.
 * Private: `status.ts` already owns the exported `boundText` for snapshots, and
 * two public helpers with one name would be a trap at the import site.
 */
function clamp(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 1))}…`;
}

export interface RedactOptions {
  /** Extra secrets known only to this call site (config values, fixture ids). */
  secrets?: readonly string[];
  /** Hard cap on the returned length. */
  maxLen?: number;
}

/**
 * Replace registered/known secrets and credential-shaped substrings.
 *
 * Registered and caller-supplied secrets go first, because a secret can be any
 * shape at all; the patterns then catch the cases where no value was ever
 * registered (a hand-pasted token in a test, a seed key in an upstream error).
 */
export function redactText(input: string, options: RedactOptions = {}): string {
  if (!input) return "";
  let out = input;

  const known = [...registeredSecrets(), ...(options.secrets ?? [])]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }

  for (const rule of ERROR_REDACTION_RULES) {
    out = typeof rule.replacement === "string"
      ? out.replace(rule.pattern, rule.replacement)
      : out.replace(rule.pattern, rule.replacement);
  }

  return clamp(out, options.maxLen);
}

/** Redacted, bounded text for anything thrown at us. */
export function redactError(err: unknown, options: RedactOptions = {}): string {
  let raw: string;
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    raw = `${name}${err.message}`;
  } else if (typeof err === "string") {
    raw = err;
  } else if (err === null || err === undefined) {
    raw = String(err);
  } else {
    try {
      const json = JSON.stringify(err);
      raw = typeof json === "string" ? json : String(err);
    } catch {
      raw = String(err);
    }
  }
  return redactText(raw, options);
}
