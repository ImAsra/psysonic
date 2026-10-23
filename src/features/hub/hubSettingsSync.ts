import { useAuthStore } from '@/store/authStore';
import { useThemeStore } from '@/store/themeStore';
import { useEqStore } from '@/store/eqStore';
import { useKeybindingsStore } from '@/store/keybindingsStore';
import { audioSetEq } from '@/lib/api/audio';
import { isBuiltinThemeId } from '@/lib/themes/startupThemeAppearance';

/**
 * Settings sync through the hub, in opt-in categories. The hub decides which
 * categories are switched on (toggled from its web page) and keeps the latest
 * value of each; every device adopts those values and pushes its own changes.
 *
 * NEVER add anything from the auth store that holds server URLs or credentials.
 */

type Json = Record<string, unknown>;

interface Category {
  id: string;
  read(): Json;
  apply(value: Json): void;
  subscribe(listener: () => void): () => void;
}

interface StoreLike {
  getState(): any;
  setState(partial: any): void;
  subscribe(listener: () => void): () => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Same kind of value (null may stand in for a string, e.g. "no active preset"). */
const sameKind = (v: unknown, cur: unknown) =>
  v === null || cur === null || (typeof v === typeof cur && Array.isArray(v) === Array.isArray(cur));

function keyed(
  id: string,
  store: StoreLike,
  keys: readonly string[],
  opts: { accept?: (key: string, value: unknown) => boolean; after?: (state: any) => void } = {},
): Category {
  return {
    id,
    subscribe: l => store.subscribe(l),
    read() {
      const s = store.getState();
      const out: Json = {};
      for (const k of keys) if (k in s && typeof s[k] !== 'function' && s[k] !== undefined) out[k] = s[k];
      return out;
    },
    apply(value) {
      const s = store.getState();
      const patch: Json = {};
      for (const k of keys) {
        if (!(k in value) || !(k in s)) continue;
        const v = value[k];
        if (!sameKind(v, s[k]) || same(v, s[k])) continue;
        if (opts.accept && !opts.accept(k, v)) continue;
        patch[k] = v;
      }
      if (Object.keys(patch).length === 0) return;
      store.setState(patch);
      opts.after?.(store.getState());
    },
  };
}

const PLAYBACK_KEYS = [
  'crossfadeEnabled', 'crossfadeSecs', 'crossfadeTrimSilence',
  'autodjSmoothSkip', 'autodjOverlapCapMode', 'autodjOverlapCapSec',
  'gaplessEnabled', 'pauseResumeFadeEnabled', 'pauseResumeFadeSecs',
  'infiniteQueueEnabled', 'smartShuffleEnabled', 'preservePlayNextOrder',
] as const;

const LOUDNESS_KEYS = [
  'replayGainEnabled', 'normalizationEngine', 'loudnessTargetLufs',
  'loudnessPreAnalysisAttenuationDb', 'replayGainMode', 'replayGainPreGainDb', 'replayGainFallbackDb',
] as const;

const LYRICS_KEYS = [
  'lyricsServerFirst', 'lyricsSources', 'lyricsStaticOnly', 'lyricsRomanizationEnabled',
  'lyricsTranslationEnabled', 'lyricsWordHighlightMode', 'sidebarLyricsStyle',
] as const;

const APPEARANCE_KEYS = [
  'theme', 'followDesktopTheme', 'enableThemeScheduler', 'schedulerMode', 'themeDay', 'themeNight',
  'timeDayStart', 'timeNightStart', 'enableCoverArtBackground', 'showBitrate', 'showExplicitBadges',
  'blurExplicitCovers', 'showCardTooltips', 'trackRowPlayClick', 'buttonSize', 'showRemainingTime',
  'floatingPlayerBar', 'squareCorners',
] as const;

const EQ_KEYS = ['gains', 'enabled', 'preGain', 'activePreset', 'customPresets'] as const;

const auth = useAuthStore as unknown as StoreLike;

const CATEGORIES: Category[] = [
  keyed('playback', auth, PLAYBACK_KEYS),
  keyed('loudness', auth, LOUDNESS_KEYS),
  keyed('lyrics', auth, LYRICS_KEYS),
  keyed('appearance', useThemeStore as unknown as StoreLike, APPEARANCE_KEYS, {
    // A custom theme another device has not installed must not be selected here.
    accept: (k, v) => !['theme', 'themeDay', 'themeNight'].includes(k) || (typeof v === 'string' && isBuiltinThemeId(v)),
  }),
  keyed('eq', useEqStore as unknown as StoreLike, EQ_KEYS, {
    // Setting the store directly does not reach the audio engine, so push it too.
    after: s => { audioSetEq({ gains: s.gains, enabled: s.enabled, preGain: s.preGain }).catch(() => {}); },
  }),
  {
    id: 'keybindings',
    subscribe: l => useKeybindingsStore.subscribe(l),
    read: () => ({ bindings: { ...useKeybindingsStore.getState().bindings } }),
    apply(value) {
      const incoming = value.bindings as Record<string, unknown> | undefined;
      if (!incoming || typeof incoming !== 'object') return;
      const cur = useKeybindingsStore.getState().bindings as Record<string, string | null>;
      const next = { ...cur };
      for (const k of Object.keys(cur)) {
        const v = incoming[k];
        if (typeof v === 'string' || v === null) next[k] = v;
      }
      if (!same(next, cur)) useKeybindingsStore.setState({ bindings: next as typeof cur } as never);
    },
  },
];

export interface SettingsSync {
  /** Fresh connection: the hub's stored values and which categories are switched on. */
  onWelcome(settings: Record<string, Json>, config: Record<string, boolean>): void;
  /** The hub's category switches changed (toggled from the web page). */
  onConfig(config: Record<string, boolean>): void;
  /** Another device changed a category. */
  onSettings(category: string, value: Json): void;
  /** The local master switch changed. */
  refresh(): void;
  dispose(): void;
}

export function createSettingsSync(deps: {
  send: (msg: unknown) => void;
  isConnected: () => boolean;
  isEnabled: () => boolean;
}): SettingsSync {
  const hubValues: Record<string, Json> = {};
  let config: Record<string, boolean> = {};
  const lastSynced = new Map<string, string>();
  const unsubs = new Map<string, () => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const active = (id: string) => deps.isEnabled() && deps.isConnected() && config[id] === true;

  function pushIfChanged(cat: Category, init = false) {
    if (!active(cat.id)) return;
    const json = JSON.stringify(cat.read());
    if (json === lastSynced.get(cat.id)) return;
    lastSynced.set(cat.id, json);
    // init = "I am only filling an empty slot": the hub keeps an existing value and tells us to adopt it.
    deps.send({ t: 'settings', category: cat.id, value: JSON.parse(json), init });
  }

  function adopt(cat: Category, value: Json) {
    cat.apply(value);
    lastSynced.set(cat.id, JSON.stringify(cat.read())); // what we hold now is "in sync": do not echo it back
  }

  function watch(cat: Category) {
    if (unsubs.has(cat.id)) return;
    unsubs.set(cat.id, cat.subscribe(() => {
      clearTimeout(timers.get(cat.id));
      timers.set(cat.id, setTimeout(() => pushIfChanged(cat), 250)); // debounce slider drags
    }));
  }

  function unwatch(id: string) {
    unsubs.get(id)?.();
    unsubs.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
    lastSynced.delete(id);
  }

  function reconcile(cat: Category) {
    const hv = hubValues[cat.id];
    if (hv && Object.keys(hv).length > 0) {
      adopt(cat, hv); // the hub's copy wins on connect
    } else {
      lastSynced.delete(cat.id);
      pushIfChanged(cat, true); // empty on the hub: offer ours
    }
  }

  function sync() {
    for (const cat of CATEGORIES) {
      if (active(cat.id)) {
        if (!unsubs.has(cat.id)) { watch(cat); reconcile(cat); }
      } else {
        unwatch(cat.id);
      }
    }
  }

  return {
    onWelcome(settings, cfg) {
      for (const cat of CATEGORIES) unwatch(cat.id); // every (re)connection reconciles from scratch
      for (const k of Object.keys(hubValues)) delete hubValues[k];
      Object.assign(hubValues, settings);
      config = { ...cfg };
      sync();
    },
    onConfig(cfg) {
      config = { ...cfg };
      for (const id of Object.keys(hubValues)) if (!config[id]) delete hubValues[id];
      sync();
    },
    onSettings(category, value) {
      hubValues[category] = value;
      const cat = CATEGORIES.find(c => c.id === category);
      if (cat && active(cat.id)) adopt(cat, value);
    },
    refresh: sync,
    dispose() {
      for (const cat of CATEGORIES) unwatch(cat.id);
    },
  };
}
