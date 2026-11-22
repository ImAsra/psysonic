import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import i18n from '@/lib/i18n';
import { useHubStore } from './hubStore';
import { HubConnectionTest } from './HubConnectionTest';
import type { HubTestResult } from './testHubConnection';

const testHubConnection = vi.hoisted(() => vi.fn());
vi.mock('./testHubConnection', () => ({ testHubConnection }));

const okText = () => i18n.t('settings.hubTestOk', { count: 2 });

describe('HubConnectionTest', () => {
  beforeEach(() => {
    testHubConnection.mockReset();
    useHubStore.getState().setUrl('https://hub-a.example');
    useHubStore.getState().setToken('token-a');
  });
  afterEach(() => {
    useHubStore.getState().setUrl('');
    useHubStore.getState().setToken('');
  });

  it('shows the result while the tested address and token are still the ones entered', async () => {
    testHubConnection.mockResolvedValue({ kind: 'ok', players: 2 } satisfies HubTestResult);
    renderWithProviders(<HubConnectionTest />);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.testBtn') })));

    expect(testHubConnection).toHaveBeenCalledWith('https://hub-a.example', 'token-a');
    expect(screen.getByRole('status').textContent).toContain(okText());
  });

  it('hides the result once the address or token changes, and shows it again when they are back', async () => {
    testHubConnection.mockResolvedValue({ kind: 'ok', players: 2 } satisfies HubTestResult);
    renderWithProviders(<HubConnectionTest />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.testBtn') })));

    act(() => useHubStore.getState().setUrl('https://hub-b.example'));
    expect(screen.queryByRole('status')).toBeNull();

    act(() => useHubStore.getState().setUrl('https://hub-a.example'));
    expect(screen.getByRole('status').textContent).toContain(okText());

    act(() => useHubStore.getState().setToken('token-b'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a test that finishes after the address changed shows nothing for the new address', async () => {
    let answer!: (r: HubTestResult) => void;
    testHubConnection.mockReturnValue(new Promise<HubTestResult>(r => (answer = r)));
    renderWithProviders(<HubConnectionTest />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.testBtn') }));

    act(() => useHubStore.getState().setUrl('https://hub-b.example'));
    await act(async () => answer({ kind: 'ok', players: 2 }));

    expect(screen.queryByRole('status')).toBeNull();
  });
});
