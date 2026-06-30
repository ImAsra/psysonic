// src/hooks/useAccumulatedUsage.ts

import { useEffect, useRef } from "react";

const STORAGE_KEY = "psysonic_accumulated_usage_ms";
const TICK_MS = 30_000; // flush every 30s

export function getAccumulatedUsageMs(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function addUsageMs(deltaMs: number): void {
  const current = getAccumulatedUsageMs();
  localStorage.setItem(STORAGE_KEY, String(current + deltaMs));
}

/**
 * Tracks accumulated foreground usage time across sessions, persisted to
 * localStorage. Only counts time while the document is visible (not
 * minimized/backgrounded) so it reflects actual usage, not idle uptime.
 * Mount once near the app root (e.g. AppShell).
 */
export function useAccumulatedUsage(): void {
  const lastTickRef = useRef<number | null>(null);

  useEffect(() => {
    lastTickRef.current = Date.now();

    const flush = (): void => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const delta = now - (lastTickRef.current ?? now);
      lastTickRef.current = now;
      addUsageMs(delta);
    };

    const interval = window.setInterval(flush, TICK_MS);

    const onVisibilityChange = (): void => {
      // Reset the tick reference so backgrounded time isn't counted once
      // visibility returns.
      lastTickRef.current = Date.now();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}