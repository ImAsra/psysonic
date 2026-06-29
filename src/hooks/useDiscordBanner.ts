// src/hooks/useDiscordBanner.ts

import { useState, useEffect } from "react";

const STORAGE_KEY = "psysonic_discord_banner_dismissed";

interface UseDiscordBannerReturn {
  visible: boolean;
  dismiss: (permanent: boolean) => void;
}

export function useDiscordBanner(): UseDiscordBannerReturn {
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (!dismissed) setVisible(true);
  }, []);

  const dismiss = (permanent: boolean): void => {
    if (permanent) localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  return { visible, dismiss };
}