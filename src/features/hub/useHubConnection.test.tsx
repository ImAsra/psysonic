
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startHubClient } from './hubClient';
import { useHubStore } from './hubStore';
import { useHubConnection } from './useHubConnection';

vi.mock('./hubClient', async importOriginal => {
  const actual = await importOriginal<typeof import('./hubClient')>();
  return {
    ...actual,
    startHubClient: vi.fn(),
  };
});

describe('useHubConnection', () => {
  const stopClient = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    useHubStore.setState({
      enabled: false,
      url: '',
      token: '',
      status: 'off',
      devices: [],
      remoteState: null,
    });

    vi.mocked(startHubClient).mockReturnValue(stopClient);
  });

  it('does not start the client while the hub is disabled', () => {
    renderHook(() => useHubConnection());

    expect(startHubClient).not.toHaveBeenCalled();
  });

  it('starts the client when enabled with valid configuration', () => {
    useHubStore.setState({
      enabled: true,
      url: 'http://localhost:5599',
      token: 'test-token',
    });

    renderHook(() => useHubConnection());

    expect(startHubClient).toHaveBeenCalledTimes(1);
  });

  it('does not start the client when configuration is incomplete', () => {
    useHubStore.setState({
      enabled: true,
      url: 'http://localhost:5599',
      token: '',
    });

    renderHook(() => useHubConnection());

    expect(startHubClient).not.toHaveBeenCalled();
  });

  it('does not recursively start when startup synchronously updates runtime state', () => {
    vi.mocked(startHubClient).mockImplementation(() => {
      useHubStore.getState().setRuntime({ status: 'connecting' });
      return stopClient;
    });

    useHubStore.setState({
      enabled: true,
      url: 'http://localhost:5599',
      token: 'test-token',
    });

    renderHook(() => useHubConnection());

    expect(startHubClient).toHaveBeenCalledTimes(1);
    expect(useHubStore.getState().status).toBe('connecting');
  });

  it('stops the client and resets runtime state when disabled', () => {
    useHubStore.setState({
      enabled: true,
      url: 'http://localhost:5599',
      token: 'test-token',
    });

    renderHook(() => useHubConnection());

    useHubStore.setState({
      status: 'connected',
      devices: [{
        id: 'device-1',
        name: 'Other device',
        kind: 'desktop',
        active: true,
      }],
      remoteState: { from: 'device-1', ts: Date.now() },
    });

    act(() => {
      useHubStore.getState().setEnabled(false);
    });

    expect(stopClient).toHaveBeenCalledTimes(1);
    expect(useHubStore.getState().status).toBe('off');
    expect(useHubStore.getState().devices).toEqual([]);
    expect(useHubStore.getState().remoteState).toBeNull();
  });

  it('does not start a duplicate client when URL or token changes', () => {
    useHubStore.setState({
      enabled: true,
      url: 'http://localhost:5599',
      token: 'test-token',
    });

    renderHook(() => useHubConnection());

    act(() => {
      useHubStore.getState().setUrl('http://localhost:6600');
      useHubStore.getState().setToken('updated-token');
    });

    expect(startHubClient).toHaveBeenCalledTimes(1);
    expect(stopClient).not.toHaveBeenCalled();
  });

  it('starts the client again when re-enabled', () => {
    useHubStore.setState({
      url: 'http://localhost:5599',
      token: 'test-token',
    });

    renderHook(() => useHubConnection());

    act(() => {
      useHubStore.getState().setEnabled(true);
    });

    expect(startHubClient).toHaveBeenCalledTimes(1);

    act(() => {
      useHubStore.getState().setEnabled(false);
    });

    act(() => {
      useHubStore.getState().setEnabled(true);
    });

    expect(startHubClient).toHaveBeenCalledTimes(2);
    expect(stopClient).toHaveBeenCalledTimes(1);
  });

  it('stops the client when the hook unmounts', () => {
    useHubStore.setState({
      enabled: true,
      url: 'http://localhost:5599',
      token: 'test-token',
    });

    const { unmount } = renderHook(() => useHubConnection());

    expect(startHubClient).toHaveBeenCalledTimes(1);

    unmount();

    expect(stopClient).toHaveBeenCalledTimes(1);
  });
});
