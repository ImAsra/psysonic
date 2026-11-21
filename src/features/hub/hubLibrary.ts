import { getAlbum, getAlbumList, getSong } from '@/lib/api/subsonicLibrary';
import { getArtist, getArtists } from '@/lib/api/subsonicArtists';
import { getPlaylist, getPlaylists } from '@/lib/api/subsonicPlaylists';
import { search } from '@/lib/api/subsonicSearch';
import { buildCoverArtUrl } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicAlbum, SubsonicArtist, SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { activeServerProfileId } from '@/lib/media/trackServerScope';
import type { Track } from '@/lib/media/trackTypes';

// Library browsing for hub remotes. A remote (the hub web page) has no music-server access of its
// own: it asks through the hub, this device looks it up on its active server and answers.

export const HUB_ALBUM_PAGE = 40;
export const HUB_ARTIST_PAGE = 200;
const ART_MAX_BYTES = 250_000;

type AlbumSort = 'newest' | 'recent' | 'frequent' | 'random' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'starred';

export interface HubBrowseRequest {
  kind: 'albums' | 'artists' | 'search' | 'album' | 'artist' | 'playlists' | 'playlist';
  id?: string;
  query?: string;
  sort?: AlbumSort;
  offset?: number;
}

export interface HubLibraryItem {
  id: string;
  name?: string;
  title?: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  coverArt?: string;
  year?: number;
  durationSec?: number;
  songCount?: number;
  albumCount?: number;
  track?: number;
  disc?: number;
}

export interface HubBrowseResult {
  item?: HubLibraryItem;
  albums?: HubLibraryItem[];
  artists?: HubLibraryItem[];
  songs?: HubLibraryItem[];
  playlists?: HubLibraryItem[];
  more?: boolean;
}

export const albumItem = (a: SubsonicAlbum): HubLibraryItem => ({
  id: a.id, name: a.name, artist: a.artist, artistId: a.artistId, coverArt: a.coverArt, year: a.year, songCount: a.songCount,
});
export const artistItem = (a: SubsonicArtist): HubLibraryItem => ({
  id: a.id, name: a.name, coverArt: a.coverArt, albumCount: a.albumCount,
});
export const playlistItem = (p: SubsonicPlaylist): HubLibraryItem => ({
  id: p.id, name: p.name, coverArt: p.coverArt, songCount: p.songCount, durationSec: p.duration,
});
export const songItem = (s: SubsonicSong): HubLibraryItem => ({
  id: s.id, title: s.title, artist: s.artist, artistId: s.artistId, album: s.album, albumId: s.albumId,
  coverArt: s.coverArt, durationSec: s.duration, track: s.track, disc: s.discNumber, year: s.year,
});

/** Answers one browse request from the active music server. */
export async function hubBrowse(req: HubBrowseRequest): Promise<HubBrowseResult> {
  switch (req.kind) {
    case 'albums': {
      const albums = await getAlbumList(req.sort ?? 'newest', HUB_ALBUM_PAGE, req.offset ?? 0);
      return { albums: albums.map(albumItem), more: albums.length === HUB_ALBUM_PAGE };
    }
    case 'artists': {
      const offset = req.offset ?? 0;
      const all = await getArtists();
      return {
        artists: all.slice(offset, offset + HUB_ARTIST_PAGE).map(artistItem),
        more: all.length > offset + HUB_ARTIST_PAGE,
      };
    }
    case 'search': {
      const r = await search(req.query ?? '', { albumCount: 20, artistCount: 10, songCount: 40 });
      return { artists: r.artists.map(artistItem), albums: r.albums.map(albumItem), songs: r.songs.map(songItem) };
    }
    case 'album': {
      const { album, songs } = await getAlbum(req.id ?? '');
      return { item: albumItem(album), songs: songs.map(songItem) };
    }
    case 'artist': {
      const { artist, albums } = await getArtist(req.id ?? '');
      return { item: artistItem(artist), albums: albums.map(albumItem) };
    }
    case 'playlists':
      return { playlists: (await getPlaylists()).map(playlistItem) };
    case 'playlist': {
      const { playlist, songs } = await getPlaylist(req.id ?? '');
      return { item: playlistItem(playlist), songs: songs.map(songItem) };
    }
  }
}

/** The tracks a remote's "play this album / playlist / song" refers to. */
export async function hubPlayableTracks(kind: unknown, id: unknown): Promise<Track[]> {
  if (typeof id !== 'string' || !id) return [];
  // The server the lookup goes to: tracks keep it even if the user switches servers meanwhile.
  const serverId = activeServerProfileId();
  const toTrack = (song: SubsonicSong): Track => songToTrack({ ...song, serverId: song.serverId ?? serverId });
  if (kind === 'album') return (await getAlbum(id)).songs.map(toTrack);
  if (kind === 'playlist') return (await getPlaylist(id)).songs.map(toTrack);
  if (kind === 'song') {
    const song = await getSong(id);
    return song ? [toTrack(song)] : [];
  }
  return [];
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Artwork for a remote's library page, or null when there is none. */
export async function hubArtwork(coverArt: string, size: number): Promise<{ mime: string; data: string } | null> {
  try {
    const resp = await fetch(buildCoverArtUrl(coverArt, size));
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (blob.size > ART_MAX_BYTES || !/^image\/(jpeg|png|webp)$/.test(blob.type)) return null;
    return { mime: blob.type, data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
  } catch {
    return null;
  }
}
