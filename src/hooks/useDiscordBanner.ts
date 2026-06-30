// src/hooks/useDiscordBanner.ts

import { useState } from "react";
import { getAccumulatedUsageMs } from "./useAccumulatedUsage";

const DISMISS_KEY = "psysonic_discord_banner_dismissed";
const USAGE_THRESHOLD_MS = 15 * 60 * 60 * 1000; // 15 hours
interface UseDiscordBannerReturn {
  visible: boolean;
  dismiss: (permanent: boolean) => void;
}

export function useDiscordBanner(): UseDiscordBannerReturn {
  const [visible, setVisible] = useState<boolean>(() => {
    const dismissed = localStorage.getItem(DISMISS_KEY) !== null;
    if (dismissed) return false;
    return getAccumulatedUsageMs() >= USAGE_THRESHOLD_MS;
  });

  const dismiss = (permanent: boolean): void => {
    if (permanent) localStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  };

  return { visible, dismiss };
}