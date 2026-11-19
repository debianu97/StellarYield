/**
 * Portfolio valuation and completeness model (#1660).
 *
 * In DeFi, oracle latency, missing feeds, or unlisted tokens mean that an asset's
 * current market price may be temporarily or permanently unavailable.
 *
 * This module cleanly separates:
 * 1. Genuine zero balances (deposited: 0, currentValue: 0, or user exited the position)
 * 2. Unpriced / unavailable holdings (user holds funds/shares, but price feed is missing/offline)
 * 3. Priced holdings (known positive or zero market valuation)
 *
 * It provides shared types and pure aggregation helpers so both client (Dashboard,
 * ExposureMap, Position tables) and server (PortfolioService, exports, reports)
 * compute identical completeness states and visibly incomplete totals.
 */

export type ValuationPriceStatus = "priced" | "unpriced" | "zero";

export const CONFIG_FINGERPRINT_PREFIX = "cfg1";

export type ValuationConfigFingerprint = string;

export type PortfolioValuationCompleteness =
  | "complete" // All holdings with active balances have known prices
  | "partial" // Mixed: some holdings are priced, but at least one is unpriced
  | "unavailable" // All non-zero holdings have unavailable prices
  | "empty"; // No active holdings

/** Generic input representing any position or holding. */
export interface PositionValuationInput {
  protocol: string;
  asset: string;
  deposited?: number | null;
  currentValue?: number | null;
  shares?: number | null;
  apy?: number | null;
  fetchedAt?: string | null;
  /** Explicit override or flag when price feed is known to be missing. */
  isPriceUnavailable?: boolean;
  /** Explicit price status from source data. */
  priceStatus?: ValuationPriceStatus;
  /** Optional reason for unavailable valuation (e.g., ORACLE_TIMEOUT). */
  unpricedReason?: string;
}

/** Resolved position with normalized valuation status. */
export interface ResolvedPositionValuation extends PositionValuationInput {
  deposited: number;
  currentValue: number | null;
  priceStatus: ValuationPriceStatus;
  isPriced: boolean;
  isUnpriced: boolean;
  isZeroBalance: boolean;
  /** Calculated P&L; null if valuation is unpriced. */
  pnlUsd: number | null;
}

/** Aggregate valuation summary across a portfolio. */
export interface PortfolioValuationSummary {
  /** Sum of currentValueUsd across all priced holdings. */
  pricedValueUsd: number;
  /**
   * Stated total value. Equals `pricedValueUsd` when complete or partial;
   * `null` when all holdings are unpriced.
   */
  totalValueUsd: number | null;
  /** Total deposited across ALL holdings (including unpriced). */
  totalDepositedUsd: number;
  /** Total deposited across PRICED holdings only (used for accurate P&L calculation). */
  pricedDepositedUsd: number;
  /**
   * Total yield earned on priced holdings (`pricedValueUsd - pricedDepositedUsd`).
   * `null` when no priced holdings exist.
   */
  yieldEarnedUsd: number | null;
  /** Completeness classification. */
  completeness: PortfolioValuationCompleteness;
  /** True strictly when all holdings are fully priced. */
  isComplete: boolean;
  /** Count of unpriced holdings. */
  unpricedCount: number;
  /** Count of priced holdings. */
  pricedCount: number;
  /** Count of genuine zero-balance holdings. */
  zeroCount: number;
  /** Total holdings count. */
  totalCount: number;
  /** Symbols of assets whose price is unavailable. */
  unpricedAssets: string[];
}

/**
 * Resolves the valuation status for an individual position.
 * Distinguishes genuine zero holdings from unpriced holdings.
 */
export function resolveValuationPriceStatus(
  deposited: number | null | undefined,
  currentValue: number | null | undefined,
  options?: {
    isPriceUnavailable?: boolean;
    priceStatus?: ValuationPriceStatus;
  },
): ValuationPriceStatus {
  // Explicit status takes precedence
  if (options?.priceStatus) {
    return options.priceStatus;
  }
  if (options?.isPriceUnavailable === true) {
    return "unpriced";
  }

  // If currentValue is explicitly null, undefined, or NaN, price is unavailable
  if (currentValue === null || currentValue === undefined || Number.isNaN(currentValue)) {
    return "unpriced";
  }

  const dep = typeof deposited === "number" && Number.isFinite(deposited) ? deposited : 0;
  const val = typeof currentValue === "number" && Number.isFinite(currentValue) ? currentValue : 0;

  // Genuine zero balance: deposited is 0 and current value is 0
  if (dep === 0 && val === 0) {
    return "zero";
  }

  return "priced";
}

/**
 * Normalizes an arbitrary position input into a resolved position with strict valuation typing.
 */
export function resolvePositionValuation(
  pos: PositionValuationInput,
): ResolvedPositionValuation {
  const deposited = typeof pos.deposited === "number" && Number.isFinite(pos.deposited)
    ? Math.max(0, pos.deposited)
    : 0;

  const priceStatus = resolveValuationPriceStatus(pos.deposited, pos.currentValue, {
    isPriceUnavailable: pos.isPriceUnavailable,
    priceStatus: pos.priceStatus,
  });

  const currentValue = priceStatus === "unpriced"
    ? null
    : typeof pos.currentValue === "number" && Number.isFinite(pos.currentValue)
      ? Math.max(0, pos.currentValue)
      : 0;

  const pnlUsd = priceStatus === "unpriced"
    ? null
    : (currentValue ?? 0) - deposited;

  return {
    ...pos,
    deposited,
    currentValue,
    priceStatus,
    isPriced: priceStatus === "priced",
    isUnpriced: priceStatus === "unpriced",
    isZeroBalance: priceStatus === "zero",
    pnlUsd,
  };
}

/**
 * Computes portfolio valuation summary, completeness tier, and fair yield breakdown.
 */
export function computePortfolioValuationSummary(
  positions: readonly PositionValuationInput[],
): PortfolioValuationSummary {
  if (!positions || positions.length === 0) {
    return {
      pricedValueUsd: 0,
      totalValueUsd: 0,
      totalDepositedUsd: 0,
      pricedDepositedUsd: 0,
      yieldEarnedUsd: 0,
      completeness: "empty",
      isComplete: true,
      unpricedCount: 0,
      pricedCount: 0,
      zeroCount: 0,
      totalCount: 0,
      unpricedAssets: [],
    };
  }

  const resolved = positions.map(resolvePositionValuation);

  let pricedValueUsd = 0;
  let totalDepositedUsd = 0;
  let pricedDepositedUsd = 0;
  let unpricedCount = 0;
  let pricedCount = 0;
  let zeroCount = 0;
  const unpricedAssetsSet = new Set<string>();

  for (const pos of resolved) {
    totalDepositedUsd += pos.deposited;

    if (pos.priceStatus === "unpriced") {
      unpricedCount++;
      if (pos.asset) {
        unpricedAssetsSet.add(pos.asset);
      }
    } else if (pos.priceStatus === "zero") {
      zeroCount++;
    } else {
      pricedCount++;
      pricedValueUsd += pos.currentValue ?? 0;
      pricedDepositedUsd += pos.deposited;
    }
  }

  const unpricedAssets = Array.from(unpricedAssetsSet);

  let completeness: PortfolioValuationCompleteness;
  let totalValueUsd: number | null;
  let yieldEarnedUsd: number | null;

  if (unpricedCount === 0) {
    completeness = "complete";
    totalValueUsd = pricedValueUsd;
    yieldEarnedUsd = pricedValueUsd - pricedDepositedUsd;
  } else if (pricedCount > 0) {
    // Mixed priced and unpriced holdings
    completeness = "partial";
    totalValueUsd = pricedValueUsd;
    yieldEarnedUsd = pricedValueUsd - pricedDepositedUsd;
  } else {
    // All active holdings are unpriced
    completeness = "unavailable";
    totalValueUsd = null;
    yieldEarnedUsd = null;
  }

  return {
    pricedValueUsd,
    totalValueUsd,
    totalDepositedUsd,
    pricedDepositedUsd,
    yieldEarnedUsd,
    completeness,
    isComplete: completeness === "complete",
    unpricedCount,
    pricedCount,
    zeroCount,
    totalCount: positions.length,
    unpricedAssets,
  };
}

/** Canonicalize a JSON-like value so that two structurally equal
 * configurations always serialize identically, regardless of key order.
 * Unsupported values (functions, symbols, `undefined`) are rejected rather
 * than silently dropped, because a dropped value would make two genuinely
 * different configurations fingerprint the same.
 */
export function canonicalizeConfig(value: unknown): string {
  const seen = new Set<object>();

  const walk = (input: unknown, path: string): string => {
    if (input === null) return "null";

    switch (typeof input) {
      case "string":
        return JSON.stringify(input);
      case "number":
        if (!Number.isFinite(input)) {
          throw new TypeError(`Config fingerprint: non-finite number at ${path}`);
        }
        return JSON.stringify(input);
      case "boolean":
        return input ? "true" : "false";
      case "object": {
        const object = input as Record<string, unknown>;
        if (seen.has(object)) {
          throw new TypeError(`Config fingerprint: circular reference at ${path}`);
        }
        seen.add(object);
        try {
          if (Array.isArray(object)) {
            return `[${object
              .map((entry, index) => walk(entry, `${path}[${index}]`))
              .join(",")}]`;
          }
          const keys = Object.keys(object).sort();
          return `{${keys
            .map((key) => `${JSON.stringify(key)}:${walk(object[key], `${path}.${key}`)}`)
            .join(",")}`;
        } finally {
          seen.delete(object);
        }
      }
      default:
        throw new TypeError(
          `Config fingerprint: unsupported ${typeof input} at ${path}`,
        );
    }
  };

  return walk(value, "$");
}

/** FNV-1a over UTF-16 code units, with two independent lanes so the result has
 * 64 bits of spread. Deterministic across runtimes (no BigInt requirement).
 */
function fnv1aLane(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Compute a stable fingerprint for a configuration value.
 * @example
 * computeConfigFingerprint({ b: 1, a: 2 }) === computeConfigFingerprint({ a: 2, b: 1 })
 */
export function computeConfigFingerprint(value: unknown): ValuationConfigFingerprint {
  const canonical = canonicalizeConfig(value);
  const length = canonical.length.toString(16);
  return `${CONFIG_FINGERPRINT_PREFIX}:${fnv1aLane(
    canonical,
    0x811c9dc5,
  )}${fnv1aLane("${length}\\u0000" + canonical, 0x9e3779b9)}`;
}

/** True when a value looks like a fingerprint produced by this module. */
export function isConfigFingerprint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${CONFIG_FINGERPRINT_PREFIX}:[0-9a-f]{16}$`).test(value)
  );
}

/** Compare two optional fingerprints.
 * Missing fingerprints are treated as "unknown", not as a mismatch: older
 * callers that do not send one must keep working. Two present fingerprints
 * must match exactly.
 */
export function configFingerprintsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return true;
  return a === b;
}

/** Recursively freeze a configuration snapshot so it cannot be mutated after it
 * is fingerprinted. Freezing is what makes the fingerprint trustworthy for the
 * lifetime of the snapshot.
 */
export function deepFreezeConfig<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value as Readonly<T>;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeConfig((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
