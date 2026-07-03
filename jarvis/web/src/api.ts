// Tiny API client for the Jarvis serverless backend. The access token (private
// preview password) is kept in localStorage and sent on every protected call.

const TOKEN_KEY = "jarvis_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export interface Health {
  ok: boolean;
  authRequired: boolean;
  configured?: boolean;
  mode: "paper" | "live";
  jarvis: boolean;
  venues: { name: string; assetClass: string; configured: boolean }[];
}

export interface Position {
  venue: string;
  assetClass: string;
  symbol: string;
  quantity: number;
  avgPrice?: number;
  markPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
}

export interface VenueSnapshot {
  venue: string;
  assetClass: string;
  configured: boolean;
  connected: boolean;
  mode: "paper" | "live";
  balance?: { equity: number; cash?: number; buyingPower?: number };
  positions: Position[];
  error?: string;
}

export interface Portfolio {
  mode: "paper" | "live";
  asOf: string;
  totalEquity: number;
  totalUnrealizedPnl: number;
  venues: VenueSnapshot[];
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-access-token": getToken(),
      ...(init.headers ?? {}),
    },
  });
}

export async function getHealth(): Promise<Health> {
  const r = await fetch("/api/health");
  return r.json();
}

export async function getPortfolio(): Promise<Portfolio> {
  const r = await req("/api/portfolio");
  if (r.status === 401) throw new Error("unauthorized");
  if (!r.ok) throw new Error((await r.json()).error ?? "portfolio error");
  return r.json();
}

export async function postChat(history: ChatTurn[]): Promise<{ reply: string }> {
  const r = await req("/api/chat", { method: "POST", body: JSON.stringify({ history }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "chat error");
  return data;
}
