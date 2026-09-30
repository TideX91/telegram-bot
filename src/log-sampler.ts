/**
 * Windowed sampling for repetitive operational logs.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * This process is built to stay up for weeks, so it also fails for hours at a
 * time: an RPC that is down stays down, and the poller retries both contracts
 * every cycle. Logging each identical failure verbatim buries the one line that
 * actually changed under a wall of copies, and it is the copies that blow up
 * the log volume on a long outage.
 *
 * This sampler collapses repeats by KEY. Within a window of `windowMs`:
 *
 *  - the first `maxPerWindow` occurrences are returned for the caller to log;
 *  - further occurrences are counted and suppressed;
 *  - the next occurrence after the window elapses is returned for logging with
 *    `suppressed` carrying the number of repeats that were held back, so a
 *    suppressed run is always reported rather than silently dropped.
 *
 * Nothing is lost: {@link LogSampler.suppressedTotal} keeps the lifetime count
 * for status output, and {@link LogSampler.pending} exposes the repeats still
 * waiting inside an open window.
 *
 * The clock is injected so the behaviour is deterministic under test. `key` is
 * the caller's identity for "the same failure" — one key per watch target, so a
 * broken market contract cannot silence the squad contract's errors.
 */

export interface LogSamplerOptions {
  /** Full lines returned per key per window. Clamped to at least 1. */
  maxPerWindow?: number;
  /** Window length in milliseconds. Clamped to at least 1. */
  windowMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface LogSample {
  /** Log the caller's own line for this occurrence. */
  log: boolean;
  /**
   * Repeats suppressed before this occurrence, for the caller to summarize.
   * Non-zero only when a window rolled over with repeats held back; those
   * repeats are reported once and then reset.
   */
  suppressed: number;
}

interface Window {
  windowStart: number;
  emitted: number;
  suppressed: number;
}

const DEFAULT_MAX_PER_WINDOW = 3;
/** 5 minutes: ~10 default poll cycles of a down RPC collapse into one line. */
const DEFAULT_WINDOW_MS = 300_000;

/**
 * Suffix for a sampled line that opens a new window, reporting how many repeats
 * the previous one held back. Empty when there is nothing to report, so callers
 * can append it unconditionally.
 */
export function formatSuppressedRepeats(suppressed: number, windowMs: number): string {
  if (suppressed <= 0) return "";
  // Round for display; a sub-second window is reported as "1s", never "0s".
  const seconds = Math.max(1, Math.round(windowMs / 1000));
  return (
    ` (suppressed ${suppressed} identical repeat${suppressed === 1 ? "" : "s"}` +
    ` in the previous ${seconds}s)`
  );
}

export class LogSampler {
  readonly maxPerWindow: number;
  readonly windowMs: number;

  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();
  private lifetimeSuppressed = 0;

  constructor(options: LogSamplerOptions = {}) {
    this.maxPerWindow = Math.max(1, Math.trunc(options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW));
    this.windowMs = Math.max(1, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.now = options.now ?? Date.now;
  }

  /** Record one occurrence of `key` and decide whether it should be logged. */
  record(key: string): LogSample {
    const at = this.now();
    const current = this.windows.get(key);

    if (current === undefined || at - current.windowStart >= this.windowMs) {
      // A new window opens. Anything held back in the previous one is handed to
      // the caller on this line instead of disappearing.
      const carried = current?.suppressed ?? 0;
      this.windows.set(key, { windowStart: at, emitted: 1, suppressed: 0 });
      return { log: true, suppressed: carried };
    }

    if (current.emitted < this.maxPerWindow) {
      current.emitted += 1;
      return { log: true, suppressed: 0 };
    }

    current.suppressed += 1;
    this.lifetimeSuppressed += 1;
    return { log: false, suppressed: 0 };
  }

  /** Repeats held back in the open window for `key`, not yet reported. */
  pending(key: string): number {
    return this.windows.get(key)?.suppressed ?? 0;
  }

  /** Occurrences suppressed across every key since construction. */
  suppressedTotal(): number {
    return this.lifetimeSuppressed;
  }

  /** Number of distinct keys observed so far. */
  size(): number {
    return this.windows.size;
  }
}
