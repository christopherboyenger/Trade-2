import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config, brokers, requireAuth } from "./_lib.js";
import { findBroker } from "../src/brokers/registry.js";
import type { OrderRequest } from "../src/types.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!requireAuth(req, res)) return;

  const body = (req.body ?? {}) as OrderRequest & { confirmed?: boolean };
  const b = findBroker(brokers, String(body.venue ?? ""));
  if (!b?.placeOrder) return res.status(400).json({ error: "Venue cannot place orders." });

  // Live orders require explicit confirmation, same gate as the agent tool.
  if (config.mode === "live" && body.confirmed !== true) {
    return res.status(412).json({ error: "LIVE order requires confirmed=true." });
  }
  try {
    res.json(await b.placeOrder(body));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
