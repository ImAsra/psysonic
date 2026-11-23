import { useTranslation } from 'react-i18next';
import { Check, Globe, Monitor, Smartphone } from 'lucide-react';
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
 * The players on the hub and the "Hub control" switch: the body of every Play on menu; a
 * `className` lets a layout restyle it (bigger rows on a touch screen). Picking a device moves
 * playback there; while this device plays on its own, or the connection is not up, the rows only
 * show what the others play (a pick could not be sent).
 */
export function HubPlayOnList({ onPicked, className }: { onPicked?: () => void; className?: string }) {
  const { t } = useTranslation();
  const devices = useHubStore(s => s.devices);
  const myId = useHubStore(s => s.deviceId);
  const joined = useHubStore(s => s.joined);
  const connected = useHubStore(s => s.status === 'connected');
  const serverCheck = useHubStore(s => s.serverCheck);
  const remoteState = useHubStore(s => s.remoteState);

  // Remote-only pages (kind "web") can't play audio, so they aren't valid targets.
  const players = devices.filter(d => d.kind !== 'web');
  const active = players.find(d => d.active);
  // The queue moves through the music server, so a device on another server/account cannot take over.
  const source = active ?? players.find(d => d.id === myId);

  return (
    <div className={className ? `hub-device-list ${className}` : 'hub-device-list'}>
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
        // On its own (or not connected) this device can't move playback anywhere: the list is for looking only.
        if (!joined || !connected) return <div key={d.id} className={`${cls} hub-device-row--info`}>{body}</div>;
        return (
          <button
            key={d.id}
            type="button"
            className={cls}
            disabled={blocked}
            title={blocked ? t('player.hubDifferentServer') : undefined}
            onClick={() => { if (!isActive) hubTransferTo(d.id); onPicked?.(); }}
          >
            {body}
          </button>
        );
      })}
      <HubControlSwitch />
    </div>
  );
}
