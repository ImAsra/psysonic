import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { flushPlayQueuePosition, flushQueueSyncToServer } from '@/features/playback/store/queueSync';
import { isPlayQueueSyncEnabled } from '@/features/playback/store/playQueueSyncSettingsStore';
import { getPlayQueueForServer } from '@/lib/api/subsonicPlayQueue';
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
import {
  popQueueRedoSnapshot,
  popQueueUndoSnapshot,
  pushQueueRedoSnapshot,
  pushQueueUndoSnapshot,
  queueUndoSnapshotFromState,
} from '@/features/playback/store/queueUndo';
import { getQueueTracksView } from '@/features/playback/store/queueTrackView';
import type { Track } from '@/lib/media/trackTypes';
import {
  emitPlaybackProgress,
  subscribePlaybackProgress,
  subscribePlaybackSeek,
} from '@/features/playback/store/playbackProgress';
import { useHubStore } from './hubStore';
import type { HubDevice, HubRemoteState } from './hubStore';
import { getHubRemote, remotePosition, trackFromRemoteState } from './useHubRemote';
import { createSettingsSync } from './hubSettingsSync';
import { buildCoverArtUrl } from '@/lib/api/subsonicStreamUrl';
import { showToast } from '@/lib/dom/toast';
import { currentServerKeys } from './hubServerKeys';
import { deviceCompatible } from './compat';

/**
 * Optional realtime hub client (psysonic-hub). Does nothing unless the user
 * enabled it AND entered a hub URL + token in Settings. The existing Subsonic
 * play-queue sync keeps running untouched; this only adds a push channel.
 */

const PROTOCOL = 1;
const HEARTBEAT_MS = 5_000;
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
/** While true, the remote position is not pushed into the shared progress clock. */
let holdProgress = false;

/**
 * Like pullPlayQueueFromServer but WITHOUT pushing a queue-undo entry: a device
 * switch is not a user queue edit, so Ctrl+Z must not roll it back.
 */
async function pullQueueForTakeover(serverId: string) {
  if (!isPlayQueueSyncEnabled()) return 'noop' as const;
  clearQueueNaturallyEnded();
  const result = await applyServerPlayQueue(serverId, {
    mode: 'manual',
    preferServerPosition: true,
    pushUndo: false,
  });
  if (result === 'applied' || result === 'noop') {
    resumeIdleQueuePull();
    clearQueuePushFailed(serverId);
  }
  return result;
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
    const result = await pullQueueForTakeover(serverId);
    if (result !== 'applied' && result !== 'noop') return fail('queue_unavailable');
    const player = localPlayer();
    setClock(player.currentTime, false); // position the server queue gave us
    tickGuardUntil = Date.now() + 1500;

    // The Subsonic server only has the position the previous device last SAVED.
    // The hub has the exact position it reported when it yielded, so prefer that
    // when it is the same track (avoids the time jumping back on switch).
    const track = player.currentTrack;
    if (!fresh && hubState?.trackId && track && track.id === hubState.trackId
        && Number.isFinite(hubState.positionSec) && track.duration > 0) {
      const sec = (hubState.positionSec ?? 0) + (hubState.playing ? Math.max(0, ageMs) / 1000 : 0);
      const target = Math.max(0, Math.min(track.duration - 0.5, sec));
      setClock(target, false);
      if (Math.abs(target - player.currentTime) > 0.75) {
        player.seek(target / track.duration);
        await new Promise(r => setTimeout(r, 200)); // let the seek settle before resuming
      }
    }
    markQueueApplied();
    emitMine(clockNow(), localPlayer().currentTrack?.duration ?? 0, 0);
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

async function pushQueueAndSignal() {
  if (!isPlayQueueSyncEnabled() || useHubStore.getState().status !== 'connected') return;
  const p = usePlayerStore.getState();
  const remote = getHubRemote();
  // As a controller, save the ACTIVE device's track/position, not our idle local ones.
  const current = remote ? trackFromRemoteState(remote.state) : p.currentTrack;
  const seconds = remote ? remotePosition(remote.state, remote.stateAt) : clockNow();
  try {
    await flushQueueSyncToServer(p.queueItems, current, seconds);
    hubSender?.({ t: 'queue-changed' });
  } catch (e) {
    console.error('[psysonic-hub] queue push failed', e);
  }
}

async function refreshQueueFromServer() {
  if (forceLocal || !isPlayQueueSyncEnabled()) return;
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return;
  const profileId = resolveServerIdForIndexKey(serverId) || serverId;
  try {
    const q = await getPlayQueueForServer(profileId);
    if (q.songs.length === 0) return;
    if (playQueueFingerprintsEqual(fingerprintFromServer(q), fingerprintFromLocalQueue())) return;
    const mapped = q.songs.map(song => ({ ...songToTrack(song), serverId: profileId }));
    applyMappedQueueProjection(mapped, q, profileId, false);
    markQueueApplied();
  } catch (e) {
    console.error('[psysonic-hub] queue refresh failed', e);
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
  'toggleShuffleMode', 'toggleRepeat', 'undoLastQueueEdit', 'redoLastQueueEdit',
  'shuffleQueue', 'shuffleUpcomingQueue'] as const;
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
    emitMine(0, track.duration ?? 0, 0);
    await flushPlayQueuePosition();
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

/**
 * Ctrl+Z / Ctrl+Shift+Z while another device is the active player: restore the
 * QUEUE only. The app's normal undo can also restart the local audio engine on a
 * snapshot's old song, which must never happen on a device that is just a remote.
 */
function remoteQueueHistory(dir: 'undo' | 'redo'): boolean {
  const remote = getHubRemote();
  if (!remote) return false;
  const prior = usePlayerStore.getState();
  const snap = dir === 'undo' ? popQueueUndoSnapshot() : popQueueRedoSnapshot();
  if (!snap) return false;
  const putBack = () => (dir === 'undo' ? pushQueueUndoSnapshot(snap) : pushQueueRedoSnapshot(snap));

  // The song the active device is playing has to stay in the queue, or it would jump.
  const tid = remote.state.trackId;
  let items = [...snap.queueItems];
  let idx = tid ? items.findIndex(r => r.trackId === tid) : -1;
  if (tid && idx < 0) {
    const ref = prior.queueItems.find(r => r.trackId === tid);
    if (!ref) { putBack(); return false; }
    items = [ref, ...items];
    idx = 0;
  }
  const current = queueUndoSnapshotFromState(prior);
  if (dir === 'undo') pushQueueRedoSnapshot(current); else pushQueueUndoSnapshot(current);
  usePlayerStore.setState({ queueItems: items, queueIndex: Math.max(0, idx) });
  return true; // the queue subscriber pushes it to the server and tells the other devices
}

function installRemoteRouting(): () => void {
  const st = usePlayerStore.getState() as unknown as Record<string, Action>;
  const saved: Record<string, Action> = {};
  for (const name of ACTIONS) saved[name] = st[name];
  originals = saved;

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
    // One-shot queue shuffles belong to whoever owns the queue: the device that is playing.
    shuffleQueue: () => hubCommand('shuffleQueue'),
    shuffleUpcomingQueue: () => hubCommand('shuffleUpcomingQueue'),
    undoLastQueueEdit: () => remoteQueueHistory('undo'),
    redoLastQueueEdit: () => remoteQueueHistory('redo'),
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
      patchRemote({ volume: vol });
      hubCommand('volume', { volume: vol });
    },
  };

  const wrapped: Record<string, Action> = {};
  for (const name of ACTIONS) {
    wrapped[name] = (...args: unknown[]) =>
      getHubRemote() && !forceLocal ? callAction(remoteImpl[name], args) : callAction(saved[name], args);
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
    usePlayerStore.setState(saved as never);
    originals = null;
  };
}

function applyCommand(action: string, args: Record<string, unknown> | null) {
  const p = localPlayer();
  switch (action) {
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
    case 'shuffleQueue': return p.shuffleQueue();
    case 'shuffleUpcomingQueue': return p.shuffleUpcomingQueue();
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
  let ws: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let gaveUp = false; // auth/protocol failure: don't hammer the hub

  const setRuntime = useHubStore.getState().setRuntime;

  const send = (msg: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  hubSender = send;
  const sendState = () => send({ t: 'state', state: snapshot() });

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
      void currentServerKeys().then(server => {
        lastServerKeys = JSON.stringify(server);
        send({ t: 'hello', v: PROTOCOL, token, deviceId, name: deviceName, kind: 'desktop', server });
      });
    };

    sock.onmessage = ev => {
      let m: HubMsg;
      try { m = JSON.parse(String(ev.data)) as HubMsg; } catch { return; }
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
          coverSentFor = ''; // a (re)connected hub has no cover yet
          if (usePlayerStore.getState().isPlaying) void sendCover();
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
          void refreshQueueFromServer();
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
          void handleTakeover(
            m.state ?? null,
            Number(m.ageMs) || 0,
            m.fresh === true,
            Array.isArray(m.server) ? m.server.filter((k): k is string => typeof k === 'string') : [],
            send,
          );
          break;
        case 'transfer-failed':
          reportTransferFailed(String(m.reason));
          break;
      }
    };

    sock.onclose = ev => {
      if (stopped || ws !== sock) return;
      clearInterval(heartbeat);
      if (ev.code === 4005) { gaveUp = true; setRuntime({ status: 'unauthorized', devices: [] }); return; }
      if (ev.code === 4004) { gaveUp = true; setRuntime({ status: 'incompatible', devices: [] }); return; }
      setRuntime({ status: 'error', devices: [] });
      const delay = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      retryTimer = setTimeout(connect, delay);
    };
    sock.onerror = () => { /* onclose handles retry */ };
  };

  // Reconnect when the user edits settings.
  const unsubSettings = useHubStore.subscribe((s, prev) => {
    if (s.syncPlaybackSettings !== prev.syncPlaybackSettings) settingsSync.refresh();
    if (s.enabled !== prev.enabled || s.url !== prev.url || s.token !== prev.token
        || s.deviceName !== prev.deviceName) {
      gaveUp = false;
      attempt = 0;
      connect();
    }
  });

  // Push state on meaningful changes only (not on every progress tick).
  let lastKey = '';
  let wasPlaying = usePlayerStore.getState().isPlaying;
  let lastTrackId = usePlayerStore.getState().currentTrack?.id;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
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

    // A real queue edit (not one we applied from the server): push + signal the others.
    if (s.queueItems !== prev.queueItems && s.queueItems !== lastAppliedQueue && !forceLocal) {
      clearTimeout(queueTimer);
    clearTimeout(liveTimer);
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

  const uninstallRouting = installRemoteRouting();

  connect();

  return () => {
    stopped = true;
    hubSender = null;
    uninstallRouting();
    unsubSettings();
    unsubPlayer();
    unsubSeek();
    unsubProgress();
    settingsSync.dispose();
    unsubServer();
    clearTimeout(serverTimer);
    clearTimeout(seekTimer);
    clearTimeout(queueTimer);
    teardown();
  };
}
