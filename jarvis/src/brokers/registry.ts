import type { Config } from "../config.js";
import type { Broker } from "./broker.js";
import { AlpacaBroker } from "./alpaca.js";
import { FreqtradeBroker } from "./freqtrade.js";
import { PolymarketBroker } from "./polymarket.js";

/**
 * The set of venues Jarvis knows about. Add a new asset class (IBKR, Kalshi,
 * a forex broker, ...) by implementing Broker and registering it here — the
 * portfolio aggregator, the API, and the agent tools pick it up automatically.
 */
export function buildBrokers(cfg: Config): Broker[] {
  return [new AlpacaBroker(cfg), new FreqtradeBroker(cfg), new PolymarketBroker(cfg)];
}

export function findBroker(brokers: Broker[], name: string): Broker | undefined {
  return brokers.find((b) => b.name === name.toLowerCase());
}
