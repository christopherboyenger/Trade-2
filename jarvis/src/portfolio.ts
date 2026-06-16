import type { Broker } from "./brokers/broker.js";
import type { Config } from "./config.js";
import type { PortfolioSnapshot, VenueSnapshot } from "./types.js";

/**
 * Fan out to every venue and merge into one unified portfolio view.
 * Each adapter's snapshot() is failure-isolated, so one dead venue never takes
 * down the dashboard — it just shows as disconnected.
 */
export async function aggregatePortfolio(
  cfg: Config,
  brokers: Broker[],
): Promise<PortfolioSnapshot> {
  const venues: VenueSnapshot[] = await Promise.all(brokers.map((b) => b.snapshot()));

  let totalEquity = 0;
  let totalUnrealizedPnl = 0;
  for (const v of venues) {
    if (v.balance?.equity) totalEquity += v.balance.equity;
    for (const p of v.positions) totalUnrealizedPnl += p.unrealizedPnl ?? 0;
  }

  return {
    mode: cfg.mode,
    asOf: new Date().toISOString(),
    totalEquity,
    totalUnrealizedPnl,
    venues,
  };
}
