import { createPortal } from 'react-dom';
import { emit } from '@tauri-apps/api/event';
import { Check, Globe, Monitor, MonitorSpeaker, Smartphone } from 'lucide-react';
import { useMiniAnchoredPopover } from '@/features/miniPlayer/hooks/useMiniAnchoredPopover';
import { deviceCompatible } from '@/features/hub';
import type { MiniHubInfo } from '@/features/miniPlayer/utils/miniPlayerBridge';

const KIND_ICON = { desktop: Monitor, phone: Smartphone, web: Globe } as const;

/**
 * "Play on…" button for the mini player. The mini runs in its own window, so the
 * hub connection lives in the main window: the device list arrives with the sync
 * payload and a pick is sent back as `mini:hub-transfer`.
 */
export function MiniDevicePicker({ hub }: { hub: MiniHubInfo }) {
  const players = hub.devices.filter(d => d.kind !== 'web');
  const { open, setOpen, popStyle, btnRef, popRef } = useMiniAnchoredPopover(200, 44 + players.length * 34);
  const active = players.find(d => d.active);
  const elsewhere = !!active && active.id !== hub.myId;
  const source = active ?? players.find(d => d.id === hub.myId);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`mini-player__tool${open || elsewhere ? ' mini-player__tool--active' : ''}`}
        onClick={() => setOpen(v => !v)}
        data-tauri-drag-region="false"
        data-tooltip={elsewhere ? `Playing on ${active!.name}` : 'Play on a device'}
        aria-label="Play on a device"
      >
        <MonitorSpeaker size={13} />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          className="mini-player__crossfade-popover"
          style={popStyle}
          data-tauri-drag-region="false"
        >
          <div className="hub-device-title">Play on</div>
          {players.map(d => {
            const Icon = KIND_ICON[d.kind as keyof typeof KIND_ICON] ?? Monitor;
            const blocked = !d.active && !deviceCompatible(source, d, hub.serverCheck);
            return (
              <button
                key={d.id}
                type="button"
                className={`hub-device-row${d.active ? ' hub-device-row--active' : ''}`}
                data-tauri-drag-region="false"
                disabled={blocked}
                title={blocked ? 'Uses a different music server or account' : undefined}
                onClick={() => {
                  if (!d.active) emit('mini:hub-transfer', { to: d.id }).catch(() => {});
                  setOpen(false);
                }}
              >
                <Icon size={14} />
                <span className="hub-device-row__name">
                  {d.name}{d.id === hub.myId ? ' (this device)' : ''}
                </span>
                {d.active && <Check size={12} />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
