import type { VercelRequest, VercelResponse } from "@vercel/node";
import { brokers, requireAuth } from "./_lib.js";
import { findBroker } from "../src/brokers/registry.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  const venue = String(req.query.venue ?? "");
  const symbol = String(req.query.symbol ?? "");
  const b = findBroker(brokers, venue);
  if (!b?.quote) return res.status(400).json({ error: `No quotes for venue '${venue}'.` });
  try {
    res.json(await b.quote(symbol));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
