/**
 * botApi.ts — typed client for the Python control plane (api_server.py).
 *
 * Every call is same-origin ("/api/..."): in dev, Vite proxies it to
 * 127.0.0.1:8787, so the dashboard keeps working inside remote previews
 * where "localhost" would mean the *viewer's* machine, not the bot host.
 *
 * Nothing here contains trading logic. The browser can only ask the bot to
 * do things the risk manager already permits — the same gates Telegram hits.
 */

export interface RiskStats {
  balance: number;
  peak_balance: number;
  daily_pnl: number;
  drawdown_pct: number;
  open_positions: number;
  closed_trades: number;
  win_rate_pct: number;
  gross_profit: number;
  gross_loss: number;
  halted: boolean;
  halt_reason: string;
}

export interface AccountInfo {
  login: number | null;
  server: string | null;
  currency: string;
  verified: boolean;
  paper: boolean;
}

export interface BotStatus {
  api_version: string;
  server_time: string;
  running: boolean;
  mode: "idle" | "paper" | "live" | string;
  started_at: string | null;
  last_error: string;
  live_allowed: boolean;
  live_lock_reason: string;
  paused: boolean;
  ticks: number;
  signals_seen?: number;
  rejected?: number;
  status_line: string;
  risk: Partial<RiskStats>;
  account: Partial<AccountInfo>;
}

export interface PositionRow {
  pair: string;
  direction: string;
  lots: number;
  open_price: number;
  stop_loss: number;
  take_profit: number;
  open_time: string;
  ticket: number;
  comment?: string;
  current_price?: number | null;
  unrealised_pnl?: number | null;
}

export interface LogLine {
  id: number;
  time: string;
  level: string;
  message: string;
}

export interface SignalRow {
  time: string;
  pair: string;
  signal: string;
  actionable: boolean;
  price: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  score: number;
  risk_reward: number;
  reasons: string[];
  indicators: Record<string, number | null>;
}

export interface AnalyzeResult {
  ok: boolean;
  dry_run: boolean;
  gate_open: boolean;
  gate_reason: string;
  results: Array<{
    pair: string;
    signal?: string;
    price?: number;
    stop_loss?: number;
    take_profit?: number;
    confidence?: number;
    score?: number;
    risk_reward?: number;
    reasons?: string[];
    would_trade?: boolean;
    lots?: number;
    verdict?: string;
    error?: string;
  }>;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

/** Token is optional; only needed when the server was started with --token. */
let apiToken = "";

/** Set the shared secret used for every subsequent request. */
export function setApiToken(token: string): void {
  apiToken = token;
}

function headers(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiToken) h["X-API-Token"] = apiToken;
  return h;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: headers() });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Bad JSON from ${path}: ${text.slice(0, 120)}`);
  }
  if (!res.ok && res.status !== 409) {
    const msg = (parsed as { message?: string })?.message ?? res.statusText;
    throw new Error(msg);
  }
  return parsed as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const botApi = {
  health: () => get<{ ok: boolean; version: string }>("/api/health"),
  status: () => get<BotStatus>("/api/status"),
  config: () => get<Record<string, unknown>>("/api/config"),
  positions: () => get<{ positions: PositionRow[] }>("/api/positions"),
  signals: (limit = 25) => get<{ signals: SignalRow[] }>(`/api/signals?limit=${limit}`),
  logs: (limit = 200, after = 0) =>
    get<{ lines: LogLine[] }>(`/api/logs?limit=${limit}&after=${after}`),

  start: (mode: "paper" | "live" = "paper") => post<ActionResult>("/api/start", { mode }),
  stop: () => post<ActionResult>("/api/stop"),
  pause: () => post<ActionResult>("/api/pause"),
  unpause: () => post<ActionResult>("/api/unpause"),
  halt: (reason = "dashboard") => post<ActionResult>("/api/halt", { reason }),
  resume: () => post<ActionResult>("/api/resume"),
  tick: () => post<ActionResult>("/api/tick"),
  analyze: () => post<AnalyzeResult>("/api/analyze"),
  close: (ticket: number | "all") => post<ActionResult>("/api/close", { ticket }),
  backtest: (pair?: string, bars = 4000, spread = 1.5) =>
    post<ActionResult>("/api/backtest", { pair, bars, spread }),
};

/**
 * Subscribe to the server-sent status stream.
 *
 * Falls back to nothing if EventSource is unavailable; callers should also
 * poll {@link botApi.status} so the UI still updates.
 *
 * @returns an unsubscribe function.
 */
export function subscribeToBot(
  onSnapshot: (snap: { status: BotStatus; positions: PositionRow[]; logs: LogLine[] }) => void,
  onError?: () => void,
): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const url = apiToken ? `/api/events?token=${encodeURIComponent(apiToken)}` : "/api/events";
  const source = new EventSource(url);
  source.onmessage = (event) => {
    try {
      onSnapshot(JSON.parse(event.data));
    } catch {
      /* ignore malformed frame */
    }
  };
  source.onerror = () => {
    onError?.();
    source.close();
  };
  return () => source.close();
}
