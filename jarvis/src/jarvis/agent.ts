import Anthropic from "@anthropic-ai/sdk";
import type { Broker } from "../brokers/broker.js";
import type { Config } from "../config.js";
import { runTool, toolDefs } from "./tools.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

function systemPrompt(cfg: Config): string {
  return [
    "You are Jarvis, a personal AI trading assistant managing one portfolio across three venues:",
    "- stocks/ETFs via Alpaca",
    "- crypto via Freqtrade",
    "- prediction markets via Polymarket (read-only for now)",
    `The system is currently in ${cfg.mode.toUpperCase()} mode.`,
    "",
    "Use get_portfolio before answering questions about holdings, balance, or P&L — never guess numbers.",
    "When the user wants to trade:",
    "- In paper mode, you may place orders directly with place_order.",
    "- In LIVE mode, NEVER place an order without explicit user confirmation. First state the exact order",
    "  (venue, side, symbol, size) and ask the user to confirm. Only after they say yes, call place_order",
    "  with confirmed=true.",
    "Be concise and lead with the answer. Quote real numbers from tool results. Flag risk plainly.",
    "You are an assistant, not a fiduciary — remind the user that trading carries risk when they ask you to act.",
  ].join("\n");
}

/**
 * Run one Jarvis chat turn through a manual tool-use loop. The manual loop
 * (rather than the SDK auto tool-runner) is deliberate: it lets us enforce the
 * live-order confirmation gate and log every tool call.
 */
export async function chat(
  cfg: Config,
  brokers: Broker[],
  history: ChatTurn[],
): Promise<string> {
  if (!cfg.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — the Jarvis chat brain is disabled.");
  }

  const client = new Anthropic({ apiKey: cfg.anthropic.apiKey });

  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  // Bound the loop so a misbehaving tool cycle can't run forever.
  for (let step = 0; step < 8; step++) {
    const res = await client.messages.create({
      model: cfg.anthropic.model,
      max_tokens: 4096,
      // Adaptive thinking is the recommended mode for Opus 4.8. The pinned SDK
      // version only types enabled/disabled, so cast — the API accepts adaptive.
      thinking: { type: "adaptive" } as any,
      system: systemPrompt(cfg),
      tools: toolDefs,
      messages,
    });

    if (res.stop_reason !== "tool_use") {
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return text || "(no response)";
    }

    // Echo the assistant turn (including tool_use blocks) back into history.
    messages.push({ role: "assistant", content: res.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const out = await runTool(cfg, brokers, block.name, block.input);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return "Stopped after too many tool steps — please rephrase or narrow the request.";
}
