import { useAuthStore } from '@/store/authStore';
import type { AuthState } from '@/store/authStoreTypes';
import { useThemeStore } from '@/store/themeStore';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import { useEqStore } from '@/store/eqStore';
import { useKeybindingsStore } from '@/store/keybindingsStore';
import { audioSetEq } from '@/lib/api/audio';
import { isBuiltinThemeId } from '@/lib/themes/startupThemeAppearance';

/**
 * Every settings store the hub settings sync touches, behind one adapter. Each
 * category exposes read() / apply(value) / subscribe(cb); the sync logic in
 * hubSettingsSync.ts only talks to these, so moving to a different settings
 * layer only changes this file.
 *
 * NEVER add anything from the auth store that holds server URLs or credentials.
 */

export type HubSettingsValue = Record<string, unknown>;

type Json = HubSettingsValue;

/** One synced category: read its current value, apply a value from the hub, watch for local changes. */
export interface HubSettingsCategory {
  id: string;
  read(): Json;
  apply(value: Json): void;
  subscribe(listener: () => void): () => void;
}

interface StoreLike {
  getState(): Record<string, unknown>;
  setState(partial: Record<string, unknown>): void;
  subscribe(listener: () => void): () => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Same kind of value (null may stand in for a string, e.g. "no active preset"). */
const sameKind = (v: unknown, cur: unknown) =>
  v === null ||
  cur === null ||
  (typeof v === typeof cur && Array.isArray(v) === Array.isArray(cur));

function keyed(
  id: string,
  store: StoreLike,
  keys: readonly string[],
  opts: {
    accept?: (key: string, value: unknown) => boolean;
    after?: (state: Record<string, unknown>) => void;
    setters?: Record<string, (value: unknown) => void>;
  } = {},
): HubSettingsCategory {
  return {
    id,
    subscribe: l => store.subscribe(l),

    read() {
      const s = store.getState();
      const out: Json = {};

      for (const k of keys) {
        if (k in s && typeof s[k] !== 'function' && s[k] !== undefined) {
          out[k] = s[k];
        }
      }

      return out;
    },

    apply(value) {
      const s = store.getState();
      const patch: Json = {};
      const actions: Array<() => void> = [];

      for (const k of keys) {
        if (!(k in value) || !(k in s)) continue;

        const v = value[k];

        if (!sameKind(v, s[k]) || same(v, s[k])) continue;
        if (opts.accept && !opts.accept(k, v)) continue;

        const setter = opts.setters?.[k];

        if (setter) {
          actions.push(() => setter(v));
        } else {
          patch[k] = v;
        }
      }

      if (Object.keys(patch).length === 0 && actions.length === 0) return;

      if (Object.keys(patch).length > 0) {
        store.setState(patch);
      }

      actions.forEach(action => action());

      opts.after?.(store.getState());
    },
  };
}

const PLAYBACK_KEYS = [
  'crossfadeEnabled',
  'crossfadeSecs',
  'crossfadeTrimSilence',
  'autodjSmoothSkip',
  'autodjOverlapCapMode',
  'autodjOverlapCapSec',
  'gaplessEnabled',
  'pauseResumeFadeEnabled',
  'pauseResumeFadeSecs',
  'infiniteQueueEnabled',
  'smartShuffleEnabled',
  'preservePlayNextOrder',
] as const;

const LOUDNESS_KEYS = [
  'replayGainEnabled',
  'normalizationEngine',
  'loudnessTargetLufs',
  'loudnessPreAnalysisAttenuationDb',
  'replayGainMode',
  'replayGainPreGainDb',
  'replayGainFallbackDb',
] as const;

const LYRICS_KEYS = [
  'lyricsServerFirst',
  'lyricsSources',
  'lyricsStaticOnly',
  'lyricsRomanizationEnabled',
  'lyricsTranslationEnabled',
  'lyricsWordHighlightMode',
  'sidebarLyricsStyle',
] as const;

// Appearance is one category made of several stores. NOT shared on purpose:
// interface scale, font, library card grid size, button size and the custom
// title bar (screen / OS dependent).
const THEME_KEYS = [
  'theme',
  'followDesktopTheme',
  'enableThemeScheduler',
  'schedulerMode',
  'themeDay',
  'themeNight',
  'timeDayStart',
  'timeNightStart',
  'enableCoverArtBackground',
  'enablePlaylistCoverPhoto',
  'trackListCoverArtOnPages',
  'showBitrate',
  'showExplicitBadges',
  'blurExplicitCovers',
  'showCardTooltips',
  'trackRowPlayClick',
  'showRemainingTime',
  'floatingPlayerBar',
  'squareCorners',
] as const;

const APPEARANCE_AUTH_KEYS = [
  'queueTrackListCovers',
  'showArtistImages',
  'showOrbitTrigger',
  'preloadMiniPlayer',
  'windowButtonStyle',
  'showMinimizeButton',
  'fullscreenPlayerStyle',
  'fullscreenAutoOpenMinutes',
  'seekbarStyle',
] as const;

const EQ_KEYS = [
  'gains',
  'enabled',
  'preGain',
  'activePreset',
  'customPresets',
] as const;

/** One category made of several stores; the value is { partName: {...keys} }. */
function composite(
  id: string,
  parts: Array<{ name: string; cat: HubSettingsCategory }>,
): HubSettingsCategory {
  return {
    id,

    subscribe: l => {
      const unsubs = parts.map(p => p.cat.subscribe(l));
      return () => unsubs.forEach(u => u());
    },

    read: () => Object.fromEntries(parts.map(p => [p.name, p.cat.read()])),

    apply(value) {
      for (const p of parts) {
        const sub = value[p.name];

        if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
          p.cat.apply(sub as Json);
        }
      }
    },
  };
}

/** A theme may be adopted only if this device has it (built-in or installed). */
const themeAvailable = (v: unknown) =>
  typeof v === 'string' &&
  (isBuiltinThemeId(v) || useInstalledThemesStore.getState().isInstalled(v));

const auth = useAuthStore as unknown as StoreLike;

export const HUB_SETTINGS_CATEGORIES: readonly HubSettingsCategory[] = [
  keyed('playback', auth, PLAYBACK_KEYS),

  keyed('loudness', auth, LOUDNESS_KEYS, {
    setters: {
      replayGainEnabled: v =>
        useAuthStore.getState().setReplayGainEnabled(v as boolean),

      normalizationEngine: v =>
        useAuthStore.getState().setNormalizationEngine(
          v as AuthState['normalizationEngine'],
        ),

      loudnessTargetLufs: v =>
        useAuthStore.getState().setLoudnessTargetLufs(
          v as AuthState['loudnessTargetLufs'],
        ),

      loudnessPreAnalysisAttenuationDb: v =>
        useAuthStore.getState().setLoudnessPreAnalysisAttenuationDb(v as number),

      replayGainMode: v =>
        useAuthStore.getState().setReplayGainMode(
          v as AuthState['replayGainMode'],
        ),

      replayGainPreGainDb: v =>
        useAuthStore.getState().setReplayGainPreGainDb(v as number),

      replayGainFallbackDb: v =>
        useAuthStore.getState().setReplayGainFallbackDb(v as number),
    },
  }),

  keyed('lyrics', auth, LYRICS_KEYS),

  composite('appearance', [
    {
      name: 'theme',
      cat: keyed(
        'appearance.theme',
        useThemeStore as unknown as StoreLike,
        THEME_KEYS,
        {
          accept: (k, v) =>
            !['theme', 'themeDay', 'themeNight'].includes(k) ||
            themeAvailable(v),
        },
      ),
    },
    {
      name: 'app',
      cat: keyed('appearance.app', auth, APPEARANCE_AUTH_KEYS),
    },
  ]),

  keyed('eq', useEqStore as unknown as StoreLike, EQ_KEYS, {
    // Setting the store directly does not reach the audio engine, so push it too.
    after: s => {
      audioSetEq({
        gains: s.gains as number[],
        enabled: s.enabled as boolean,
        preGain: s.preGain as number,
      }).catch(() => {});
    },
  }),

  {
    id: 'keybindings',

    subscribe: l => useKeybindingsStore.subscribe(l),

    read: () => ({
      bindings: { ...useKeybindingsStore.getState().bindings },
    }),

    apply(value) {
      const incoming = value.bindings as
        | Record<string, unknown>
        | undefined;

      if (!incoming || typeof incoming !== 'object') return;

      const cur = useKeybindingsStore.getState()
        .bindings as Record<string, string | null>;

      const next = { ...cur };

      for (const k of Object.keys(cur)) {
        const v = incoming[k];

        if (typeof v === 'string' || v === null) {
          next[k] = v;
        }
      }

      if (!same(next, cur)) {
        useKeybindingsStore.setState({ bindings: next as typeof cur } as never);
      }
    },
  },
];

/** The category with this id, or undefined for an unknown id. */
export function findHubSettingsCategory(id: string): HubSettingsCategory | undefined {
  return HUB_SETTINGS_CATEGORIES.find(c => c.id === id);
}
