import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { flushPlayQueuePosition } from '@/features/playback/store/queueSync';
import { applyMappedQueue, pullPlayQueueFromServer } from '@/features/playback/store/applyServerPlayQueue';
import { getQueueTracksView } from '@/features/playback/store/queueTrackView';
import type { Track } from '@/lib/media/trackTypes';
import {
  emitPlaybackProgress,
  getPlaybackProgressSnapshot,
  subscribePlaybackSeek,
} from '@/features/playback/store/playbackProgress';
import { useHubStore } from './hubStore';
import type { HubDevice, HubRemoteState } from './hubStore';
import { getHubRemote, remotePosition } from './useHubRemote';

/**
 * Optional realtime hub client (psysonic-hub). Does nothing unless the user
 * enabled it AND entered a hub URL + token in Settings. The existing Subsonic
 * play-queue sync keeps running untouched; this only adds a push channel.
 */

const PROTOCOL = 1;
const HEARTBEAT_MS = 15_000;
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
  try {
    const p = localPlayer();
    if (p.isPlaying) p.pause();
    await flushPlayQueuePosition();
  } catch (e) {
    console.error('[psysonic-hub] yield failed', e);
  } finally {
    send({ t: 'yielded', to });
  }
}

/** We were chosen as the active player: load the queue the previous device saved, then play. */
/** While true, player actions are never routed to the remote (we are applying things locally). */
let forceLocal = false;
/** While true, the remote position is not pushed into the shared progress clock. */
let holdProgress = false;

async function handleTakeover(hubState: HubRemoteState | null, ageMs: number, fresh: boolean) {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return;
  forceLocal = true;
  try {
    const result = await pullPlayQueueFromServer(serverId);
    if (result !== 'applied' && result !== 'noop') return;
    const player = localPlayer();

    // The Subsonic server only has the position the previous device last SAVED.
    // The hub has the exact position it reported when it yielded, so prefer that
    // when it is the same track (avoids the time jumping back on switch).
    const track = player.currentTrack;
    if (!fresh && hubState?.trackId && track && track.id === hubState.trackId
        && Number.isFinite(hubState.positionSec) && track.duration > 0) {
      const sec = (hubState.positionSec ?? 0) + (hubState.playing ? Math.max(0, ageMs) / 1000 : 0);
      const target = Math.max(0, Math.min(track.duration - 0.5, sec));
      if (Math.abs(target - player.currentTime) > 0.75) {
        player.seek(target / track.duration);
        await new Promise(r => setTimeout(r, 200)); // let the seek settle before resuming
      }
    }
    localPlayer().resume();
  } catch (e) {
    console.error('[psysonic-hub] takeover failed', e);
  } finally {
    forceLocal = false;
  }
}

/** Last explicit seek (position known instantly; the engine progress lags behind it). */
let seekOverride: { sec: number; at: number } | null = null;

function currentPosition(playing: boolean): number {
  const o = seekOverride;
  if (o && Date.now() - o.at < 1200) return o.sec + (playing ? (Date.now() - o.at) / 1000 : 0);
  return getPlaybackProgressSnapshot().currentTime;
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
    positionSec: currentPosition(p.isPlaying),
    playing: p.isPlaying,
    volume: p.volume,
  };
}

// ---------------------------------------------------------------------------
// Remote mode: while another device is the active player, the normal player
// store actions (buttons, waveform seek, media keys...) are routed to that
// device through the hub instead of controlling the local player.
// ---------------------------------------------------------------------------
type Action = (...args: any[]) => unknown;
const ACTIONS = ['togglePlay', 'resume', 'pause', 'next', 'previous', 'seek', 'setVolume', 'playTrack'] as const;
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
  forceLocal = true;
  holdProgress = true;
  try {
    const current = getQueueTracksView(usePlayerStore.getState().queueItems);
    let tracks = queue && queue.length ? queue : current;
    if (!tracks.some(t => t.id === track.id)) tracks = [track];
    // Silent: replaces the local queue and parks on `track` at 0:00 without audio.
    applyMappedQueue(tracks, { current: track.id, position: 0, songs: [] }, serverId, true, 0);
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
      getHubRemote() && !forceLocal ? remoteImpl[name](...args) : saved[name](...args);
  }
  usePlayerStore.setState(wrapped as never);

  // Drive the real clock/waveform from the remote's position while in remote mode.
  let wasRemote = false;
  const timer = setInterval(() => {
    if (holdProgress) return;
    const r = getHubRemote();
    if (r) {
      wasRemote = true;
      const dur = r.state.durationSec ?? 0;
      const pos = remotePosition(r.state, r.stateAt);
      emitPlaybackProgress({ currentTime: pos, progress: dur > 0 ? pos / dur : 0, buffered: 1 });
    } else if (wasRemote) {
      wasRemote = false;
      const p = usePlayerStore.getState();
      const dur = p.currentTrack?.duration ?? 0;
      emitPlaybackProgress({ currentTime: p.currentTime, progress: dur > 0 ? p.currentTime / dur : 0, buffered: 0 });
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
      send({ t: 'hello', v: PROTOCOL, token, deviceId, name: deviceName, kind: 'desktop' });
    };

    sock.onmessage = ev => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      switch (m?.t) {
        case 'welcome':
          attempt = 0;
          setRuntime({
            status: 'connected',
            devices: m.devices as HubDevice[],
            remoteState: m.state && m.state.from !== deviceId ? (m.state as HubRemoteState) : null,
            remoteStateAt: Date.now(),
          });
          sendState();
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (usePlayerStore.getState().isPlaying) sendState();
          }, HEARTBEAT_MS);
          break;
        case 'devices':
          setRuntime({ devices: m.devices as HubDevice[] });
          break;
        case 'state':
          setRuntime({ remoteState: m.state as HubRemoteState, remoteStateAt: Date.now() });
          break;
        case 'command':
          applyCommand(String(m.action), m.args ?? null);
          break;
        case 'yield':
          void handleYield(String(m.to), send);
          break;
        case 'takeover':
          void handleTakeover((m.state as HubRemoteState | null) ?? null, Number(m.ageMs) || 0, m.fresh === true);
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
    if (s.enabled !== prev.enabled || s.url !== prev.url || s.token !== prev.token
        || s.deviceName !== prev.deviceName) {
      gaveUp = false;
      attempt = 0;
      connect();
    }
  });

  // Push state on meaningful changes only (not on every progress tick).
  let lastKey = '';
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubPlayer = usePlayerStore.subscribe(s => {
    const key = `${s.currentTrack?.id ?? ''}|${s.isPlaying}|${s.volume}`;
    if (key === lastKey) return;
    lastKey = key;
    if (!gaveUp) sendState();
  });
  // Seeks announce themselves (exact target), so no guessing from position jumps.
  const unsubSeek = subscribePlaybackSeek(sec => {
    seekOverride = { sec, at: Date.now() };
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => { if (!gaveUp) sendState(); }, 120); // debounce drags
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
    clearTimeout(seekTimer);
    teardown();
  };
}
