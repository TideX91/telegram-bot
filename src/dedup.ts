/**
 * Bounded, deterministic event deduplication for the poller.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Soroban `getEvents` addresses pages by an opaque cursor, and that cursor is
 * INCLUSIVE of the event it names. The same event can therefore come back from
 * a later page (overlapping pages), and again from the next cycle that resumes
 * from the persisted cursor — including the first cycle after a restart. Left
 * unguarded, one on-chain event becomes a duplicate Telegram message.
 *
 * The window keeps only the ids of the most recently processed events and
 * evicts oldest-first. It is deliberately bounded: this is a notifier, not an
 * index, and the chain remains the record. A redelivery older than the window
 * may still be announced; that is the accepted trade-off for O(1) memory and a
 * cursor file whose size does not grow with history.
 */

import { createHash } from "node:crypto";

/** Default number of recent event ids retained per watched contract. */
export const DEFAULT_DEDUP_WINDOW = 256;

/** Hex characters retained from the SHA-256 topic digest (64 bits). */
const TOPIC_DIGEST_CHARS = 16;

/**
 * Longest key the window will retain. Real keys are short (a TOID is ~30
 * characters, a `v2:` composite ~110), so anything near this bound is a broken
 * or hostile RPC trying to inflate the persisted cursor file. Such keys pass
 * through undeduplicated — like `null`, a duplicate is recoverable, an
 * unbounded payload in operator state is not.
 */
const MAX_KEY_CHARS = 512;

/**
 * The minimal shape needed to derive a stable identity for an event.
 *
 * Both the raw RPC response (which carries `id`) and a decoded event (which
 * carries `eventId`) satisfy it, so the window works at either layer.
 * `transactionIndex` / `operationIndex` / `topic` participate only in the
 * fallback composite; decoded events simply omit them.
 */
export interface DedupableEvent {
  id?: string | null;
  eventId?: string | null;
  ledger?: number | string | bigint | null;
  txHash?: string | null;
  transactionIndex?: number | string | bigint | null;
  operationIndex?: number | string | bigint | null;
  topic?: unknown;
}

/** Render a sequence number as a key segment, or `?` when absent/unusable. */
function position(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value).toString() : "?";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
  return "?";
}

/** Ledger segment: `""` when absent, the number otherwise. Never `"[object Object]"`. */
function ledgerSegment(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value).toString() : "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
  return "";
}

/**
 * Encode one topic element to a canonical string, or `null` when it cannot be
 * encoded reliably (a value we cannot compare without guessing).
 *
 * Raw HTTP responses carry base64 XDR strings; SDK-parsed responses carry
 * `xdr.ScVal` instances (which serialize meaninglessly via `JSON.stringify`),
 * so anything exposing js-xdr's `toXDR()` is encoded as base64 first. The same
 * input always produces the same output within a deployment, which is all a
 * persisted key needs.
 */
function encodeTopicEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "bigint") {
    return String(entry);
  }
  if (entry === null) return "";
  if (typeof entry !== "object") return null;
  const candidate = entry as { toXDR?: (encoding?: string) => unknown };
  if (typeof candidate.toXDR === "function") {
    try {
      const encoded = candidate.toXDR("base64");
      return typeof encoded === "string" ? encoded : null;
    } catch {
      return null;
    }
  }
  try {
    return JSON.stringify(entry) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fixed-length, deterministic digest of the topic array.
 *
 * Returns `null` when `topic` is not an array, or any element cannot be
 * encoded — identity must then come from somewhere else (see {@link eventKey}).
 * Encoded elements are joined on a separator that cannot appear in base64 XDR,
 * so `["a","bc"]` and `["ab","c"]` differ, and the digest is truncated to
 * {@link TOPIC_DIGEST_CHARS} hex characters so cursor-file entries stay small.
 */
function topicDigest(topic: unknown): string | null {
  if (!Array.isArray(topic)) return null;
  const parts: string[] = [];
  for (const entry of topic) {
    const encoded = encodeTopicEntry(entry);
    if (encoded === null) return null;
    parts.push(encoded);
  }
  return createHash("sha256")
    .update(parts.join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, TOPIC_DIGEST_CHARS);
}

/**
 * Stable identity for one event. Derivation order:
 *
 *  1. `id` — the RPC's own TOID (`<ledger-packed>-<index>`): unique per event
 *     and the field that survives pagination untouched. Returned verbatim and
 *     unprefixed so ids already persisted in the cursor file stay valid across
 *     deployments.
 *  2. `eventId` — the same token once a response carried it under that name.
 *  3. A content-derived composite `v2:<ledger>:<txHash>:<txIndex>:<opIndex>:<digest>`
 *     built from chain metadata plus a fixed-length SHA-256 digest of the topic
 *     XDR. The prefix keeps it distinguishable from a raw TOID, and from the
 *     retired `ledger:txHash:<topic-count>` format that could merge two
 *     distinct events emitted by the same operation. The transaction and
 *     operation positions plus the topic digest mean two events only share a
 *     key when every identity-bearing field agrees.
 *
 * `null` means "cannot identify": no `txHash`, no `topic` array, or topic
 * content that cannot be encoded deterministically. Callers pass those through
 * un-deduplicated — a possible duplicate is recoverable, a wrongly suppressed
 * event is not. Identity is never invented.
 *
 * A non-object input (a malformed RPC entry) also yields `null` so the page
 * walk skips it instead of crashing.
 */
export function eventKey(event: DedupableEvent | null | undefined): string | null {
  if (!event || typeof event !== "object") return null;
  if (typeof event.id === "string" && event.id !== "") return event.id;
  if (typeof event.eventId === "string" && event.eventId !== "") return event.eventId;

  const txHash = typeof event.txHash === "string" ? event.txHash : "";
  if (txHash === "") return null;

  const digest = topicDigest(event.topic);
  if (digest === null) return null;

  const ledger = ledgerSegment(event.ledger);
  const txIndex = position(event.transactionIndex);
  const opIndex = position(event.operationIndex);
  return `v2:${ledger}:${txHash}:${txIndex}:${opIndex}:${digest}`;
}

/**
 * Insertion-ordered, capacity-bounded set of recently seen event ids.
 *
 * A capacity of `0` disables deduplication entirely: every key reports as new
 * and nothing is retained, which is the documented escape hatch.
 */
export class EventDedupWindow {
  readonly capacity: number;
  /** Insertion order matters: `values().next()` is always the oldest id. */
  private readonly ids = new Set<string>();

  constructor(capacity: number = DEFAULT_DEDUP_WINDOW) {
    this.capacity = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  }

  get size(): number {
    return this.ids.size;
  }

  has(key: string): boolean {
    return this.ids.has(key);
  }

  /**
   * Record `key`, evicting the oldest id once at capacity.
   *
   * Returns `true` when the key is new (or dedup is disabled/undecidable/
   * oversized) and `false` when it had already been seen.
   */
  add(key: string | null): boolean {
    if (key === null || this.capacity === 0) return true;
    if (key.length > MAX_KEY_CHARS) return true;
    if (this.ids.has(key)) return false;

    this.ids.add(key);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  /** Ids oldest-first, at most `capacity` of them. Safe to persist as JSON. */
  toJSON(): string[] {
    return [...this.ids];
  }

  /** Rebuild from a cursor file field, tolerating missing or garbage values. */
  static fromJSON(value: unknown, capacity: number = DEFAULT_DEDUP_WINDOW): EventDedupWindow {
    const window = new EventDedupWindow(capacity);
    if (Array.isArray(value)) {
      for (const id of value) {
        if (typeof id === "string" && id !== "") window.add(id);
      }
    }
    return window;
  }
}
