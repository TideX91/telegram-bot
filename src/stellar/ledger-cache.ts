/**
 * Per-cycle ledger tip cache.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * A poll cycle watches more than one contract (market + squad) and every scan
 * needs the chain tip: `getHealth()` supplies `latestLedger` (termination and
 * `latestLedger` reporting) and `oldestLedger` (the retained-history floor that
 * `startLedger` is clamped to). Without a cache, each target's scan calls
 * `getHealth()` on its own, so a cycle with N contracts costs N health reads
 * for one unchanging fact — and the two targets can see different tips inside
 * the same cycle.
 *
 * The cache holds ONE tip for the duration of a cycle:
 *
 *  - {@link LedgerCache.reset} drops it at the start of every cycle.
 *  - {@link LedgerCache.get} returns the cached tip to every later caller, so a
 *    two-contract cycle performs a single `getHealth()`.
 *  - Concurrent callers are collapsed onto one in-flight request, so a future
 *    parallel scan cannot fan out health reads either.
 *  - A FAILED fetch is never cached. The next caller retries, which keeps the
 *    poller's existing per-target failure handling intact: if `getHealth()`
 *    rejects, each target fails on its own and no target ever scans against a
 *    tip that was never observed.
 *
 * The chain remains the source of truth: the tip is a cache, not state. Nothing
 * is persisted, and a restart starts from an empty cache.
 */

import type { rpc } from "@stellar/stellar-sdk";

/** The two numbers a scan needs from `getHealth()`. */
export interface LedgerTip {
  oldestLedger: number;
  latestLedger: number;
}

export interface LedgerCacheStats {
  /** `get()` calls served from cache (including coalesced in-flight calls). */
  hits: number;
  /** `get()` calls that reached `getHealth()`. */
  misses: number;
}

export interface LedgerCacheOptions {
  /**
   * How long a fetched tip may be reused, in milliseconds. The poller resets
   * the cache per cycle and uses `Infinity` so a cycle never refetches; a
   * standalone reader that never calls `reset()` should keep the default.
   */
  ttlMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Default reuse window: comfortably longer than a healthy poll cycle. */
export const DEFAULT_LEDGER_TTL_MS = 5_000;

export class LedgerCache {
  private tip: LedgerTip | null = null;
  private fetchedAt = 0;
  private inflight: Promise<LedgerTip> | null = null;
  private hits = 0;
  private misses = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: LedgerCacheOptions = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_LEDGER_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  /**
   * Drop the cached tip so the next {@link get} refetches it. Call once at the
   * start of each poll cycle; also clears any in-flight request so a slow fetch
   * from the previous cycle cannot leak into the next one.
   */
  reset(): void {
    this.tip = null;
    this.fetchedAt = 0;
    this.inflight = null;
  }

  /** The cached tip, or `null` when there is none or it is no longer fresh. */
  peek(): LedgerTip | null {
    return this.isFresh() ? this.tip : null;
  }

  /** Cache counters for `/status` and tests. */
  stats(): LedgerCacheStats {
    return { hits: this.hits, misses: this.misses };
  }

  /**
   * Return the chain tip, reusing a fresh cached value and coalescing
   * concurrent callers onto a single `getHealth()` request.
   *
   * A rejected `getHealth()` is not cached: the promise is cleared, so the next
   * caller retries instead of inheriting the failure.
   */
  async get(server: rpc.Server): Promise<LedgerTip> {
    if (this.isFresh()) {
      this.hits += 1;
      return this.tip as LedgerTip;
    }
    if (this.inflight) {
      this.hits += 1;
      return this.inflight;
    }

    this.misses += 1;
    this.inflight = server
      .getHealth()
      .then((health) => {
        const tip: LedgerTip = {
          oldestLedger: health.oldestLedger,
          latestLedger: health.latestLedger,
        };
        this.tip = tip;
        this.fetchedAt = this.now();
        return tip;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  private isFresh(): boolean {
    return this.tip !== null && this.now() - this.fetchedAt < this.ttlMs;
  }
}
