import type Anthropic from "@anthropic-ai/sdk";
import type { Broker } from "../brokers/broker.js";
import { findBroker } from "../brokers/registry.js";
import type { Config } from "../config.js";
import { aggregatePortfolio } from "../portfolio.js";
import type { OrderRequest, OrderSide } from "../types.js";

/**
 * Tool surface exposed to the Jarvis agent. Read tools run freely; the write
 * tool (place_order) is gated: in live mode it never executes without an
 * explicit `confirmed: true`, so a stray model decision cannot move real money.
 */
export const toolDefs: Anthropic.Tool[] = [
  {
    name: "get_portfolio",
    description:
      "Get the unified portfolio across all venues (stocks via Alpaca, crypto via Freqtrade, prediction markets via Polymarket): total equity, per-venue balances, open positions, and P&L. Call this whenever the user asks about holdings, balance, exposure, or performance.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_quote",
    description:
      "Get the latest price for a symbol on a specific venue. Use venue 'alpaca' for stock/ETF tickers (e.g. AAPL).",
    input_schema: {
      type: "object",
      properties: {
        venue: { type: "string", description: "Venue name, e.g. 'alpaca'." },
        symbol: { type: "string", description: "Ticker/pair/market symbol." },
      },
      required: ["venue", "symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "place_order",
    description:
      "Place an order on a venue. In paper mode it executes immediately. In LIVE mode it will NOT execute unless 'confirmed' is true — present the order to the user and ask them to confirm first. Prefer 'notional' (dollar amount) for stocks when the user speaks in dollars.",
    input_schema: {
      type: "object",
      properties: {
        venue: { type: "string", description: "Venue name, e.g. 'alpaca' or 'freqtrade'." },
        symbol: { type: "string", description: "Ticker/pair to trade." },
        side: { type: "string", enum: ["buy", "sell"], description: "buy or sell." },
        qty: { type: "number", description: "Quantity in units (shares/contracts)." },
        notional: { type: "number", description: "Dollar amount to trade (stocks)." },
        type: { type: "string", enum: ["market", "limit"], description: "Order type." },
        limitPrice: { type: "number", description: "Required for limit orders." },
        confirmed: {
          type: "boolean",
          description: "Set true only after the user has explicitly approved a LIVE order.",
        },
      },
      required: ["venue", "symbol", "side"],
      additionalProperties: false,
    },
  },
];

/** Execute one tool call and return a string result for the model. */
export async function runTool(
  cfg: Config,
  brokers: Broker[],
  name: string,
  input: any,
): Promise<string> {
  switch (name) {
    case "get_portfolio": {
      const snap = await aggregatePortfolio(cfg, brokers);
      return JSON.stringify(snap);
    }

    case "get_quote": {
      const b = findBroker(brokers, String(input.venue));
      if (!b?.quote) return `No quote available for venue '${input.venue}'.`;
      try {
        return JSON.stringify(await b.quote(String(input.symbol)));
      } catch (err) {
        return `Quote failed: ${(err as Error).message}`;
      }
    }

    case "place_order": {
      const b = findBroker(brokers, String(input.venue));
      if (!b?.placeOrder) return `Venue '${input.venue}' does not support order placement here.`;

      const req: OrderRequest = {
        venue: b.name,
        symbol: String(input.symbol),
        side: input.side as OrderSide,
        qty: input.qty,
        notional: input.notional,
        type: input.type ?? "market",
        limitPrice: input.limitPrice,
      };

      // Safety gate: live orders require explicit confirmation.
      if (cfg.mode === "live" && input.confirmed !== true) {
        return JSON.stringify({
          ok: false,
          requiresConfirmation: true,
          message:
            "LIVE mode: order NOT placed. Show this order to the user and ask them to confirm; only then call place_order again with confirmed=true.",
          order: req,
        });
      }

      const result = await b.placeOrder(req);
      return JSON.stringify(result);
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
