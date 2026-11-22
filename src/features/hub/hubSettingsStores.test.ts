import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_THEME_IDS } from '@/config/startupSplashPalettes';
import { useAuthStore } from '@/store/authStore';
import { useKeybindingsStore } from '@/store/keybindingsStore';
import { useThemeStore } from '@/store/themeStore';

import { findHubSettingsCategory, HUB_SETTINGS_CATEGORIES, type HubSettingsCategory } from './hubSettingsStores';

function category(id: string): HubSettingsCategory {
  const cat = findHubSettingsCategory(id);

  if (!cat) throw new Error(`no category ${id}`);

  return cat;
}

describe('hub settings stores', () => {
  it('has a category for every synced settings area and none for unknown ids', () => {
    expect(HUB_SETTINGS_CATEGORIES.map(c => c.id).sort()).toEqual(
      ['appearance', 'eq', 'keybindings', 'loudness', 'lyrics', 'playback'].sort(),
    );
    expect(findHubSettingsCategory('servers')).toBeUndefined();
  });

  it('applying a playback value then reading it back gives the same value', () => {
    const cat = category('playback');
    const before = cat.read();
    const value = {
      ...before,
      crossfadeSecs: (before.crossfadeSecs as number) + 2,
      gaplessEnabled: !before.gaplessEnabled,
    };

    cat.apply(value);

    expect(cat.read()).toEqual(value);
  });

  it('applies loudness values through the store setters', () => {
    // The setters also refresh the playing track's ReplayGain; a plain state write would not.
    const original = useAuthStore.getState();
    const setPreGain = vi.fn(original.setReplayGainPreGainDb);
    const setFallback = vi.fn(original.setReplayGainFallbackDb);
    useAuthStore.setState({ setReplayGainPreGainDb: setPreGain, setReplayGainFallbackDb: setFallback });

    try {
      const cat = category('loudness');
      const value = { ...cat.read(), replayGainPreGainDb: -4, replayGainFallbackDb: -9 };

      cat.apply(value);

      expect(setPreGain).toHaveBeenCalledWith(-4);
      expect(setFallback).toHaveBeenCalledWith(-9);
      expect(cat.read()).toEqual(value);
    } finally {
      useAuthStore.setState({
        setReplayGainPreGainDb: original.setReplayGainPreGainDb,
        setReplayGainFallbackDb: original.setReplayGainFallbackDb,
      });
    }
  });

  it('ignores keys that are not part of the category', () => {
    const cat = category('playback');
    const before = cat.read();

    cat.apply({ notASetting: 1, servers: [{ url: 'https://evil.example' }] });

    expect(cat.read()).toEqual(before);
    expect('notASetting' in useAuthStore.getState()).toBe(false);
    expect(useAuthStore.getState().servers).not.toEqual([{ url: 'https://evil.example' }]);
  });

  it('ignores a value of the wrong type', () => {
    const cat = category('playback');
    const before = cat.read();

    cat.apply({ crossfadeSecs: 'ten', gaplessEnabled: 'yes' });

    expect(cat.read()).toEqual(before);
  });

  it('adopts a built-in theme but not one this device does not have', () => {
    const cat = category('appearance');
    const current = useThemeStore.getState().theme;
    const other = BUILTIN_THEME_IDS.find(id => id !== current)!;

    cat.apply({ theme: { theme: 'not-installed-theme' } });
    expect(useThemeStore.getState().theme).toBe(current);

    cat.apply({ theme: { theme: other } });
    expect(useThemeStore.getState().theme).toBe(other);
    expect((cat.read().theme as Record<string, unknown>).theme).toBe(other);
  });

  it('applies known keybindings and ignores unknown actions', () => {
    const cat = category('keybindings');
    const bindings = useKeybindingsStore.getState().bindings as Record<string, string | null>;
    const action = Object.keys(bindings)[0];

    cat.apply({ bindings: { [action]: 'ctrl+shift+KeyJ', 'made-up-action': 'KeyQ' } });

    const after = cat.read().bindings as Record<string, string | null>;

    expect(after[action]).toBe('ctrl+shift+KeyJ');
    expect('made-up-action' in after).toBe(false);
  });

  it('notifies subscribers of local changes until unsubscribed', () => {
    const cat = category('lyrics');
    const listener = vi.fn();
    const unsubscribe = cat.subscribe(listener);

    useAuthStore.setState({ lyricsStaticOnly: !useAuthStore.getState().lyricsStaticOnly });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    useAuthStore.setState({ lyricsStaticOnly: !useAuthStore.getState().lyricsStaticOnly });
    expect(listener).not.toHaveBeenCalled();
  });
});
