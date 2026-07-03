import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config as appConfig, brokers, requireAuth } from "./_lib.js";
import { chat as runChat, type ChatTurn } from "../src/jarvis/agent.js";

// The Jarvis tool-use loop can take longer than the default 10s. 60s needs a
// Vercel plan that allows it (Pro / fluid compute); on Hobby it caps at 10s.
export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!requireAuth(req, res)) return;
  if (!appConfig.anthropic.apiKey) {
    return res.status(503).json({ error: "Jarvis chat disabled — set ANTHROPIC_API_KEY." });
  }
  const history = (req.body?.history ?? []) as ChatTurn[];
  try {
    const reply = await runChat(appConfig, brokers, history);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
