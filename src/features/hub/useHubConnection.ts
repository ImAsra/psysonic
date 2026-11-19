import { useEffect } from 'react';
import { startHubClient, toHubWsUrl } from './hubClient';
import { useHubStore } from './hubStore';

/** Mount once (AppShell). Start the hub client only when it is configured and enabled. */
export function useHubConnection() {
  useEffect(() => {
    let stopClient: (() => void) | null = null;
    let startingClient = false;

    const syncConnection = () => {
      const { enabled, url, token } = useHubStore.getState();
      const shouldRun = enabled && !!token.trim() && !!toHubWsUrl(url);

      if (shouldRun && !stopClient && !startingClient) {
        startingClient = true;
        try {
          stopClient = startHubClient();
        } finally {
          startingClient = false;
        }
      } else if (!shouldRun && stopClient) {
        stopClient();
        stopClient = null;
        useHubStore.getState().setRuntime({
          status: 'off',
          devices: [],
          remoteState: null,
        });
      }
    };

    syncConnection();

    const unsubscribe = useHubStore.subscribe(syncConnection);

    return () => {
      unsubscribe();
      stopClient?.();
      stopClient = null;
    };
  }, []);
}
