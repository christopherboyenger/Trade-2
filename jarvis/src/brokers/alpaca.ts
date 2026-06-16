import type { Config } from "../config.js";
import type {
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  TradingMode,
  VenueSnapshot,
} from "../types.js";
import { type Broker, notConfigured } from "./broker.js";

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

/**
 * Alpaca adapter — US stocks & ETFs. Paper and live use the same REST shape
 * with different base URLs and key pairs, so the global mode picks which.
 * Docs: https://docs.alpaca.markets/reference
 */
export class AlpacaBroker implements Broker {
  readonly name = "alpaca";
  readonly assetClass = "stocks" as const;

  constructor(private readonly cfg: Config) {}

  private keys(): { id: string; secret: string } {
    return this.cfg.mode === "live"
      ? { id: this.cfg.alpaca.liveKeyId, secret: this.cfg.alpaca.liveSecret }
      : { id: this.cfg.alpaca.paperKeyId, secret: this.cfg.alpaca.paperSecret };
  }

  private base(): string {
    return this.cfg.mode === "live" ? LIVE_BASE : PAPER_BASE;
  }

  mode(): TradingMode {
    return this.cfg.mode;
  }

  isConfigured(): boolean {
    const { id, secret } = this.keys();
    return Boolean(id && secret);
  }

  private headers(): Record<string, string> {
    const { id, secret } = this.keys();
    return {
      "APCA-API-KEY-ID": id,
      "APCA-API-SECRET-KEY": secret,
      "Content-Type": "application/json",
    };
  }

  private async get(path: string, baseUrl = this.base()): Promise<any> {
    const res = await fetch(`${baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  async snapshot(): Promise<VenueSnapshot> {
    if (!this.isConfigured()) return notConfigured(this.name, this.assetClass, this.cfg.mode);

    try {
      const [account, positions] = await Promise.all([
        this.get("/v2/account"),
        this.get("/v2/positions"),
      ]);

      const pos: Position[] = (positions as any[]).map((p) => ({
        venue: this.name,
        assetClass: this.assetClass,
        symbol: p.symbol,
        quantity: Number(p.qty),
        avgPrice: Number(p.avg_entry_price),
        markPrice: Number(p.current_price),
        marketValue: Number(p.market_value),
        unrealizedPnl: Number(p.unrealized_pl),
      }));

      return {
        venue: this.name,
        assetClass: this.assetClass,
        configured: true,
        connected: true,
        mode: this.cfg.mode,
        balance: {
          equity: Number(account.equity),
          cash: Number(account.cash),
          buyingPower: Number(account.buying_power),
        },
        positions: pos,
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

  async quote(symbol: string): Promise<Quote> {
    const data = await this.get(
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
      DATA_BASE,
    );
    const q = data.quote ?? {};
    // Mid-price from ask/bid; fall back to whichever side is present.
    const ap = Number(q.ap) || 0;
    const bp = Number(q.bp) || 0;
    const price = ap && bp ? (ap + bp) / 2 : ap || bp;
    return { venue: this.name, symbol, price, asOf: q.t ?? new Date().toISOString() };
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      symbol: req.symbol,
      side: req.side,
      type: req.type ?? "market",
      time_in_force: "day",
    };
    if (req.qty != null) body.qty = String(req.qty);
    else if (req.notional != null) body.notional = String(req.notional);
    if (req.type === "limit") body.limit_price = String(req.limitPrice);

    const res = await fetch(`${this.base()}/v2/orders`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, venue: this.name, message: data?.message ?? `Alpaca ${res.status}` };
    }
    return {
      ok: true,
      venue: this.name,
      orderId: data.id,
      status: data.status,
      message: `Submitted ${req.side} ${req.qty ?? req.notional} ${req.symbol} (${this.cfg.mode})`,
    };
  }
}
