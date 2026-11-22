import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAllStores } from '@/test/helpers/storeReset';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import i18n from '@/lib/i18n';
import { useHubStore } from './hubStore';
import { HubControlSwitch } from './HubControlSwitch';

const living = { id: 'living', name: 'Living room', kind: 'desktop' as const, active: true };
const toggle = () => screen.getByRole('checkbox', { name: i18n.t('player.hubControl') });

describe('HubControlSwitch', () => {
  beforeEach(() => {
    resetAllStores();
    useHubStore.setState({ joined: true, devices: [living], remoteState: { from: 'living', ts: 0, playing: true } });
  });

  it('switching off lets this device play on its own', () => {
    renderWithProviders(<HubControlSwitch />);
    fireEvent.click(toggle());
    expect(useHubStore.getState().joined).toBe(false);
    expect(screen.getByText(i18n.t('player.hubControlOffHint'))).toBeTruthy();
  });

  it('switching back on rejoins at once when only one side is playing', () => {
    useHubStore.setState({ joined: false });
    usePlayerStore.setState({ isPlaying: false });
    renderWithProviders(<HubControlSwitch />);
    fireEvent.click(toggle());
    expect(useHubStore.getState().joined).toBe(true);
  });

  it('asks Join or Play here when both are playing, and Join stops the music here', () => {
    useHubStore.setState({ joined: false });
    let paused = false;
    usePlayerStore.setState({ isPlaying: true, pause: () => { paused = true; } });
    renderWithProviders(<HubControlSwitch />);

    fireEvent.click(toggle());
    expect(useHubStore.getState().joined).toBe(false);
    expect(screen.getByText(i18n.t('player.hubAlsoPlaying', { name: 'Living room' }))).toBeTruthy();

    fireEvent.click(screen.getByText(i18n.t('player.hubJoin')));
    expect(paused).toBe(true);
    expect(useHubStore.getState().joined).toBe(true);
  });
});
