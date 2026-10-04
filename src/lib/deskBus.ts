/**
 * deskBus.ts — tiny registry so any surface (web buttons, the Telegram chat
 * mock, later a websocket) can drive the *same* live trading loop in the page.
 */

import { useEffect, useState } from "react";

export interface DeskPosition {
  ticket: number;
  pair: string;
  dir: string;
  lots: number;
  entry: number;
  sl: number;
  tp: number;
}

export interface DeskStatus {
  running: boolean;
  tick: number;
  balance: number;
  peak: number;
  dailyPnl: number;
  drawdown: number;
  halted: boolean;
  haltReason: string;
  open: DeskPosition[];
  closedCount: number;
  wins: number;
  pairs: string[];
  limits: {
    riskPct: number;
    minConf: number;
    atrMult: number;
    tpMult: number;
    maxOpen: number;
    dailyLimit: number;
    ddLimit: number;
  };
}

export interface DeskProvider {
  status: () => DeskStatus | null;
  /** Execute one Telegram-style command and return the bot's reply text. */
  run: (text: string) => string;
}

let provider: DeskProvider | null = null;
const listeners = new Set<() => void>();

export function registerDesk(next: DeskProvider): () => void {
  provider = next;
  emit();
  return () => {
    if (provider === next) provider = null;
    emit();
  };
}

export function deskReady(): boolean {
  return provider !== null;
}

export function deskStatus(): DeskStatus | null {
  return provider ? provider.status() : null;
}

export function deskRun(text: string): string {
  if (!provider) return "⚠️ The desk is not mounted. Scroll up to section 00 and try again.";
  return provider.run(text);
}

export function emit(): void {
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-render the caller whenever the desk state changes. */
export function useDeskVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), []);
  return version;
}
