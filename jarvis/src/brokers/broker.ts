import type {
  AssetClass,
  OrderRequest,
  OrderResult,
  Quote,
  TradingMode,
  VenueSnapshot,
} from "../types.js";

/**
 * A Broker is one tradable venue (Alpaca, Freqtrade, Polymarket, ...).
 *
 * Adapters are intentionally thin and uniform so the portfolio aggregator and
 * the Jarvis agent can treat every venue the same way. Anything venue-specific
 * (auth, endpoints, paper-vs-live wiring) lives inside the adapter.
 */
export interface Broker {
  readonly name: string;
  readonly assetClass: AssetClass;

  /** True when the adapter has the credentials/config it needs to try. */
  isConfigured(): boolean;

  /** Per-venue mode. Most adapters mirror the global mode; Freqtrade reports its own. */
  mode(): Promise<TradingMode> | TradingMode;

  /** Fetch balance + positions (+ liveness). Never throws — errors land on the snapshot. */
  snapshot(): Promise<VenueSnapshot>;

  /** Latest price for a symbol on this venue. */
  quote?(symbol: string): Promise<Quote>;

  /** Place an order. Live-mode guarding is enforced by the caller, not here. */
  placeOrder?(req: OrderRequest): Promise<OrderResult>;
}

/** Build the standard "not configured" snapshot so adapters don't repeat it. */
export function notConfigured(
  name: string,
  assetClass: AssetClass,
  mode: TradingMode,
): VenueSnapshot {
  return { venue: name, assetClass, configured: false, connected: false, mode, positions: [] };
}
