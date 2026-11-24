import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { hubDeviceKind } from './deviceKind';
import {
  flushPlayQueuePosition,
  flushQueueSyncToServer,
  setQueueServerWriteGate,
} from '@/features/playback/store/queueSync';
import { isPlayQueueSyncEnabled } from '@/features/playback/store/playQueueSyncSettingsStore';
import { getPlayQueueForServer, savePlayQueue } from '@/lib/api/subsonicPlayQueue';
import { songToTrack } from '@/lib/media/songToTrack';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import {
  applyMappedQueue,
  applyMappedQueueProjection,
  fingerprintFromLocalQueue,
  fingerprintFromServer,
  playQueueFingerprintsEqual,
  applyServerPlayQueue,
} from '@/features/playback/store/applyServerPlayQueue';
import {
  clearQueueNaturallyEnded,
  clearQueuePushFailed,
  resumeIdleQueuePull,
} from '@/features/playback/store/queuePlaybackIdle';
import { getQueueTracksView } from '@/features/playback/store/queueTrackView';
import {
  getCachedTrack,
  resolveBatch,
  subscribeQueueResolver,
} from '@/features/playback/store/queueTrackResolver';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { profileIdFromQueueRef } from '@/lib/media/trackServerScope';
import { queueIsMultiServer } from '@/features/playback/utils/playback/playbackServer';
import { getIsAudioPaused, setIsAudioPaused } from '@/features/playback/store/engineState';
import { audioSeek } from '@/lib/api/audio';
import {
  emitPlaybackProgress,
  subscribePlaybackProgress,
  subscribePlaybackSeek,
} from '@/features/playback/store/playbackProgress';
import { useHubStore } from './hubStore';
import type { HubDevice, HubRemoteState } from './hubStore';
import { getHubRemote, remotePosition } from './useHubRemote';
import { createSettingsSync } from './hubSettingsSync';
import { buildCoverArtUrl } from '@/lib/api/subsonicStreamUrl';
import { showToast } from '@/lib/dom/toast';
import { currentServerKeys } from './hubServerKeys';
import { deviceCompatible } from './compat';
import { hubQueueWindow, resolveQueueMove, resolveQueuePlayIndex } from './hubQueue';
import {
  chunkIds,
  chunkPositions,
  createAddCollector,
  pickQueueRefs,
  positionsStillMatch,
  readPositions,
  type QueueAdd,
  type QueueAddMode,
} from './hubQueueEdits';
import { hubArtwork, hubBrowse, hubPlayableTracks, type HubBrowseRequest } from './hubLibrary';

/**
 * Optional realtime hub client (psysonic-hub). Does nothing unless the user
 * enabled it AND entered a hub URL + token in Settings. The existing Subsonic
 * play-queue sync keeps running untouched; this only adds a push channel.
 */

const PROTOCOL = 1;
const HEARTBEAT_MS = 5_000;
const CATCH_UP_RETRY_MS = 5_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** http(s)://host:port -> ws(s)://host:port/ws ; accepts ws(s):// as-is. */
export function toHubWsUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    else if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
    return u.toString();
  } catch {
    return null;
  }
}

let hubSender: ((msg: unknown) => void) | null = null;

/**
 * Off hub control (hubStore.joined): this device only watches. It joins like a web page under its own
 * id, so the hub never takes it for the player, and sends nothing after its hello.
 */
const watching = () => !useHubStore.getState().joined;
export const watcherId = (deviceId: string) => `${deviceId}-watch`;

/** Bumped whenever the hub is switched on or off or hub control changes; work started before it is stale. */
let membership = 0;
/**
 * Back under hub control, but the shared queue has not loaded here yet: the local queue is still the one
 * this device kept on its own, so nothing may save it to the server until a load succeeds.
 */
let queueBehind = false;

/** Another device is the player. The player owns the shared queue: only it saves it. */
const anotherDevicePlays = () => {
  const { devices, deviceId } = useHubStore.getState();
  return devices.some(d => d.active && d.id !== deviceId && d.kind !== 'web');
};

/** A click-to-play here hands a new queue to the player: the hub holds the player back until it is saved. */
let handingOver = false;

/**
 * Nothing may overwrite the shared server queue while this device plays on its own, is still catching
 * up, or another device is the player (edits made here go to that player as commands instead).
 */
const queueWritesAllowed = () => {
  const { enabled, joined } = useHubStore.getState();
  return !enabled || (joined && !queueBehind && (handingOver || !anotherDevicePlays()));
};

/** Queue edits made here are sent to the player instead of being applied and saved here. */
const queueOwnedElsewhere = () => {
  const { enabled, joined, status } = useHubStore.getState();
  return enabled && joined && status === 'connected' && anotherDevicePlays();
};

/** Whether this device's own player is playing (for the Hub control switch). */
export const isPlayingHere = () => usePlayerStore.getState().isPlaying;

/**
 * Back under hub control. "join": stop here and control what the hub plays. "playHere": keep playing;
 * on rejoining this device reports it is playing, so the hub makes it the player and pauses the other.
 */
export function rejoinHub(choice: 'join' | 'playHere' = 'playHere'): void {
  if (choice === 'join' && usePlayerStore.getState().isPlaying) usePlayerStore.getState().pause();
  useHubStore.getState().setJoined(true);
}

/** Ask the hub to move playback to another device (this one included). */
export function hubTransferTo(deviceId: string) {
  hubSender?.({ t: 'transfer', to: deviceId });
}

/** Send a playback command (toggle, next, prev, seek, volume...) to the active remote device. */
export function hubCommand(action: string, args: Record<string, unknown> | null = null) {
  const { devices, deviceId } = useHubStore.getState();
  const to = devices.find(d => d.active && d.id !== deviceId && d.kind !== 'web')?.id;
  if (to) hubSender?.({ t: 'command', to, action, args });
}

/**
 * Another device is taking over: pause, push our queue + position to the
 * Subsonic server, then tell the hub we are done so it can start the target.
 */
async function handleYield(to: string, send: (m: unknown) => void) {
  let ok = true;
  let reason: string | undefined;
  try {
    const p = localPlayer();
    if (p.isPlaying) p.pause(); // freezes our clock at the true pause position
    // Make the shared progress clock exact so the saved queue position is right too.
    emitMine(clockNow(), p.currentTrack?.duration ?? 0, 0);
    if (!isPlayQueueSyncEnabled()) {
      ok = false; reason = 'queue_sync_disabled'; // without queue sync the target cannot get our queue
    } else if (!(await flushPlayQueuePosition())) {
      ok = false; reason = 'queue_save_failed';
    }
  } catch (e) {
    console.error('[psysonic-hub] yield failed', e);
    ok = false; reason = 'queue_save_failed';
  } finally {
    // ok:false makes the hub cancel the transfer (and tell us to carry on) instead of
    // letting the other device load a queue that was never saved.
    send({ t: 'yielded', to, ok, reason });
  }
}

/** While true, player actions are never routed to the remote (we are applying things locally). */
let forceLocal = false;
/** A takeover is being handled: this device loads the handed-over queue and must not save its own meanwhile. */
let takingOver = 0;
/** While true, the remote position is not pushed into the shared progress clock. */
let holdProgress = false;

/**
 * Like pullPlayQueueFromServer but WITHOUT pushing a queue-undo entry: a device
 * switch is not a user queue edit, so Ctrl+Z must not roll it back.
 */
async function pullQueueForTakeover(serverId: string, positionFor?: { trackId: string; seconds: number }) {
  if (!isPlayQueueSyncEnabled()) return 'noop' as const;
  clearQueueNaturallyEnded();
  const result = await applyServerPlayQueue(serverId, {
    mode: 'manual',
    preferServerPosition: true,
    pushUndo: false,
    positionFor,
    // The takeover decides how the engine gets there (see handleTakeover): a second load started
    // here would still be running when Play comes, and would start the track from the top.
    prepareEngine: false,
  });
  if (result === 'applied' || result === 'noop') {
    resumeIdleQueuePull();
    clearQueuePushFailed(serverId);
  }
  return result;
}

/**
 * A queue that also holds another server's entries keeps its current entry through a pull, even
 * when that entry is a leftover from that other server. On a takeover the handed-over track must
 * play, so move to it: the track the hub reported, or (click-to-play handoff, where the hub's
 * "now playing" is still the old one) the current track of the server queue. The position is set
 * by the caller.
 */
async function landOnHandedOverTrack(serverId: string, hubTrackId: string | null, atSeconds = 0) {
  if (!queueIsMultiServer()) return; // a single-server pull already lands on the server's current track
  const owner = resolveServerIdForIndexKey(serverId) || serverId;
  const wanted = hubTrackId ?? (await getPlayQueueForServer(owner)).current ?? null;
  if (!wanted) return;
  const s = usePlayerStore.getState();
  const isWanted = (ref: QueueItemRef | undefined) => profileIdFromQueueRef(ref) === owner && ref?.trackId === wanted;
  if (isWanted(s.queueItems[s.queueIndex]) && s.currentTrack?.id === wanted) return;
  const index = s.queueItems.findIndex(isWanted);
  const track = index >= 0 ? getQueueTracksView(s.queueItems)[index] : undefined;
  if (!track) return;
  if (s.isPlaying) {
    localPlayer().playTrack(track, undefined, undefined, undefined, index);
    return;
  }
  // The engine is loaded by the takeover's resume (cold, at currentTime).
  usePlayerStore.setState({ queueIndex: index, currentTrack: track, currentTime: atSeconds });
}

/** A handed-over track that starts more than this far before the hub's position is moved there. */
const CATCH_UP_SLACK_SEC = 2;
const CATCH_UP_WINDOW_MS = 10_000;

/**
 * If the engine had already loaded the track at the server's older position, Play resumes from there.
 * Once audio really runs (a seek then sticks), move it to where the previous device stopped.
 */
function catchUpOnceAudible(track: Track, atSeconds: number) {
  let done = false;
  const finish = () => {
    done = true;
    unsubProgress();
    unsubSeek();
    clearTimeout(timer);
  };
  // Watch the whole window: an early tick can still show the restored position before audio starts
  // somewhere else. Any seek (the user's, or this one) ends the watch.
  const unsubProgress = subscribePlaybackProgress(next => {
    if (done || emittingMine) return;
    const p = usePlayerStore.getState();
    if (p.currentTrack?.id !== track.id) return finish();
    if (!p.isPlaying || track.duration <= 0) return;
    if (next.currentTime < atSeconds - CATCH_UP_SLACK_SEC) {
      finish();
      localPlayer().seek(Math.min(track.duration - 0.5, atSeconds) / track.duration);
    }
  });
  const unsubSeek = subscribePlaybackSeek(() => { if (!done) finish(); });
  const timer = setTimeout(finish, CATCH_UP_WINDOW_MS);
}

async function handleTakeover(
  hubState: HubRemoteState | null,
  ageMs: number,
  fresh: boolean,
  sourceKeys: string[],
  send: (m: unknown) => void,
) {
  const fail = (reason: string) => send({ t: 'takeover-failed', reason });
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return fail('queue_unavailable');
  if (!isPlayQueueSyncEnabled()) return fail('queue_sync_disabled');
  // The hub already checked; check again here, so a handoff can never load another account's queue.
  if (useHubStore.getState().serverCheck && sourceKeys.length) {
    const mine = await currentServerKeys();
    if (mine.length && !sourceKeys.some(k => mine.includes(k))) return fail('server_mismatch');
  }
  forceLocal = true;
  try {
    // The server only has the position the previous device last saved; the hub knows where it stopped.
    // Load the engine there right away, so playback does not start at the older position first.
    const hubSec = hubState?.positionSec;
    const positionFor = !fresh && hubState?.trackId && typeof hubSec === 'number' && Number.isFinite(hubSec)
      ? { trackId: hubState.trackId, seconds: hubSec + (hubState.playing ? Math.max(0, ageMs) / 1000 : 0) }
      : undefined;
    // Loaded paused while another device played (an idle pull does that), and with which track.
    const engineLoaded = getIsAudioPaused();
    const loadedTrackId = usePlayerStore.getState().currentTrack?.id;
    const result = await pullQueueForTakeover(serverId, positionFor);
    if (result !== 'applied' && result !== 'noop') return fail('queue_unavailable');
    queueBehind = false; // the shared queue is loaded here now
    await landOnHandedOverTrack(serverId, fresh ? null : hubState?.trackId ?? null, positionFor?.seconds ?? 0);
    const player = localPlayer();
    setClock(player.currentTime, false); // position the server queue gave us
    tickGuardUntil = Date.now() + 1500;

    // The Subsonic server only has the position the previous device last SAVED.
    // The hub has the exact position it reported when it yielded, so prefer that
    // when it is the same track (avoids the time jumping back on switch).
    const track = player.currentTrack;
    let handedOverAt: number | null = null;
    if (!fresh && hubState?.trackId && track && track.id === hubState.trackId
        && Number.isFinite(hubState.positionSec) && track.duration > 0) {
      const sec = (hubState.positionSec ?? 0) + (hubState.playing ? Math.max(0, ageMs) / 1000 : 0);
      const target = Math.max(0, Math.min(track.duration - 0.5, sec));
      handedOverAt = target;
      setClock(target, false);
      usePlayerStore.setState({ currentTime: target, progress: target / track.duration });
    }
    // The pull did not touch the engine. If it already holds this track (loaded paused while
    // another device played, at the position saved back then), move it to the hand-over position
    // and resume it warm: a fully loaded engine takes the seek. Otherwise Play loads the track
    // once, directly at currentTime (cold resume).
    if (engineLoaded && track && loadedTrackId === track.id) {
      try {
        await audioSeek({ seconds: usePlayerStore.getState().currentTime });
      } catch (e) {
        console.error('[psysonic-hub] seek before resume failed', e);
      }
    } else {
      setIsAudioPaused(false);
    }

    markQueueApplied();
    emitMine(clockNow(), localPlayer().currentTrack?.duration ?? 0, 0);
    if (track && handedOverAt !== null) catchUpOnceAudible(track, handedOverAt);
    localPlayer().resume();
  } catch (e) {
    console.error('[psysonic-hub] takeover failed', e);
    fail('queue_unavailable');
  } finally {
    forceLocal = false;
  }
}

/** Tell the user why a handoff did not happen. */
const TRANSFER_FAILED: Record<string, string> = {
  server_mismatch: 'That device uses a different music server or account, so playback cannot move there.',
  timeout: 'The playing device did not answer in time. The transfer was cancelled.',
  queue_save_failed: 'The playing device could not save its queue. The transfer was cancelled.',
  queue_sync_disabled: 'Turn on play queue sync on both devices to hand playback over.',
  queue_unavailable: 'The other device could not load the queue.',
  device_cannot_play: 'That device cannot play audio.',
};
const reportTransferFailed = (reason: string) =>
  showToast(TRANSFER_FAILED[reason] ?? 'The transfer did not go through.', 6000, 'error');

// ---------------------------------------------------------------------------
// Local playback clock. The position we REPORT must be the true local position.
// The shared progress snapshot can be stale right after a handoff (and in remote
// mode it carries the other device's position), so we keep our own clock that is
// only moved by trusted events: real engine ticks, seeks, pause/resume, track changes.
// ---------------------------------------------------------------------------
// `live` = real engine ticks are flowing. Until the first tick after a resume or seek,
// the audio may still be loading, so the clock must NOT advance (that was the
// "few seconds ahead after a quick switch" drift).
let clock = { sec: 0, at: Date.now(), playing: false, live: false };
let tickGuardUntil = 0; // ignore stale pre-seek ticks briefly after a seek/handoff
let emittingMine = false;

const clockNow = () => clock.sec + (clock.playing && clock.live ? (Date.now() - clock.at) / 1000 : 0);
const setClock = (sec: number, playing = usePlayerStore.getState().isPlaying) => {
  clock = { sec: Math.max(0, sec), at: Date.now(), playing, live: false };
};

/** Write to the shared progress clock (waveform / time display) without feeding it back into ours. */
function emitMine(sec: number, durationSec: number, buffered = 1) {
  emittingMine = true;
  try {
    emitPlaybackProgress({ currentTime: sec, progress: durationSec > 0 ? sec / durationSec : 0, buffered });
  } finally {
    emittingMine = false;
  }
}

// ---------------------------------------------------------------------------
// Live queue sync. The queue itself travels through the Subsonic play queue;
// the hub only says "the queue changed, go look". Whoever edits the queue pushes
// it to the server right away and signals; the others merge it in WITHOUT touching
// what is currently playing (projection merge).
// ---------------------------------------------------------------------------
let lastAppliedQueue: unknown = null;
/** Remember the current queue array as "not a user edit" so it is not pushed back. */
function markQueueApplied() {
  lastAppliedQueue = usePlayerStore.getState().queueItems;
}

/** The queue went from tracks to none through an edit here, and that is not saved yet. */
let queueCleared = false;

/** Save this device's queue as the shared one and tell the others. Only the player (or, with none, anyone) may. */
async function pushQueueAndSignal() {
  // On its own, this device's queue is its own business: saving it would overwrite the shared one.
  if (watching() || takingOver || !queueWritesAllowed() || !isPlayQueueSyncEnabled() || useHubStore.getState().status !== 'connected') return;
  const p = usePlayerStore.getState();
  try {
    if (p.queueItems.length === 0) {
      // Only a queue someone just cleared is saved empty. An empty queue that was never filled
      // (a device that just started) must not wipe the shared one.
      if (!queueCleared) return;
      // The flush below would skip an empty queue (and cancel the pending clear), so the others
      // would pull the old one. Save it empty right away.
      const profileId = activeProfileId();
      if (!profileId) return;
      await savePlayQueue([], undefined, undefined, profileId);
      queueCleared = false;
    } else {
      await flushQueueSyncToServer(p.queueItems, p.currentTrack, clockNow());
    }
    hubSender?.({ t: 'queue-changed' });
  } catch (e) {
    console.error('[psysonic-hub] queue push failed', e);
  }
}

/**
 * @param emptyClears the player signalled a change: an empty shared queue means it cleared its queue,
 *   so clear here too. On a catch-up an empty shared queue only means nothing is shared yet.
 * @returns true when the local queue now matches the shared one (loaded, already equal, or none shared).
 */
async function refreshQueueFromServer(emptyClears = false): Promise<boolean> {
  if (!isPlayQueueSyncEnabled()) return true; // nothing is shared, so nothing to catch up with
  if (forceLocal) return false;
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return false;
  const profileId = resolveServerIdForIndexKey(serverId) || serverId;
  const startedIn = membership;
  try {
    const q = await getPlayQueueForServer(profileId);
    if (startedIn !== membership) return false; // hub control changed meanwhile: this answer is not for us now
    // Tracks and current track only: the playing device saves a new position with every push, and
    // re-applying an unchanged queue for that would make a fresh queue array each time.
    if (q.songs.length > 0
        && !playQueueFingerprintsEqual(fingerprintFromServer(q), fingerprintFromLocalQueue(), Infinity)) {
      const mapped = q.songs.map(song => ({ ...songToTrack(song), serverId: profileId }));
      // The store notifies its subscribers inside setState, before markQueueApplied below runs:
      // without forceLocal the queue taken from the server would count as a user edit and be
      // saved and signalled again, and every device would answer every other one.
      forceLocal = true;
      try {
        applyMappedQueueProjection(mapped, q, profileId, false);
      } finally {
        forceLocal = false;
      }
      markQueueApplied();
    } else if (q.songs.length === 0 && emptyClears && usePlayerStore.getState().queueItems.length > 0) {
      forceLocal = true;
      try {
        usePlayerStore.setState({ queueItems: [], queueIndex: 0 });
      } finally {
        forceLocal = false;
      }
      markQueueApplied();
    }
    queueBehind = false;
    return true;
  } catch (e) {
    console.error('[psysonic-hub] queue refresh failed', e);
    return false;
  }
}

function snapshot(): Record<string, unknown> {
  const p = usePlayerStore.getState();
  const t = p.currentTrack;
  return {
    trackId: t?.id,
    title: t?.title,
    artist: t?.artist,
    album: t?.album,
    albumId: t?.albumId,
    artistId: t?.artistId,
    coverArt: t?.coverArt,
    durationSec: t?.duration,
    positionSec: clockNow(),
    playing: p.isPlaying,
    volume: p.volume,
    shuffle: p.shuffleMode,
    repeat: p.repeatMode,
  };
}

// ---------------------------------------------------------------------------
// Remote mode: while another device is the active player, the normal player
// store actions (buttons, waveform seek, media keys...) are routed to that
// device through the hub instead of controlling the local player.
// ---------------------------------------------------------------------------
type Action = (...args: never[]) => unknown;
const callAction = (fn: Action, args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);

/** What the hub sends us (fields differ per message type). */
interface HubMsg {
  t?: string;
  state?: HubRemoteState | null;
  devices?: HubDevice[];
  args?: Record<string, unknown> | null;
  ageMs?: number;
  fresh?: boolean;
  [key: string]: unknown;
}
const ACTIONS = ['togglePlay', 'resume', 'pause', 'next', 'previous', 'seek', 'setVolume', 'playTrack',
  'toggleShuffleMode', 'toggleRepeat'] as const;
/** Queue edits: sent to the player whenever another device plays (see queueOwnedElsewhere). */
const QUEUE_ACTIONS = ['enqueue', 'enqueueAt', 'playNext', 'enqueueRadio', 'removeTrack', 'removeQueueItems',
  'moveQueueItems', 'reorderQueue', 'clearQueue', 'clearQueueExceptCurrent', 'pruneUpcomingToCurrent',
  'shuffleQueue', 'shuffleUpcomingQueue', 'undoLastQueueEdit', 'redoLastQueueEdit'] as const;
let originals: Record<string, Action> | null = null;

/** The real local player (bypasses the remote-mode routing). */
function localPlayer() {
  const p = usePlayerStore.getState();
  return originals ? ({ ...p, ...originals } as typeof p) : p;
}

/** Optimistic update so the bar reacts instantly; the remote's real state corrects it. */
function patchRemote(patch: Partial<HubRemoteState>) {
  const { remoteState, remoteStateAt, setRuntime } = useHubStore.getState();
  if (!remoteState) return;
  const now = Date.now();
  setRuntime({
    remoteState: { ...remoteState, positionSec: remotePosition(remoteState, remoteStateAt, now), ...patch },
    remoteStateAt: now,
  });
}

/**
 * A song was clicked while another device is the active player: put it (and its
 * queue) into the shared Subsonic play queue WITHOUT playing it here, then tell
 * the active device to load that queue and start it. Like Spotify, the click
 * controls the active device instead of stealing playback.
 */
async function remotePlayTrack(track: Track, queue?: Track[]) {
  const remote = getHubRemote();
  const serverId = useAuthStore.getState().activeServerId;
  if (!remote || !serverId) return;
  const { devices, deviceId, serverCheck } = useHubStore.getState();
  if (!deviceCompatible(devices.find(d => d.id === deviceId), remote.device, serverCheck)) {
    reportTransferFailed('server_mismatch');
    return;
  }
  forceLocal = true;
  holdProgress = true;
  try {
    const current = getQueueTracksView(usePlayerStore.getState().queueItems);
    let tracks = queue && queue.length ? queue : current;
    if (!tracks.some(t => t.id === track.id)) tracks = [track];
    // Silent: replaces the local queue and parks on `track` at 0:00 without audio.
    applyMappedQueue(tracks, { current: track.id, position: 0, songs: [] }, serverId, true, 0);
    markQueueApplied();
    queueBehind = false; // the queue picked here is meant to replace the shared one
    emitMine(0, track.duration ?? 0, 0);

    handingOver = true;
    let saved: boolean;
    try {
      saved = await flushPlayQueuePosition();
    } finally {
      handingOver = false;
    }
    if (!saved) {
      reportTransferFailed('queue_save_failed');
      return;
    }

    hubSender?.({ t: 'transfer', to: remote.device.id, fresh: true });
    patchRemote({
      trackId: track.id, title: track.title, artist: track.artist, album: track.album,
      albumId: track.albumId, artistId: track.artistId, coverArt: track.coverArt,
      durationSec: track.duration, positionSec: 0, playing: true,
    });
  } catch (e) {
    console.error('[psysonic-hub] remote play failed', e);
  } finally {
    forceLocal = false;
    holdProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Queue edits on a remote. The player owns the shared queue and is the only one
// that saves it, so an edit made here is sent to the player as a command. The
// player applies it with its own queue actions, saves, and signals queue-changed;
// this device then pulls the result like every other one. Moves and removals are
// also shown here right away so a drag does not snap back while that happens.
// ---------------------------------------------------------------------------
const activeProfileId = () => {
  const serverId = useAuthStore.getState().activeServerId;
  return serverId ? resolveServerIdForIndexKey(serverId) || serverId : null;
};

let addBatch = 0;
/** Send tracks to add to the player's queue. Tracks of another music server are left out (the player cannot find them). */
function sendQueueAdd(mode: QueueAddMode, tracks: Track[], at = 0) {
  const own = activeProfileId();
  const ids = tracks
    .filter(t => !t.serverId || (resolveServerIdForIndexKey(t.serverId) || t.serverId) === own)
    .map(t => t.id);
  if (!ids.length) return;
  const batch = `${Date.now().toString(36)}-${++addBatch}`;
  const parts = chunkIds(ids, { batch, part: 999, parts: 999, mode, at });
  parts.forEach((part, k) => hubCommand('queueAdd', { batch, part: k, parts: parts.length, mode, at, ids: part }));
}

/** Queue positions with the track each one holds now, so the player can tell when its queue changed meanwhile. */
function positionsOf(indices: readonly number[]) {
  const items = usePlayerStore.getState().queueItems;
  return indices.flatMap(i => (items[i] ? [{ i, id: items[i].trackId }] : []));
}

/** Owner side: queue edits from remotes are applied one after another, in the order they came in. */
let queueEdits: Promise<unknown> = Promise.resolve();
const inOrder = (edit: () => unknown) => {
  queueEdits = queueEdits.then(edit).catch(e => console.error('[psysonic-hub] queue edit failed', e));
};
const addCollector = createAddCollector();

/** Look up the tracks a remote asked to add, on this device's music server. Unknown ids are skipped. */
async function tracksForIds(ids: string[]): Promise<Track[]> {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return [];
  const profileId = resolveServerIdForIndexKey(serverId) || serverId;
  const refServer = canonicalQueueServerKey(serverId) || serverId;
  const tracks: Track[] = [];
  // The resolver cache holds a few hundred tracks: read each slice right after it resolves.
  for (let i = 0; i < ids.length; i += 200) {
    const refs = ids.slice(i, i + 200).map(trackId => ({ serverId: refServer, trackId }));
    await resolveBatch(refs);
    for (const ref of refs) {
      const t = getCachedTrack(ref);
      if (t) tracks.push({ ...t, serverId: profileId });
    }
  }
  return tracks;
}

async function applyQueueAdd(add: QueueAdd) {
  const tracks = await tracksForIds(add.ids);
  if (!tracks.length) return;
  const p = localPlayer();
  if (add.mode === 'next') p.playNext(tracks);
  else if (add.mode === 'at') p.enqueueAt(tracks, add.at, true);
  else p.enqueue(tracks, true);
}

function removeQueuePositions(args: Record<string, unknown> | null) {
  const positions = readPositions(args);
  if (!positions) return;
  const refs = pickQueueRefs(usePlayerStore.getState().queueItems, positions);
  if (refs.length) localPlayer().removeQueueItems(refs);
}

function moveQueuePositions(args: Record<string, unknown> | null) {
  const gap = args?.gap;
  if (!Number.isInteger(gap) || (gap as number) < 0) return;
  const items = usePlayerStore.getState().queueItems;
  const positions = readPositions(args);
  // Large selections travel without track ids (they would not fit); positions alone are trusted then.
  const indices = positions ? positions.i : Array.isArray(args?.i) ? args.i : null;
  if (!indices || !indices.length || !indices.every(n => Number.isInteger(n) && n >= 0 && n < items.length)) return;
  if (positions && !positionsStillMatch(items, positions)) return; // the queue changed meanwhile
  localPlayer().moveQueueItems(indices as number[], gap as number);
}

// A slider drag fires dozens of events per second, but the hub cuts off connections that flood it.
// Send at most one volume command per 100 ms; the last value always follows (trailing send).
let volumeTimer: ReturnType<typeof setTimeout> | undefined;
let volumePending: number | null = null;
let volumeSentAt = 0;
function sendVolumeThrottled(vol: number) {
  volumePending = vol;
  if (volumeTimer) return;
  volumeTimer = setTimeout(() => {
    volumeTimer = undefined;
    if (volumePending === null) return;
    hubCommand('volume', { volume: volumePending });
    volumePending = null;
    volumeSentAt = Date.now();
  }, Math.max(0, 100 - (Date.now() - volumeSentAt)));
}

function installRemoteRouting(): () => void {
  const st = usePlayerStore.getState() as unknown as Record<string, Action>;
  const saved: Record<string, Action> = {};
  for (const name of [...ACTIONS, ...QUEUE_ACTIONS]) saved[name] = st[name];
  originals = saved;

  /** Show a move or removal here at once; the player's saved queue confirms or corrects it. */
  const showHere = (name: string, args: unknown[]) => {
    forceLocal = true;
    try {
      callAction(saved[name], args);
    } finally {
      forceLocal = false;
    }
    markQueueApplied();
  };

  const queueImpl: Record<string, Action> = {
    enqueue: (tracks: Track[]) => sendQueueAdd('end', tracks),
    enqueueRadio: (tracks: Track[]) => sendQueueAdd('end', tracks),
    enqueueAt: (tracks: Track[], insertIndex: number) => sendQueueAdd('at', tracks, insertIndex),
    playNext: (tracks: Track[]) => sendQueueAdd('next', tracks),
    removeTrack: (index: number) => {
      const positions = positionsOf([index]);
      if (!positions.length) return;
      for (const part of chunkPositions(positions)) hubCommand('removeQueue', { ...part });
      showHere('removeTrack', [index]);
    },
    removeQueueItems: (refs: readonly QueueItemRef[]) => {
      const items = usePlayerStore.getState().queueItems;
      const positions = positionsOf(refs.map(r => {
        const at = items.indexOf(r);
        return at >= 0 ? at : items.findIndex(x => x.trackId === r.trackId);
      }).filter(i => i >= 0));
      if (!positions.length) return;
      for (const part of chunkPositions(positions)) hubCommand('removeQueue', { ...part });
      showHere('removeQueueItems', [refs]);
    },
    reorderQueue: (from: number, to: number) => {
      const ref = usePlayerStore.getState().queueItems[from];
      if (!ref) return;
      hubCommand('moveQueue', { from, to, trackId: ref.trackId });
      showHere('reorderQueue', [from, to]);
    },
    moveQueueItems: (indices: readonly number[], gapIndex: number) => {
      const positions = positionsOf(indices);
      if (!positions.length) return;
      const [part, ...more] = chunkPositions(positions);
      // One command must carry the whole move; without ids a large selection still fits.
      hubCommand('moveQueueItems', more.length ? { i: positions.map(p => p.i), gap: gapIndex } : { ...part, gap: gapIndex });
      showHere('moveQueueItems', [indices, gapIndex]);
    },
    clearQueue: () => hubCommand('clearQueue'),
    clearQueueExceptCurrent: () => hubCommand('clearQueueExceptCurrent'),
    pruneUpcomingToCurrent: () => hubCommand('pruneUpcoming'),
    // One-shot shuffles and the edit history belong to the player's queue too.
    shuffleQueue: () => hubCommand('shuffleQueue'),
    shuffleUpcomingQueue: () => hubCommand('shuffleUpcomingQueue'),
    undoLastQueueEdit: () => { hubCommand('undoQueue'); return true; },
    redoLastQueueEdit: () => { hubCommand('redoQueue'); return true; },
  };

  const remoteImpl: Record<string, Action> = {
    togglePlay: () => {
      patchRemote({ playing: !getHubRemote()?.state.playing });
      hubCommand('toggle');
    },
    resume: () => { patchRemote({ playing: true }); hubCommand('play'); },
    pause: () => { patchRemote({ playing: false }); hubCommand('pause'); },
    next: () => hubCommand('next'),
    previous: () => hubCommand('prev'),
    seek: (progress: number) => {
      const dur = getHubRemote()?.state.durationSec ?? 0;
      if (!(dur > 0) || !Number.isFinite(progress)) return;
      const sec = Math.min(dur, Math.max(0, progress * dur));
      patchRemote({ positionSec: sec });
      hubCommand('seek', { positionSec: sec });
    },
    playTrack: (track: Track, queue?: Track[]) => { void remotePlayTrack(track, queue); },
    toggleShuffleMode: () => {
      const next = !(getHubRemote()?.state.shuffle ?? false);
      patchRemote({ shuffle: next });
      hubCommand('shuffle', { value: next });
    },
    toggleRepeat: () => {
      const order = ['off', 'all', 'one'] as const;
      const cur = getHubRemote()?.state.repeat ?? 'off';
      const next = order[(order.indexOf(cur) + 1) % order.length];
      patchRemote({ repeat: next });
      hubCommand('repeat', { value: next });
    },
    setVolume: (v: number) => {
      if (!Number.isFinite(v)) return;
      const vol = Math.min(1, Math.max(0, v));
      patchRemote({ volume: vol }); // the slider follows the pointer immediately
      sendVolumeThrottled(vol);
    },
  };

  const wrapped: Record<string, Action> = {};
  for (const name of ACTIONS) {
    wrapped[name] = (...args: unknown[]) =>
      getHubRemote() && !forceLocal ? callAction(remoteImpl[name], args) : callAction(saved[name], args);
  }
  for (const name of QUEUE_ACTIONS) {
    wrapped[name] = (...args: unknown[]) =>
      queueOwnedElsewhere() && !forceLocal ? callAction(queueImpl[name], args) : callAction(saved[name], args);
  }
  usePlayerStore.setState(wrapped as never);

  // Drive the real clock/waveform from the remote's position while in remote mode.
  let wasRemote = false;
  const timer = setInterval(() => {
    if (holdProgress) return;
    const r = getHubRemote();
    if (r) {
      wasRemote = true;
      emitMine(remotePosition(r.state, r.stateAt), r.state.durationSec ?? 0);
    } else if (wasRemote) {
      wasRemote = false;
      emitMine(clockNow(), usePlayerStore.getState().currentTrack?.duration ?? 0, 0);
    }
  }, 120);

  return () => {
    clearInterval(timer);
    clearTimeout(volumeTimer);
    volumeTimer = undefined;
    volumePending = null;
    usePlayerStore.setState(saved as never);
    originals = null;
  };
}

/** A remote picked a position in this device's queue (ignored when the queue changed meanwhile). */
function playQueueIndex(args: Record<string, unknown> | null) {
  const p = localPlayer();
  const tracks = getQueueTracksView(usePlayerStore.getState().queueItems);
  const index = resolveQueuePlayIndex(tracks, args?.index, args?.trackId);
  if (index >= 0) p.playTrack(tracks[index], undefined, undefined, undefined, index);
}

/** A remote dragged a track in this device's queue to another place (ignored when the queue changed meanwhile). */
function moveQueueTrack(args: Record<string, unknown> | null) {
  const tracks = getQueueTracksView(usePlayerStore.getState().queueItems);
  const move = resolveQueueMove(tracks, args?.from, args?.to, args?.trackId);
  if (move) localPlayer().reorderQueue(move.from, move.to);
}

/** A remote picked an album, playlist or song from the library: play it, play it next, or add it. */
/** Bumped by every "play this" (replace) request: a lookup that finishes after a newer one is dropped. */
let playItemGeneration = 0;

async function playLibraryItem(args: Record<string, unknown> | null) {
  const replaces = args?.mode !== 'next' && args?.mode !== 'add';
  const generation = replaces ? ++playItemGeneration : playItemGeneration;
  try {
    const tracks = await hubPlayableTracks(args?.kind, args?.id);
    if (replaces && generation !== playItemGeneration) return; // a newer "play this" came in meanwhile
    if (!tracks.length) return;
    const p = localPlayer();
    if (args?.mode === 'next') return p.playNext(tracks);
    if (args?.mode === 'add') return p.enqueue(tracks);
    const start = typeof args?.index === 'number' && args.index >= 0 && args.index < tracks.length ? args.index : 0;
    p.playTrack(tracks[start], tracks, true, undefined, start);
  } catch (e) {
    console.error('[psysonic-hub] could not play library item', e);
  }
}

function applyCommand(action: string, args: Record<string, unknown> | null) {
  const p = localPlayer();
  switch (action) {
    case 'playIndex': return inOrder(() => playQueueIndex(args));
    case 'moveQueue': return inOrder(() => moveQueueTrack(args));
    case 'queueAdd': {
      const add = addCollector.take(args); // parts are collected as they arrive
      if (add) inOrder(() => applyQueueAdd(add));
      return;
    }
    case 'removeQueue': return inOrder(() => removeQueuePositions(args));
    case 'moveQueueItems': return inOrder(() => moveQueuePositions(args));
    case 'clearQueue': return inOrder(() => p.clearQueue());
    case 'clearQueueExceptCurrent': return inOrder(() => p.clearQueueExceptCurrent());
    case 'pruneUpcoming': return inOrder(() => p.pruneUpcomingToCurrent());
    case 'undoQueue': return inOrder(() => p.undoLastQueueEdit());
    case 'redoQueue': return inOrder(() => p.redoLastQueueEdit());
    case 'playItem': return void playLibraryItem(args);
    case 'play': return p.resume();
    case 'pause': return p.pause();
    case 'toggle': return p.togglePlay();
    case 'next': return p.next(true);
    case 'prev': return p.previous();
    case 'seek': {
      // Prefer absolute seconds (precise); fall back to a 0-1 fraction.
      const sec = Number(args?.positionSec);
      const dur = p.currentTrack?.duration ?? 0;
      if (Number.isFinite(sec) && dur > 0) {
        p.seek(Math.min(1, Math.max(0, sec / dur)));
        return;
      }
      const v = Number(args?.progress);
      if (Number.isFinite(v)) p.seek(Math.min(1, Math.max(0, v)));
      return;
    }
    case 'volume': {
      const v = Number(args?.volume);
      if (Number.isFinite(v)) p.setVolume(Math.min(1, Math.max(0, v)));
      return;
    }
    case 'shuffleQueue': return inOrder(() => p.shuffleQueue());
    case 'shuffleUpcomingQueue': return inOrder(() => p.shuffleUpcomingQueue());
    case 'shuffle': {
      if (usePlayerStore.getState().shuffleMode !== (args?.value === true)) p.toggleShuffleMode();
      return;
    }
    case 'repeat': {
      const want = String(args?.value);
      for (let i = 0; i < 3 && usePlayerStore.getState().repeatMode !== want; i++) p.toggleRepeat();
      return;
    }
  }
}

/** Starts the client; returns a stop function. Safe to call once at app start. */
export function startHubClient(): () => void {
  let uninstallRouting: (() => void) | null = null;

const syncRemoteRouting = () => {
  const { enabled, url, token } = useHubStore.getState();
  const shouldInstall = enabled && !!token.trim() && !!toHubWsUrl(url);

  if (shouldInstall && !uninstallRouting) {
    uninstallRouting = installRemoteRouting();
  } else if (!shouldInstall && uninstallRouting) {
    uninstallRouting();
    uninstallRouting = null;
  }
};

  let ws: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let gaveUp = false; // auth/protocol failure: don't hammer the hub
  let settingsConnectTimer: ReturnType<typeof setTimeout> | undefined;
  const SETTINGS_CONNECT_DEBOUNCE_MS = 1000;

  const setRuntime = useHubStore.getState().setRuntime;

  const send = (msg: unknown) => {
    if (watching() && (msg as { t?: unknown })?.t !== 'hello') return; // a watcher only says hello
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  hubSender = send;
  const sendState = () => send({ t: 'state', state: snapshot() });
  // Remotes show the queue of the playing device. A controller's local queue is only a mirror, so it stays quiet.
  // The last window sent, so a track resolving outside it (or the same data again) sends nothing.
  let lastQueueJson = '';
  const sendQueue = () => {
    if (getHubRemote()) return;
    const p = usePlayerStore.getState();
    const queue = hubQueueWindow(getQueueTracksView(p.queueItems), p.queueIndex);
    const json = JSON.stringify(queue);
    if (json === lastQueueJson) return;
    lastQueueJson = json;
    send({ t: 'queue', queue });
  };
  const answerBrowse = async (rid: unknown, req: unknown) => {
    try {
      send({ t: 'browse-result', rid, result: await hubBrowse(req as HubBrowseRequest) });
    } catch (e) {
      console.error('[psysonic-hub] browse failed', e);
      send({ t: 'browse-result', rid, error: 'lookup_failed' });
    }
  };
  const answerArt = async (rid: unknown, coverArt: unknown, size: unknown) => {
    const art = typeof coverArt === 'string' ? await hubArtwork(coverArt, Number(size) || 160) : null;
    send({ t: 'art', rid, ...(art ?? {}) });
  };

  // The playing device shares its current cover with the hub (for the web page and REST clients).
  // The hub never talks to your music server, so the image comes from here.
  let coverSentFor = '';
  let lastServerKeys = '';
  const toBase64 = (bytes: Uint8Array) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const sendCover = async () => {
    if (
  !useHubStore.getState().enabled ||
  useHubStore.getState().status !== 'connected' ||
  ws?.readyState !== WebSocket.OPEN
) return;
    const track = usePlayerStore.getState().currentTrack;
    if (!track?.coverArt || track.id === coverSentFor || getHubRemote()) return;
    coverSentFor = track.id;
    try {
      const resp = await fetch(buildCoverArtUrl(track.coverArt, 400));
      if (!resp.ok) return;
      const blob = await resp.blob();
      if (blob.size > 700_000 || !/^image\/(jpeg|png|webp)$/.test(blob.type)) return;
      if (usePlayerStore.getState().currentTrack?.id !== track.id) return; // skipped meanwhile
      send({ t: 'cover', trackId: track.id, mime: blob.type, data: toBase64(new Uint8Array(await blob.arrayBuffer())) });
    } catch { /* no cover is fine */ }
  };

  // Joined (or reconnected): the shared queue and this device's queue must agree before anyone edits.
  // Playing here, this device's queue is the one that counts; mirroring another, take the shared one.
  // Until a load succeeds every queue write stays held; a failed load is tried again.
  let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  const catchUpQueue = () => {
    clearTimeout(catchUpTimer);
    const hub = useHubStore.getState();
    if (hub.status !== 'connected') return; // still held; the next welcome catches up
    // Go by who the hub says is active, not by its "now playing": right after a handoff the new player is
    // already active while the state still comes from the previous one, so getHubRemote() is briefly null.
    const otherActive = hub.devices.some(d => d.active && d.id !== hub.deviceId && d.kind !== 'web');
    if (!otherActive || usePlayerStore.getState().isPlaying) {
      queueBehind = false;
      if (usePlayerStore.getState().isPlaying) void pushQueueAndSignal();
      return;
    }
    queueBehind = true;
    const startedIn = membership;
    void refreshQueueFromServer().then(ok => {
      if (!ok && queueBehind && startedIn === membership) catchUpTimer = setTimeout(catchUpQueue, CATCH_UP_RETRY_MS);
    });
  };

  const settingsSync = createSettingsSync({
    send,
    isConnected: () => useHubStore.getState().status === 'connected' && ws?.readyState === WebSocket.OPEN,
    isEnabled: () => useHubStore.getState().syncPlaybackSettings,
  });

  const teardown = () => {
    clearTimeout(retryTimer);
    clearInterval(heartbeat);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
      ws = null;
    }
  };

  const connect = () => {
    teardown();
    const { enabled, url, token, deviceId, deviceName } = useHubStore.getState();
    const wsUrl = toHubWsUrl(url);
    if (stopped || !enabled || !wsUrl || !token) {
      setRuntime({ status: 'off', devices: [], remoteState: null });
      return;
    }
    setRuntime({ status: 'connecting' });
    const sock = new WebSocket(wsUrl);
    ws = sock;

    sock.onopen = () => {
      if (watching()) {
        send({ t: 'hello', v: PROTOCOL, token, deviceId: watcherId(deviceId), name: deviceName, kind: 'web' });
        return;
      }
      void currentServerKeys().then(server => {
        if (ws !== sock) return; // replaced meanwhile (hub control switched off, settings changed)
        lastServerKeys = JSON.stringify(server);
        send({ t: 'hello', v: PROTOCOL, token, deviceId, name: deviceName, kind: hubDeviceKind(), server });
      });
    };

    // Watching: only who is there and what plays matter; commands, queues and settings are not ours.
    const onWatchMessage = (m: HubMsg) => {
      if (m?.t === 'welcome') {
        attempt = 0;
        clearInterval(heartbeat);
        setRuntime({
          status: 'connected',
          devices: m.devices ?? [],
          serverCheck: m.serverCheck !== false,
          remoteState: m.state ?? null,
          remoteStateAt: Date.now(),
        });
      } else if (m?.t === 'devices') {
        setRuntime({ devices: m.devices ?? [] });
      } else if (m?.t === 'state') {
        setRuntime({ remoteState: m.state ?? null, remoteStateAt: Date.now() });
      }
    };

    sock.onmessage = ev => {
      let m: HubMsg;
      try { m = JSON.parse(String(ev.data)) as HubMsg; } catch { return; }
      if (watching()) return onWatchMessage(m);
      switch (m?.t) {
        case 'welcome':
          attempt = 0;
          setRuntime({
            status: 'connected',
            devices: m.devices ?? [],
            serverCheck: m.serverCheck !== false,
            remoteState: m.state && m.state.from !== deviceId ? m.state : null,
            remoteStateAt: Date.now(),
          });
          sendState();
          lastQueueJson = ''; // a (re)connected hub has no queue yet
          sendQueue();
          coverSentFor = ''; // nor a cover
          if (usePlayerStore.getState().isPlaying) void sendCover();
          catchUpQueue();
          settingsSync.onWelcome(
            (m.settings ?? {}) as Record<string, Record<string, unknown>>,
            (m.syncConfig ?? {}) as Record<string, boolean>,
          );
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (usePlayerStore.getState().isPlaying) sendState();
          }, HEARTBEAT_MS);
          break;
        case 'devices':
          setRuntime({ devices: m.devices ?? [] });
          break;
        case 'state': {
          setRuntime({ remoteState: m.state ?? null, remoteStateAt: Date.now() });
          // Controller: keep the queue panel highlighting what the active device plays.
          const tid = m.state?.trackId;
          if (tid && getHubRemote()) {
            const ps = usePlayerStore.getState();
            const idx = ps.queueItems.findIndex(r => r.trackId === tid);
            if (idx >= 0 && idx !== ps.queueIndex) usePlayerStore.setState({ queueIndex: idx });
          }
          break;
        }
        case 'queue-changed':
          void refreshQueueFromServer(true);
          break;
        case 'settings':
          settingsSync.onSettings(String(m.category), (m.value ?? {}) as Record<string, unknown>);
          break;
        case 'sync-config':
          settingsSync.onConfig((m.config ?? {}) as Record<string, boolean>);
          break;
        case 'command':
          applyCommand(String(m.action), m.args ?? null);
          break;
        case 'yield':
          void handleYield(String(m.to), send);
          break;
        case 'takeover':
          // Set before anything is awaited: the hub names this device the player right after this
          // message, and that must not save the queue this device had before it loads the handed-over one.
          takingOver++;
          void handleTakeover(
            m.state ?? null,
            Number(m.ageMs) || 0,
            m.fresh === true,
            Array.isArray(m.server) ? m.server.filter((k): k is string => typeof k === 'string') : [],
            send,
          ).finally(() => { takingOver--; });
          break;
        case 'transfer-failed':
          reportTransferFailed(String(m.reason));
          break;
        case 'browse':
          void answerBrowse(m.rid, m.req);
          break;
        case 'art-request':
          void answerArt(m.rid, m.coverArt, m.size);
          break;
      }
    };

    sock.onclose = ev => {
      if (stopped || ws !== sock) return;
      clearInterval(heartbeat);
      if (ev.code === 4005) { gaveUp = true; setRuntime({ status: 'unauthorized', devices: [] }); return; }
      if (ev.code === 4004) { gaveUp = true; setRuntime({ status: 'incompatible', devices: [] }); return; }
      setRuntime({ status: 'error', devices: [] });
      // 4011 = this address is locked out, 4010 = too many connections: asking again right away
      // only gets refused again, so wait a full minute.
      const refused = ev.code === 4011 || ev.code === 4010;
      const delay = refused ? 60_000 : BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      retryTimer = setTimeout(connect, delay);
    };
    sock.onerror = () => { /* onclose handles retry */ };
  };

  // Reconnect when connection settings change, but don't attempt a connection
  // for every keystroke while the user is typing.
  const unsubSettings = useHubStore.subscribe((s, prev) => {
    if (s.syncPlaybackSettings !== prev.syncPlaybackSettings) {
      settingsSync.refresh();
   }

   if (s.enabled !== prev.enabled || s.joined !== prev.joined) {
     membership++;
     clearTimeout(catchUpTimer);
     // Back from playing on its own: hold queue writes until the welcome lines the queue up.
     queueBehind = s.enabled && s.joined && !prev.joined;
     clearTimeout(settingsConnectTimer);
      settingsConnectTimer = undefined;
      gaveUp = false;
     attempt = 0;
      connect();
      return;
   }

    if (
      s.url !== prev.url ||
      s.token !== prev.token ||
      s.deviceName !== prev.deviceName
    ) {
      clearTimeout(settingsConnectTimer);
      settingsConnectTimer = setTimeout(() => {
       settingsConnectTimer = undefined;
        gaveUp = false;
        attempt = 0;
        connect();
      }, SETTINGS_CONNECT_DEBOUNCE_MS);
    }
  });

  // Push state on meaningful changes only (not on every progress tick).
  let lastKey = '';
  let wasPlaying = usePlayerStore.getState().isPlaying;
  let lastTrackId = usePlayerStore.getState().currentTrack?.id;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let queueWindowTimer: ReturnType<typeof setTimeout> | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleQueue = () => {
    if (gaveUp) return;
    clearTimeout(queueWindowTimer);
    queueWindowTimer = setTimeout(sendQueue, 300);
  };
  const unsubPlayer = usePlayerStore.subscribe((s, prev) => {
    // Keep our clock exact across pause/resume and track changes.
    if (s.isPlaying !== wasPlaying) {
      clock = wasPlaying
        ? { sec: clockNow(), at: Date.now(), playing: false, live: false } // freeze at the true pause position
        : { sec: clock.sec, at: Date.now(), playing: true, live: false };  // not live until a real tick
      wasPlaying = s.isPlaying;
    }
    if (s.currentTrack?.id !== lastTrackId) {
      lastTrackId = s.currentTrack?.id;
      setClock(s.currentTime, s.isPlaying);
    }

    const key = `${s.currentTrack?.id ?? ''}|${s.isPlaying}|${s.volume}|${s.shuffleMode}|${s.repeatMode}`;
    if (key !== lastKey) {
      lastKey = key;
      if (!gaveUp) sendState();
    }

    // The playing device shares its cover art with the hub.
    if (s.isPlaying && s.currentTrack?.id && s.currentTrack.id !== coverSentFor && !gaveUp) void sendCover();

    // Remotes see the queue window; a new current track moves it too. Starting to play counts as
    // well: a device that was idle may never have sent its queue, and it is the one remotes show now.
    if (s.queueItems !== prev.queueItems || s.queueIndex !== prev.queueIndex || (s.isPlaying && !prev.isPlaying)) {
      scheduleQueue();
    }

    // A real queue edit (not one we applied from the server): push + signal the others.
    if (s.queueItems !== prev.queueItems && s.queueItems !== lastAppliedQueue && !forceLocal) {
      queueCleared = s.queueItems.length === 0 && (prev.queueItems.length > 0 || queueCleared);
      clearTimeout(queueTimer);
      queueTimer = setTimeout(() => { void pushQueueAndSignal(); }, 400);
    }
  });
  // Real engine ticks keep the clock honest (ignoring our own writes).
  const unsubProgress = subscribePlaybackProgress(next => {
    if (emittingMine || getHubRemote()) return;
    if (Date.now() < tickGuardUntil && Math.abs(next.currentTime - clock.sec) > 1.5) return; // stale pre-seek tick
    const wasLive = clock.live;
    const playing = usePlayerStore.getState().isPlaying;
    clock = { sec: next.currentTime, at: Date.now(), playing, live: true };
    // Audio really started (after a resume, seek or handoff, which can take a second or two to load).
    // Until now other devices extrapolated from a position that was not advancing yet, so tell them the
    // true position, otherwise their bar runs ahead and snaps back at the next heartbeat.
    if (!wasLive && playing && !gaveUp) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(sendState, 60);
    }
  });
  // Seeks announce themselves (exact target), so no guessing from position jumps.
  const unsubSeek = subscribePlaybackSeek(sec => {
    setClock(sec);
    tickGuardUntil = Date.now() + 800;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => { if (!gaveUp) sendState(); }, 120); // debounce drags
  });

  // While another device played, this one stayed quiet about its queue (it only mirrored). Once it is
  // no longer mirroring (it took over, or the other device stopped), its own queue is the real one again.
  // A restored queue starts with placeholders for tracks not looked up yet; resend once they resolve.
  const unsubResolver = subscribeQueueResolver(scheduleQueue);

  let wasMirroring = !!getHubRemote();
  // A device that started playing while another was the player could not save its queue until the
  // hub named it the player. Save it once that happens (a takeover loads the queue instead).
  let ownerElsewhere = anotherDevicePlays();
  const unsubRemote = useHubStore.subscribe(() => {
    const mirroring = !!getHubRemote();
    if (wasMirroring && !mirroring) scheduleQueue();
    wasMirroring = mirroring;
    const elsewhere = anotherDevicePlays();
    if (ownerElsewhere && !elsewhere && !forceLocal && !takingOver && usePlayerStore.getState().isPlaying) {
      void pushQueueAndSignal();
    }
    ownerElsewhere = elsewhere;
  });

  // The user switched music server / account while connected: tell the hub.
  let serverTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubServer = useAuthStore.subscribe((s, prev) => {
    if (s.activeServerId === prev.activeServerId && s.servers === prev.servers) return;
    clearTimeout(serverTimer);
    serverTimer = setTimeout(() => {
      void currentServerKeys().then(server => {
        const json = JSON.stringify(server);
        if (json === lastServerKeys) return;
        lastServerKeys = json;
        send({ t: 'server', server });
      });
    }, 300);
  });

  const removeQueueGate = setQueueServerWriteGate(queueWritesAllowed);

  syncRemoteRouting();

  connect();

  return () => {
    stopped = true;
    hubSender = null;
    addCollector.clear();
    removeQueueGate();
    clearTimeout(catchUpTimer);
    queueBehind = false;
    uninstallRouting?.();
    uninstallRouting = null;
    unsubSettings();
    unsubPlayer();
    unsubSeek();
    unsubProgress();
    settingsSync.dispose();
    unsubServer();
    unsubRemote();
    unsubResolver();
    clearTimeout(serverTimer);
    clearTimeout(seekTimer);
    clearTimeout(queueTimer);
    clearTimeout(queueWindowTimer);
    clearTimeout(liveTimer);
    clearTimeout(settingsConnectTimer);
    teardown();
  };
}
