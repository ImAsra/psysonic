import { useEffect } from 'react';
import { startHubClient } from './hubClient';

/** Mount once (AppShell). No-op until the user enables the hub in Settings. */
export function useHubConnection() {
  useEffect(() => startHubClient(), []);
}
