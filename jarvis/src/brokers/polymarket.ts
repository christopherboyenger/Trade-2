import type { Config } from "../config.js";
import type { Position, TradingMode, VenueSnapshot } from "../types.js";
import { type Broker, notConfigured } from "./broker.js";

const DATA_API = "https://data-api.polymarket.com";

/**
 * Polymarket adapter — prediction markets, READ-ONLY in this MVP.
 *
 * Public market data needs no auth. Reading *your* positions needs only a
 * wallet address (also public). Order execution is intentionally NOT wired
 * here yet — it needs signed CLOB credentials and is better delegated to the
 * CloddsBot agent, which already implements the full Polymarket trade path.
 */
export class PolymarketBroker implements Broker {
  readonly name = "polymarket";
  readonly assetClass = "prediction" as const;

  constructor(private readonly cfg: Config) {}

  isConfigured(): boolean {
    // Always reachable for public market data; positions need an address.
    return true;
  }

  mode(): TradingMode {
    return this.cfg.mode;
  }

  async snapshot(): Promise<VenueSnapshot> {
    const address = this.cfg.polymarket.address;
    if (!address) {
      // Configured, but no wallet => no positions to show (still "connected").
      return notConfigured(this.name, this.assetClass, this.cfg.mode);
    }
    try {
      const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(address)}`);
      if (!res.ok) throw new Error(`Polymarket ${res.status}`);
      const rows = (await res.json()) as any[];

      const positions: Position[] = (rows ?? []).map((p) => ({
        venue: this.name,
        assetClass: this.assetClass,
        symbol: p.title ?? p.asset ?? p.conditionId ?? "market",
        quantity: Number(p.size ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
        markPrice: Number(p.curPrice ?? 0),
        marketValue: Number(p.currentValue ?? 0),
        unrealizedPnl: Number(p.cashPnl ?? 0),
      }));

      const equity = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
      return {
        venue: this.name,
        assetClass: this.assetClass,
        configured: true,
        connected: true,
        mode: this.cfg.mode,
        balance: { equity },
        positions,
      };
    } catch (err) {
      return {
        venue: this.name,
        assetClass: this.assetClass,
        configured: true,
        connected: false,
        mode: this.cfg.mode,
        positions: [],
        error: (err as Error).message,
      };
    }
  }
}
