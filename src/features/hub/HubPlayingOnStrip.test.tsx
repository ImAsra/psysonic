import { beforeEach, describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAllStores } from '@/test/helpers/storeReset';
import i18n from '@/lib/i18n';
import { useHubStore } from './hubStore';
import { HubPlayingOnStrip } from './HubPlayingOnStrip';

const me = { id: 'me', name: 'Desk', kind: 'desktop' as const, active: false };
const phone = { id: 'phone', name: 'Phone 1', kind: 'phone' as const, active: true };
const label = () => i18n.t('player.hubPlayingOn', { name: 'Phone 1' });

function renderStrip() {
  const anchor = createRef<HTMLElement>();
  return renderWithProviders(
    <>
      <footer ref={anchor} />
      <HubPlayingOnStrip anchor={anchor} />
    </>,
  );
}

describe('HubPlayingOnStrip', () => {
  beforeEach(() => {
    resetAllStores();
    useHubStore.setState({ status: 'connected', joined: true, deviceId: 'me', devices: [me, phone] });
  });

  it('names the device that plays while another one plays', () => {
    renderStrip();
    expect(screen.getByText(label())).toBeTruthy();
  });

  it('shows nothing while this device plays itself', () => {
    useHubStore.setState({ devices: [{ ...me, active: true }, { ...phone, active: false }] });
    renderStrip();
    expect(screen.queryByText(label())).toBeNull();
  });

  it('shows nothing while this device plays on its own (hub control off)', () => {
    useHubStore.setState({ joined: false });
    renderStrip();
    expect(screen.queryByText(label())).toBeNull();
  });

  it('shows nothing without a hub connection', () => {
    useHubStore.setState({ status: 'connecting' });
    renderStrip();
    expect(screen.queryByText(label())).toBeNull();
  });

  it('a click opens the Play on list', () => {
    renderStrip();
    fireEvent.click(screen.getByText(label()));
    expect(screen.getByText(i18n.t('player.hubPlayOn'))).toBeTruthy();
    expect(screen.getByText(i18n.t('player.hubControl'))).toBeTruthy();
  });
});
