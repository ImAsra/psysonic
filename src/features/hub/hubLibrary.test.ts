import { beforeEach, describe, expect, it, vi } from 'vitest';

let activeServer = 'server-a';
let answerAlbum: (songs: unknown[]) => void = () => {};

vi.mock('@/lib/media/trackServerScope', () => ({ activeServerProfileId: () => activeServer }));
vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbum: () => new Promise(resolve => (answerAlbum = songs => resolve({ album: {}, songs }))),
  getAlbumList: vi.fn(),
  getSong: vi.fn(),
}));

const { hubPlayableTracks } = await import('./hubLibrary');

const song = (id: string, serverId?: string) => ({ id, title: id, artist: 'A', album: 'B', albumId: 'b', duration: 100, serverId });

describe('hubPlayableTracks', () => {
  beforeEach(() => {
    activeServer = 'server-a';
  });

  it('keeps the server the lookup went to, even when the user switches servers before it answers', async () => {
    const pending = hubPlayableTracks('album', 'al-1');
    activeServer = 'server-b';
    answerAlbum([song('s1'), song('s2')]);
    const tracks = await pending;
    expect(tracks.map(t => t.serverId)).toEqual(['server-a', 'server-a']);
  });

  it('a song that already names its server keeps it', async () => {
    const pending = hubPlayableTracks('album', 'al-1');
    answerAlbum([song('s1', 'server-c')]);
    expect((await pending)[0].serverId).toBe('server-c');
  });

  it('nothing is looked up without an id or for an unknown kind', async () => {
    expect(await hubPlayableTracks('album', '')).toEqual([]);
    expect(await hubPlayableTracks('artist', 'ar-1')).toEqual([]);
  });
});
