// import removed: getYieldData unused

import {
  analyzeConcentration,
  type ConcentrationAnalysis,
  type ConcentrationThresholdsInput,
  type ConcentrationWarning,
} from "../../../shared/types/exposureConcentration";
import {
  computePortfolioValuationSummary,
  type PortfolioValuationSummary,
  type ValuationPriceStatus,
  computeConfigFingerprint,
  configFingerprintsMatch,
  deepFreezeConfig,
} from "../../../shared/types/portfolioValuation";
import { readConcentrationThresholdOverrides } from "../config/concentrationThresholds";
import {
  computeFreshnessStatus,
  type FreshnessResult,
} from "./sourceHealthService";
import { ExportFailureError } from "../types/exportFailure";

export interface VaultPosition {
  protocol: string;
  asset: string;
  depositedUsd: number;
  /** Current valuation in USD, or null if price is unavailable (#1660). */
  currentValueUsd: number | null;
  /** ISO-8601 timestamp of when this position's source data was last fetched (#1107). */
  fetchedAt?: string | null;
  /** Explicit valuation price status (#1660). */
  priceStatus?: ValuationPriceStatus;
  isPriceUnavailable?: boolean;
}

/** A holding with its source-freshness metadata attached (#1107). */
export interface HoldingWithFreshness extends VaultPosition {
  freshness: FreshnessResult;
}

export interface ExposureMap {
  byAsset: Record<string, number>;
  byProtocol: Record<string, number>;
  byStrategy: Record<string, number>;
  totalValueUsd: number;
  /** Warning messages, kept as plain strings for existing consumers. */
  concentrationWarnings: string[];
  /** Structured grading behind those messages. */
  concentration: ConcentrationAnalysis;
}

export class PortfolioService {
  public static readonly SUPPORTED_ASSET_CLASSES = ["stablecoin", "crypto"];

  /**
   * Aggregates positions by asset, protocol, and strategy, then grades the
   * asset and protocol buckets for concentration risk. Excludes unpriced holdings.
   */
  public static async getExposureMap(
    positions: VaultPosition[],
    thresholds?: ConcentrationThresholdsInput,
  ): Promise<ExposureMap> {
    const byAsset: Record<string, number> = {};
    const byProtocol: Record<string, number> = {};
    const byStrategy: Record<string, number> = {};
    let totalValueUsd = 0;

    for (const pos of positions) {
      if (
        pos.currentValueUsd === null ||
        pos.currentValueUsd === undefined ||
        pos.isPriceUnavailable === true ||
        pos.priceStatus === "unpriced"
      ) {
        continue;
      }

      totalValueUsd += pos.currentValueUsd;
      byAsset[pos.asset] = (byAsset[pos.asset] || 0) + pos.currentValueUsd;
      byProtocol[pos.protocol] = (byProtocol[pos.protocol] || 0) + pos.currentValueUsd;

      const strategy = this.getStrategyForProtocol(pos.protocol);
      byStrategy[strategy] = (byStrategy[strategy] || 0) + pos.currentValueUsd;
    }

    const concentration = analyzeConcentration(
      { byAsset, byProtocol, totalValueUsd },
      thresholds ?? readConcentrationThresholdOverrides(),
    );

    return {
      byAsset,
      byProtocol,
      byStrategy,
      totalValueUsd,
      concentrationWarnings: concentration.messages,
      concentration,
    };
  }

  public static gradeConcentration(
    exposure: Pick<ExposureMap, "byAsset" | "byProtocol" | "totalValueUsd">,
    thresholds?: ConcentrationThresholdsInput,
  ): ConcentrationAnalysis {
    return analyzeConcentration(exposure, thresholds ?? readConcentrationThresholdOverrides());
  }

  public static getAssetClass(asset: string): string {
    const normalized = asset.toUpperCase();
    if (normalized === "USDC") {
      return "stablecoin";
    }
    return "crypto";
  }

  public static filterPositionsByAssetClass(
    positions: VaultPosition[],
    filters: Record<string, any>,
  ): VaultPosition[] {
    const assetClassParam = filters.assetClass ?? filters.assetClasses;

    let classes: string[] = [];
    if (typeof assetClassParam === "string") {
      classes = assetClassParam.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    } else if (Array.isArray(assetClassParam)) {
      classes = assetClassParam.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
    }

    if (classes.length === 0) {
      throw new ExportFailureError(
        "EXPORT_VALIDATION_FAILED",
        "Export filters cannot be empty. Please select at least one asset class.",
        { field: "assetClass" },
      );
    }

    for (const c of classes) {
      if (!this.SUPPORTED_ASSET_CLASSES.includes(c)) {
        throw new ExportFailureError(
          "EXPORT_VALIDATION_FAILED",
          `Unsupported asset class: "${c}". Supported classes are: ${this.SUPPORTED_ASSET_CLASSES.join(", ")}.`,
          { assetClass: c, supported: this.SUPPORTED_ASSET_CLASSES },
        );
      }
    }

    const filtered = positions.filter((pos) => classes.includes(this.getAssetClass(pos.asset)));

    if (filtered.length === 0) {
      throw new ExportFailureError(
        "EXPORT_NO_DATA",
        "No portfolio data matches the selected filters.",
        { requestedAssetClasses: classes },
      );
    }

    return filtered;
  }

  public static attachFreshness(
    positions: VaultPosition[],
    now: Date = new Date(),
  ): HoldingWithFreshness[] {
    return positions.map((position) => ({
      ...position,
      freshness: computeFreshnessStatus(position.fetchedAt, now),
    }));
  }

  public static holdingsToCsv(holdings: HoldingWithFreshness[]): string {
    const headers = [
      "Protocol",
      "Asset",
      "Deposited (USD)",
      "Current Value (USD)",
      "Source Freshness",
      "Last Updated",
    ];
    const rows = holdings.map((holding) => {
      const isUnpriced =
        holding.currentValueUsd === null ||
        holding.currentValueUsd === undefined ||
        holding.isPriceUnavailable === true ||
        holding.priceStatus === "unpriced";

      const formattedCurrentValue = isUnpriced
        ? "UNAVAILABLE"
        : holding.currentValueUsd.toFixed(2);

      return [
        holding.protocol,
        holding.asset,
        holding.depositedUsd.toFixed(2),
        formattedCurrentValue,
        holding.freshness.status,
        holding.freshness.fetchedAt ?? "unknown",
      ]
        .map(escapeCsvField)
        .join(",");
    });
    return [headers.join(","), ...rows].join("\n");
  }

  /**
   * Computes valuation completeness, unpriced holdings count, and fair yield metrics (#1660).
   * Also computes a config fingerprint for stale snapshot detection (#1862).
   * The fingerprint is derived from the canonical serialization of the configuration
   * that produced the valuation. If the configuration changes, the fingerprint
   * will differ, allowing callers to detect stale work.
   *
   * @param config Optional configuration object to fingerprint. When provided,
   * the fingerprint is computed and attached to the summary. Callers should
   * compare this fingerprint with the current configuration before reusing
   * cached valuation results.
   */
  public static computeValuationSummary(
    positions: VaultPosition[],
    config?: unknown,
  ): PortfolioValuationSummary {
    const summary = computePortfolioValuationSummary(
      positions.map((p) => ({
        protocol: p.protocol,
        asset: p.asset,
        deposited: p.depositedUsd,
        currentValue: p.currentValueUsd,
        fetchedAt: p.fetchedAt,
        isPriceUnavailable: p.isPriceUnavailable,
        priceStatus: p.priceStatus,
      })),
    );

    // Compute config fingerprint for stale snapshot detection (#1862)
    let configFingerprint: string | undefined;
    if (config !== undefined) {
      configFingerprint = computeConfigFingerprint(deepFreezeConfig(config));
    }

    // Attach fingerprint to the summary for caller-side freshness checking
    // @ts-expect-error - adding optional field for fingerprint tracking
    summary.configFingerprint = configFingerprint;

    return summary;
  }

  private static getStrategyForProtocol(protocol: string): string {
    const mapping: Record<string, string> = {
      Blend: "Lending",
      Soroswap: "Liquidity Provision",
      DeFindex: "Yield Aggregation",
    };
    return mapping[protocol] || "Other";
  }
}

/** Escape a CSV field: quote and double-up inner quotes if it contains a comma, quote, or newline. */
function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type { ConcentrationAnalysis, ConcentrationWarning };
