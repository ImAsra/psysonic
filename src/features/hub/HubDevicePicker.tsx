import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MonitorSpeaker } from 'lucide-react';
import { usePlayerBarAnchoredPopover } from '@/features/playback/hooks/usePlayerBarAnchoredPopover';
import { useHubStore } from './hubStore';
import { HubPlayOnList } from './HubPlayOnList';

/**
 * "Play on…" button for the player bar (Spotify Connect style).
 * Only renders while connected to a hub. Picking a device moves playback there;
 * the hub makes sure only one device plays at a time. The "Hub control" switch at the
 * bottom lets this device play on its own; meanwhile the list only shows what the others play.
 */
export function HubDevicePicker({ className, iconSize = 15 }: { className?: string; iconSize?: number } = {}) {
  const { t } = useTranslation();
  const status = useHubStore(s => s.status);
  const myId = useHubStore(s => s.deviceId);
  const joined = useHubStore(s => s.joined);
  // Remote-only pages (kind "web") can't play audio, so they are never the active player.
  const active = useHubStore(s => s.devices.find(d => d.active && d.kind !== 'web'));
  const { open, setOpen, toggleOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(280);

  if (status !== 'connected') return null;
  const elsewhere = joined && !!active && active.id !== myId;
  const tooltip = !joined
    ? t('player.hubOnItsOwn')
    : elsewhere
      ? t('player.hubPlayingOn', { name: active!.name })
      : t('player.hubPlayOnDevice');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${className ?? 'player-btn player-btn-sm'}${open ? ' active' : ''}${joined ? '' : ' hub-picker--alone'}`}
        onClick={toggleOpen}
        aria-label={t('player.hubPlayOnDevice')}
        aria-expanded={open}
        data-tooltip={tooltip}
        style={elsewhere ? { color: 'var(--accent)' } : undefined}
      >
        <MonitorSpeaker size={iconSize} />
      </button>

      {open && createPortal(
        <div ref={popRef} className="player-playback-rate-popover" style={popStyle}>
          <div className="hub-device-title">{t('player.hubPlayOn')}</div>
          <HubPlayOnList onPicked={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}
