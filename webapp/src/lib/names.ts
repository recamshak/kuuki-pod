/*
 * Per-Pod human-readable labels (ticket 12a).
 *
 * A tiny key/value seam: a user-editable name per Pod, keyed by Pod ID. It
 * knows nothing about Web Bluetooth, the DOM, or `Fleet` — the component owns
 * the display and the rename prompt; this module only stores and normalises.
 *
 * Like `history.ts` it persists behind an injected `KeyValueStore` (ambient
 * `localStorage` in production, an in-memory double in tests) and is pure and
 * total: blank/whitespace names normalise to "unset", and a missing store
 * (Node without `localStorage`) is a no-op that still returns the fallback.
 *
 * Its key prefix is deliberately distinct from `history.ts`'s so that
 * `listPodIds()` (which scans the history prefix) is unaffected.
 */

/**
 * The slice of the Web Storage API this module needs. `localStorage` satisfies
 * it; tests pass an in-memory double.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface NamesOptions {
  /** Where to persist. Defaults to the ambient `localStorage` (undefined under Node). */
  store?: KeyValueStore;
}

/** Distinct from `kuuki:history:` so `listPodIds()`'s prefix scan is unaffected. */
const KEY_PREFIX = "kuuki:name:";

/** Characters of the Pod ID used as the fallback label when a Pod is unnamed. */
const FALLBACK_LENGTH = 8;

/**
 * User-editable labels for Pods, keyed by Pod ID. One instance serves the whole
 * fleet; each method takes the `podId` it acts on.
 */
export class Names {
  private readonly store: KeyValueStore | undefined;

  constructor(options: NamesOptions = {}) {
    this.store =
      options.store ??
      (globalThis as { localStorage?: KeyValueStore }).localStorage;
  }

  /** The stored label, or a short-hex fallback (first 8 chars of `podId`) when unset/blank. */
  getName(podId: string): string {
    return this.read(podId) ?? podId.slice(0, FALLBACK_LENGTH);
  }

  /** Whether a non-blank label is stored (lets the caller decide whether to prompt). */
  hasName(podId: string): boolean {
    return this.read(podId) !== undefined;
  }

  /** Trim and persist; storing a blank/whitespace name clears the label. */
  setName(podId: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed === "") {
      this.forget(podId);
      return;
    }
    this.store?.setItem(KEY_PREFIX + podId, trimmed);
  }

  /** Remove the stored label for this Pod (and only this Pod). */
  forget(podId: string): void {
    this.store?.removeItem(KEY_PREFIX + podId);
  }

  /** The stored, normalised label, or undefined when unset or blank. */
  private read(podId: string): string | undefined {
    const raw = this.store?.getItem(KEY_PREFIX + podId);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  }
}
