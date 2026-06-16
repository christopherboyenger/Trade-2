import "dotenv/config";
import type { TradingMode } from "./types.js";

function asMode(v: string | undefined): TradingMode {
  return v === "live" ? "live" : "paper";
}

export const config = {
  port: Number(process.env.PORT ?? 8088),
  mode: asMode(process.env.TRADING_MODE),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    // Default to the latest, most capable Claude model for the Jarvis brain.
    model: process.env.JARVIS_MODEL ?? "claude-opus-4-8",
  },

  alpaca: {
    paperKeyId: process.env.ALPACA_PAPER_KEY_ID ?? "",
    paperSecret: process.env.ALPACA_PAPER_SECRET_KEY ?? "",
    liveKeyId: process.env.ALPACA_LIVE_KEY_ID ?? "",
    liveSecret: process.env.ALPACA_LIVE_SECRET_KEY ?? "",
  },

  freqtrade: {
    url: process.env.FREQTRADE_URL ?? "",
    username: process.env.FREQTRADE_USERNAME ?? "",
    password: process.env.FREQTRADE_PASSWORD ?? "",
  },

  polymarket: {
    address: process.env.POLYMARKET_ADDRESS ?? "",
  },
} as const;

export type Config = typeof config;
