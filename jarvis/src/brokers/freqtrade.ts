import type { Config } from "../config.js";
import type {
  OrderRequest,
  OrderResult,
  Position,
  TradingMode,
  VenueSnapshot,
} from "../types.js";
import { type Broker, notConfigured } from "./broker.js";

/**
 * Freqtrade adapter — crypto, via Freqtrade's built-in REST API.
 * Freqtrade runs as its own service (see ../../freqtrade); Jarvis drives it
 * over HTTP. Freqtrade's `dry_run` flag is its own paper/live switch, which we
 * surface as this venue's mode.
 * Docs: https://www.freqtrade.io/en/stable/rest-api/
 */
export class FreqtradeBroker implements Broker {
  readonly name = "freqtrade";
  readonly assetClass = "crypto" as const;

  private cachedMode: TradingMode | undefined;

  constructor(private readonly cfg: Config) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.freqtrade.url);
  }

  mode(): TradingMode {
    // Best-effort: until we've talked to Freqtrade we assume paper (dry-run).
    return this.cachedMode ?? "paper";
  }

  private authHeader(): Record<string, string> {
    const { username, password } = this.cfg.freqtrade;
    if (!username) return {};
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  private async api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.cfg.freqtrade.url}/api/v1${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...this.authHeader(), ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      throw new Error(`Freqtrade ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  async snapshot(): Promise<VenueSnapshot> {
    if (!this.isConfigured()) return notConfigured(this.name, this.assetClass, this.mode());

    try {
      const [cfg, balance, status] = await Promise.all([
        this.api("/show_config"),
        this.api("/balance"),
        this.api("/status"), // array of open trades
      ]);

      this.cachedMode = cfg?.dry_run ? "paper" : "live";

      const open: any[] = Array.isArray(status) ? status : [];
      const positions: Position[] = open.map((t) => ({
        venue: this.name,
        assetClass: this.assetClass,
        symbol: t.pair,
        quantity: Number(t.amount),
        avgPrice: Number(t.open_rate),
        markPrice: Number(t.current_rate),
        marketValue: Number(t.amount) * Number(t.current_rate ?? t.open_rate),
        unrealizedPnl: Number(t.profit_abs ?? 0),
      }));

      return {
        venue: this.name,
        assetClass: this.assetClass,
        configured: true,
        connected: true,
        mode: this.cachedMode,
        balance: { equity: Number(balance?.total ?? 0), cash: Number(balance?.total ?? 0) },
        positions,
      };
    } catch (err) {
      return {
        venue: this.name,
        assetClass: this.assetClass,
        configured: true,
        connected: false,
        mode: this.mode(),
        positions: [],
        error: (err as Error).message,
      };
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    // Freqtrade trades pairs; a buy = forceenter, a sell = forceexit of the pair.
    try {
      if (req.side === "buy") {
        const body: Record<string, unknown> = { pair: req.symbol };
        if (req.notional != null) body.stakeamount = req.notional;
        if (req.type === "limit") body.price = req.limitPrice;
        const r = await this.api("/forceenter", { method: "POST", body: JSON.stringify(body) });
        return { ok: true, venue: this.name, status: r?.status, message: `forceenter ${req.symbol}` };
      }
      const r = await this.api("/forceexit", {
        method: "POST",
        body: JSON.stringify({ tradeid: req.symbol }),
      });
      return { ok: true, venue: this.name, status: r?.status, message: `forceexit ${req.symbol}` };
    } catch (err) {
      return { ok: false, venue: this.name, message: (err as Error).message };
    }
  }
}
