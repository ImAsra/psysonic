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
 * Tracks total accumulated app usage time across sessions, persisted to
 * localStorage. Counts time for as long as the app process is running,
 * regardless of window focus/visibility. Mount once near the app root
 * (e.g. AppShell).
 */
export function useAccumulatedUsage(): void {
  const lastTickRef = useRef<number | null>(null);

  useEffect(() => {
    lastTickRef.current = Date.now();

    const flush = (): void => {
      const now = Date.now();
      const delta = now - (lastTickRef.current ?? now);
      lastTickRef.current = now;
      addUsageMs(delta);
    };

    const interval = window.setInterval(flush, TICK_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, []);
}
