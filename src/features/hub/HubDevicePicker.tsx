import { createPortal } from 'react-dom';
import { Check, Globe, Monitor, MonitorSpeaker, Smartphone } from 'lucide-react';
import { usePlayerBarAnchoredPopover } from '@/features/playback/hooks/usePlayerBarAnchoredPopover';
import { useHubStore } from './hubStore';
import { hubTransferTo } from './hubClient';
import { deviceCompatible } from './compat';

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
  const serverCheck = useHubStore(s => s.serverCheck);
  const { open, setOpen, toggleOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(260);

  if (status !== 'connected') return null;
  // Remote-only pages (kind "web") can't play audio, so they aren't valid targets.
  const players = devices.filter(d => d.kind !== 'web');
  const active = players.find(d => d.active);
  const elsewhere = !!active && active.id !== myId;
  // The queue moves through the music server, so a device on another server/account cannot take over.
  const source = active ?? players.find(d => d.id === myId);

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
          <div className="hub-device-title">Play on</div>
          {players.map(d => {
            const Icon = KIND_ICON[d.kind] ?? Monitor;
            const isActive = d.id === active?.id;
            const blocked = !isActive && !deviceCompatible(source, d, serverCheck);
            return (
              <button
                key={d.id}
                type="button"
                className={`hub-device-row${isActive ? ' hub-device-row--active' : ''}`}
                disabled={blocked}
                title={blocked ? 'Uses a different music server or account' : undefined}
                onClick={() => { if (!isActive) hubTransferTo(d.id); setOpen(false); }}
              >
                <Icon size={16} />
                <span className="hub-device-row__name">
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
