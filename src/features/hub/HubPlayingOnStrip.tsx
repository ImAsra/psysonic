import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Globe, Monitor, Smartphone } from 'lucide-react';
import { usePlayerBarAnchoredPopover } from '@/features/playback/hooks/usePlayerBarAnchoredPopover';
import { useHubStore } from './hubStore';
import { HubPlayOnList } from './HubPlayOnList';

const KIND_ICON = { desktop: Monitor, phone: Smartphone, web: Globe } as const;
/** On the floating (pill) bar: a small pill this far in from the bar's right end and above it. */
const FLOATING_INSET = 40;
const FLOATING_GAP = 6;

/**
 * Where the strip goes: across the top edge of the docked bar, or as a small pill above the right
 * end of the floating bar (a straight band does not fit its round ends). Kept up to date.
 */
function useStripPosition(anchor: RefObject<HTMLElement | null>, on: boolean) {
  const [place, setPlace] = useState<{ style: React.CSSProperties; floating: boolean }>({
    style: { display: 'none' },
    floating: false,
  });

  useLayoutEffect(() => {
    const el = anchor.current;
    if (!on || !el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const bottom = window.innerHeight - r.top;
      if (el.classList.contains('floating')) {
        setPlace({
          floating: true,
          style: { right: window.innerWidth - r.right + FLOATING_INSET, bottom: bottom + FLOATING_GAP },
        });
      } else {
        setPlace({ floating: false, style: { left: r.left, width: r.width, bottom } });
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, on]);

  return place;
}

/**
 * A strip along the top edge of the player bar while another device plays through the hub
 * ("Playing on …", like Spotify Connect). Clicking it opens the Play on list. Nothing shows
 * while this device plays itself or plays on its own (hub control off). The bar clips what
 * sticks out of it (`contain: paint`), so the strip lives in `document.body`.
 */
export function HubPlayingOnStrip({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const status = useHubStore(s => s.status);
  const joined = useHubStore(s => s.joined);
  const myId = useHubStore(s => s.deviceId);
  const active = useHubStore(s => s.devices.find(d => d.active && d.kind !== 'web'));
  const shown = status === 'connected' && joined && !!active && active.id !== myId;
  const { style, floating } = useStripPosition(anchor, shown);
  const { open, setOpen, toggleOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(280);

  if (!shown || !active) return null;
  const Icon = KIND_ICON[active.kind] ?? Monitor;
  const label = t('player.hubPlayingOn', { name: active.name });

  return createPortal(
    <>
      <button
        ref={btnRef}
        type="button"
        className={`hub-playing-on-strip${floating ? ' hub-playing-on-strip--floating' : ''}`}
        style={style}
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label={`${label}. ${t('player.hubPlayOnDevice')}`}
      >
        <Icon size={13} aria-hidden />
        <span>{label}</span>
      </button>
      {open && (
        <div ref={popRef} className="player-playback-rate-popover" style={popStyle}>
          <div className="hub-device-title">{t('player.hubPlayOn')}</div>
          <HubPlayOnList onPicked={() => setOpen(false)} />
        </div>
      )}
    </>,
    document.body,
  );
}
