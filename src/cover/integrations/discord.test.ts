/**
 * coverArtUrlForDiscord — Discord fetches the large image from its own servers,
 * so the URL must use the public address, not the LAN-preferred connect URL
 * (regression from the dual-address feature).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeServer } from '@/test/helpers/factories';
import { useAuthStore } from '@/store/authStore';
import { coverArtUrlForDiscord } from './discord';
import type { CoverArtRef } from '../types';

function refForServer(serverId: string, url: string): CoverArtRef {
  return {
    cacheKind: 'album',
    cacheEntityId: 'al-1',
    fetchCoverArtId: 'al-1',
    serverScope: { kind: 'server', serverId, url, username: 'tester', password: 'pw' },
  };
}

beforeEach(() => {
  resetAllStores();
});

describe('coverArtUrlForDiscord', () => {
  it('uses the public address on a dual-address profile, not the LAN one', async () => {
    const server = makeServer({
      url: 'http://192.168.1.50:4533',
      alternateUrl: 'https://music.example.com',
    });
    useAuthStore.setState({ servers: [server], activeServerId: server.id } as never);

    const url = await coverArtUrlForDiscord(refForServer(server.id, server.url));

    expect(url).toContain('music.example.com');
    expect(url).not.toContain('192.168.1.50');
  });

  it('returns the single configured address when there is no alternate', async () => {
    const server = makeServer({ url: 'https://music.example.com', alternateUrl: undefined });
    useAuthStore.setState({ servers: [server], activeServerId: server.id } as never);

    const url = await coverArtUrlForDiscord(refForServer(server.id, server.url));

    expect(url).toContain('music.example.com');
  });
});
