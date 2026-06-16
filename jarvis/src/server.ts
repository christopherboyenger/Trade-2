import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Broker } from "./brokers/broker.js";
import { findBroker } from "./brokers/registry.js";
import type { Config } from "./config.js";
import { chat, type ChatTurn } from "./jarvis/agent.js";
import { aggregatePortfolio } from "./portfolio.js";
import type { OrderRequest } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

export function createServer(cfg: Config, brokers: Broker[]) {
  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mode: cfg.mode,
      jarvis: Boolean(cfg.anthropic.apiKey),
      venues: brokers.map((b) => ({
        name: b.name,
        assetClass: b.assetClass,
        configured: b.isConfigured(),
      })),
    });
  });

  app.get("/api/portfolio", async (_req, res) => {
    try {
      res.json(await aggregatePortfolio(cfg, brokers));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/quote", async (req, res) => {
    const venue = String(req.query.venue ?? "");
    const symbol = String(req.query.symbol ?? "");
    const b = findBroker(brokers, venue);
    if (!b?.quote) return res.status(400).json({ error: `No quotes for venue '${venue}'.` });
    try {
      res.json(await b.quote(symbol));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Direct order endpoint (used by the dashboard's manual confirm button).
  app.post("/api/order", async (req, res) => {
    const body = req.body as OrderRequest & { confirmed?: boolean };
    const b = findBroker(brokers, String(body.venue ?? ""));
    if (!b?.placeOrder) return res.status(400).json({ error: "Venue cannot place orders." });
    if (cfg.mode === "live" && body.confirmed !== true) {
      return res.status(412).json({ error: "LIVE order requires confirmed=true." });
    }
    try {
      res.json(await b.placeOrder(body));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const history = (req.body?.history ?? []) as ChatTurn[];
    if (!cfg.anthropic.apiKey) {
      return res.status(503).json({ error: "Jarvis chat is disabled — set ANTHROPIC_API_KEY." });
    }
    try {
      const reply = await chat(cfg, brokers, history);
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return app;
}
