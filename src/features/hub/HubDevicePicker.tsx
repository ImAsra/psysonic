import { createPortal } from 'react-dom';
import { Check, Globe, Monitor, MonitorSpeaker, Smartphone } from 'lucide-react';
import { usePlayerBarAnchoredPopover } from '@/features/playback/hooks/usePlayerBarAnchoredPopover';
import { useHubStore } from './hubStore';
import { hubTransferTo } from './hubClient';

const KIND_ICON = { desktop: Monitor, phone: Smartphone, web: Globe } as const;

/**
 * "Play on…" button for the player bar (Spotify Connect style).
 * Only renders while connected to a hub. Picking a device moves playback there;
 * the hub makes sure only one device plays at a time.
 */
export function HubDevicePicker({ className, iconSize = 15 }: { className?: string; iconSize?: number } = {}) {
  const status = useHubStore(s => s.status);
  const devices = useHubStore(s => s.devices);
  const myId = useHubStore(s => s.deviceId);
  const { open, setOpen, toggleOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(260);

  if (status !== 'connected') return null;
  // Remote-only pages (kind "web") can't play audio, so they aren't valid targets.
  const players = devices.filter(d => d.kind !== 'web');
  const active = players.find(d => d.active);
  const elsewhere = !!active && active.id !== myId;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${className ?? 'player-btn player-btn-sm'}${open ? ' active' : ''}`}
        onClick={toggleOpen}
        aria-label="Play on a device"
        aria-expanded={open}
        data-tooltip={elsewhere ? `Playing on ${active!.name}` : 'Play on a device'}
        style={elsewhere ? { color: 'var(--accent)' } : undefined}
      >
        <MonitorSpeaker size={iconSize} />
      </button>

      {open && createPortal(
        <div ref={popRef} className="player-playback-rate-popover" style={popStyle}>
          <div style={{ fontSize: 12, opacity: 0.7, padding: '0 4px' }}>Play on</div>
          {players.map(d => {
            const Icon = KIND_ICON[d.kind] ?? Monitor;
            const isActive = d.id === active?.id;
            return (
              <button
                key={d.id}
                type="button"
                className="player-btn"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  justifyContent: 'flex-start', padding: '8px',
                  color: isActive ? 'var(--accent)' : undefined,
                }}
                onClick={() => { if (!isActive) hubTransferTo(d.id); setOpen(false); }}
              >
                <Icon size={16} />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {d.name}{d.id === myId ? ' (this device)' : ''}
                </span>
                {isActive && <Check size={14} />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
