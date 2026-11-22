import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Globe, Monitor, MonitorSpeaker, Smartphone } from 'lucide-react';
import { usePlayerBarAnchoredPopover } from '@/features/playback/hooks/usePlayerBarAnchoredPopover';
import { useHubStore, type HubDevice, type HubRemoteState } from './hubStore';
import { hubTransferTo } from './hubClient';
import { deviceCompatible } from './compat';
import { HubControlSwitch } from './HubControlSwitch';

const KIND_ICON = { desktop: Monitor, phone: Smartphone, web: Globe } as const;

/** What a device is playing, as "Title — Artist" (only for the one playing through the hub). */
function nowPlayingOn(device: HubDevice, state: HubRemoteState | null): string {
  if (!state?.playing || state.from !== device.id || !state.title) return '';
  return state.artist ? `${state.title} — ${state.artist}` : state.title;
}

/**
 * "Play on…" button for the player bar (Spotify Connect style).
 * Only renders while connected to a hub. Picking a device moves playback there;
 * the hub makes sure only one device plays at a time. The "Hub control" switch at the
 * bottom lets this device play on its own; meanwhile the list only shows what the others play.
 */
export function HubDevicePicker({ className, iconSize = 15 }: { className?: string; iconSize?: number } = {}) {
  const { t } = useTranslation();
  const status = useHubStore(s => s.status);
  const devices = useHubStore(s => s.devices);
  const myId = useHubStore(s => s.deviceId);
  const joined = useHubStore(s => s.joined);
  const serverCheck = useHubStore(s => s.serverCheck);
  const remoteState = useHubStore(s => s.remoteState);
  const { open, setOpen, toggleOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(280);

  if (status !== 'connected') return null;
  // Remote-only pages (kind "web") can't play audio, so they aren't valid targets.
  const players = devices.filter(d => d.kind !== 'web');
  const active = players.find(d => d.active);
  const elsewhere = joined && !!active && active.id !== myId;
  // The queue moves through the music server, so a device on another server/account cannot take over.
  const source = active ?? players.find(d => d.id === myId);
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
          {players.map(d => {
            const Icon = KIND_ICON[d.kind] ?? Monitor;
            const isActive = d.id === active?.id;
            const blocked = !isActive && !deviceCompatible(source, d, serverCheck);
            const playing = nowPlayingOn(d, remoteState);
            const body = (
              <>
                <Icon size={16} />
                <span className="hub-device-row__name">
                  {d.name}{d.id === myId ? ` (${t('settings.hubThisDevice')})` : ''}
                  {playing && <span className="hub-device-row__playing">{playing}</span>}
                </span>
                {isActive && <Check size={14} />}
              </>
            );
            const cls = `hub-device-row${isActive ? ' hub-device-row--active' : ''}`;
            // On its own this device can't move playback anywhere: the list is for looking only.
            if (!joined) return <div key={d.id} className={`${cls} hub-device-row--info`}>{body}</div>;
            return (
              <button
                key={d.id}
                type="button"
                className={cls}
                disabled={blocked}
                title={blocked ? t('player.hubDifferentServer') : undefined}
                onClick={() => { if (!isActive) hubTransferTo(d.id); setOpen(false); }}
              >
                {body}
              </button>
            );
          })}
          <HubControlSwitch />
        </div>,
        document.body,
      )}
    </>
  );
}
