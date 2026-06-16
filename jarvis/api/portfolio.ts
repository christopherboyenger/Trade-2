import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config, brokers, requireAuth } from "./_lib.js";
import { aggregatePortfolio } from "../src/portfolio.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  try {
    res.json(await aggregatePortfolio(config, brokers));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
