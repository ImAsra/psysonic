import { beforeEach, describe, expect, it, vi } from 'vitest';

const active = vi.hoisted(() => ({ server: null as null | { url: string; alternateUrl?: string; username?: string } }));

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ getActiveServer: () => active.server }) },
}));

import { currentServerKeys } from './hubServerKeys';

describe('currentServerKeys', () => {
  beforeEach(() => {
    active.server = null;
  });

  it('returns nothing without an active server', async () => {
    expect(await currentServerKeys()).toEqual([]);
  });

  it('gives the same key whatever the case of the user name', async () => {
    active.server = { url: 'https://music.example.test', username: 'Listener' };
    const upper = await currentServerKeys();
    active.server = { url: 'https://music.example.test', username: ' listener ' };
    const lower = await currentServerKeys();
    expect(upper).toHaveLength(1);
    expect(lower).toEqual(upper);
  });

  it('still tells different accounts apart', async () => {
    active.server = { url: 'https://music.example.test', username: 'listener' };
    const a = await currentServerKeys();
    active.server = { url: 'https://music.example.test', username: 'guest' };
    expect(await currentServerKeys()).not.toEqual(a);
  });

  it('hashes the alternate address too', async () => {
    active.server = { url: 'https://music.example.test', alternateUrl: 'http://192.0.2.10:4533/', username: 'listener' };
    const keys = await currentServerKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
  });
});
