// Shared domain types for the Jarvis multi-venue trading dashboard.

export type TradingMode = "paper" | "live";

/** A tradable asset class, used to group venues in the UI. */
export type AssetClass = "stocks" | "crypto" | "prediction";

export type OrderSide = "buy" | "sell";

export interface Quote {
  venue: string;
  symbol: string;
  price: number;
  asOf: string; // ISO timestamp
}

export interface Position {
  venue: string;
  assetClass: AssetClass;
  symbol: string;
  /** Signed quantity (negative = short). */
  quantity: number;
  /** Average entry/cost price, if known. */
  avgPrice?: number;
  /** Latest mark price, if known. */
  markPrice?: number;
  /** Current market value in account currency (USD). */
  marketValue?: number;
  /** Unrealized P&L in USD, if known. */
  unrealizedPnl?: number;
}

export interface Balance {
  /** Total account value (cash + positions) in USD. */
  equity: number;
  /** Free cash available to trade, in USD. */
  cash?: number;
  /** Buying power, in USD (may exceed cash with margin). */
  buyingPower?: number;
}

export interface OrderRequest {
  venue: string;
  symbol: string;
  side: OrderSide;
  /** Quantity in units (shares/contracts/coins). Either qty or notional. */
  qty?: number;
  /** Dollar amount to trade, if the venue supports notional orders. */
  notional?: number;
  /** "market" (default) or "limit". */
  type?: "market" | "limit";
  /** Required for limit orders. */
  limitPrice?: number;
}

export interface OrderResult {
  ok: boolean;
  venue: string;
  /** Venue-assigned order id when accepted. */
  orderId?: string;
  status?: string;
  /** Human-readable detail (error message, or confirmation note). */
  message: string;
}

/** What a single venue reports about itself for the dashboard. */
export interface VenueSnapshot {
  venue: string;
  assetClass: AssetClass;
  /** Configured = has credentials/URL; connected = reachable right now. */
  configured: boolean;
  connected: boolean;
  mode: TradingMode;
  balance?: Balance;
  positions: Position[];
  /** Populated when a call failed, for surfacing in the UI. */
  error?: string;
}

/** The aggregated view across every venue. */
export interface PortfolioSnapshot {
  mode: TradingMode;
  asOf: string;
  totalEquity: number;
  totalUnrealizedPnl: number;
  venues: VenueSnapshot[];
}
