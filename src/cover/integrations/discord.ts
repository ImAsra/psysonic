import { buildCoverArtUrlForServer } from '../../api/subsonicStreamUrl';
import { serverShareBaseUrl } from '../../utils/server/serverEndpoint';
import { getPlaybackServerId } from '../../utils/playback/playbackServer';
import { useAuthStore } from '../../store/authStore';
import type { CoverArtRef, CoverServerScope } from '../types';

/** The saved profile id that a cover scope resolves to (active/playback/server). */
function serverIdForScope(scope: CoverServerScope): string | null {
  if (scope.kind === 'server') return scope.serverId;
  if (scope.kind === 'playback') {
    return getPlaybackServerId() ?? useAuthStore.getState().activeServerId ?? null;
  }
  return useAuthStore.getState().activeServerId ?? null;
}

/**
 * Discord large image — an https:// URL Discord's own servers can reach.
 *
 * Unlike every other cover fetch we must NOT use the connect URL: that prefers
 * the LAN address (fast for the app itself), but Discord fetches the image
 * remotely, so a `http://192.168.x.x` address is unreachable and falls back to
 * the app icon. Discord is an external consumer just like a share link, so use
 * `serverShareBaseUrl` (public address preferred when both are set).
 */
export async function coverArtUrlForDiscord(ref: CoverArtRef): Promise<string | null> {
  const { serverScope, fetchCoverArtId } = ref;
  const serverId = serverIdForScope(serverScope);
  const profile = serverId
    ? useAuthStore.getState().servers.find(s => s.id === serverId)
    : undefined;

  if (profile) {
    return buildCoverArtUrlForServer(
      serverShareBaseUrl(profile),
      profile.username,
      profile.password,
      fetchCoverArtId,
      800,
    ) || null;
  }

  // Server scope carries its own URL/creds even when not a saved profile.
  if (serverScope.kind === 'server') {
    return buildCoverArtUrlForServer(
      serverShareBaseUrl({ url: serverScope.url }),
      serverScope.username,
      serverScope.password,
      fetchCoverArtId,
      800,
    ) || null;
  }

  return null;
}
