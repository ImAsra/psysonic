import {
  findHubSettingsCategory,
  HUB_SETTINGS_CATEGORIES,
  type HubSettingsCategory,
  type HubSettingsValue,
} from './hubSettingsStores';

/**
 * Settings sync through the hub, in opt-in categories. The hub decides which
 * categories are switched on (toggled from its web page) and keeps the latest
 * value of each; every device adopts those values and pushes its own changes.
 * The stores behind each category live in hubSettingsStores.ts.
 */

type Json = HubSettingsValue;

export interface SettingsSync {
  /** Fresh connection: the hub's stored values and which categories are switched on. */
  onWelcome(settings: Record<string, Json>, config: Record<string, boolean>): void;

  /** The hub's category switches changed (toggled from the web page). */
  onConfig(config: Record<string, boolean>): void;

  /** Another device changed a category. */
  onSettings(category: string, value: Json): void;

  /** The local master switch changed. */
  refresh(): void;

  dispose(): void;
}

export function createSettingsSync(deps: {
  send: (msg: unknown) => void;
  isConnected: () => boolean;
  isEnabled: () => boolean;
}): SettingsSync {
  const hubValues: Record<string, Json> = {};
  let config: Record<string, boolean> = {};

  const lastSynced = new Map<string, string>();
  const unsubs = new Map<string, () => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const active = (id: string) =>
    deps.isEnabled() && deps.isConnected() && config[id] === true;

  function pushIfChanged(cat: HubSettingsCategory, init = false) {
    if (!active(cat.id)) return;

    const json = JSON.stringify(cat.read());

    if (json === lastSynced.get(cat.id)) return;

    lastSynced.set(cat.id, json);

    // init = "I am only filling an empty slot": the hub keeps an existing
    // value and tells us to adopt it.
    deps.send({
      t: 'settings',
      category: cat.id,
      value: JSON.parse(json),
      init,
    });
  }

  function adopt(cat: HubSettingsCategory, value: Json) {
    cat.apply(value);

    // What we hold now is "in sync": do not echo it back.
    lastSynced.set(cat.id, JSON.stringify(cat.read()));
  }

  function watch(cat: HubSettingsCategory) {
    if (unsubs.has(cat.id)) return;

    unsubs.set(
      cat.id,
      cat.subscribe(() => {
        clearTimeout(timers.get(cat.id));

        timers.set(
          cat.id,
          setTimeout(() => pushIfChanged(cat), 250),
        ); // debounce slider drags
      }),
    );
  }

  function unwatch(id: string) {
    unsubs.get(id)?.();
    unsubs.delete(id);

    clearTimeout(timers.get(id));
    timers.delete(id);
    lastSynced.delete(id);
  }

  function reconcile(cat: HubSettingsCategory) {
    const hv = hubValues[cat.id];

    if (hv && Object.keys(hv).length > 0) {
      adopt(cat, hv); // the hub's copy wins on connect
    } else {
      lastSynced.delete(cat.id);
      pushIfChanged(cat, true); // empty on the hub: offer ours
    }
  }

  function sync() {
    for (const cat of HUB_SETTINGS_CATEGORIES) {
      if (active(cat.id)) {
        if (!unsubs.has(cat.id)) {
          watch(cat);
          reconcile(cat);
        }
      } else {
        unwatch(cat.id);
      }
    }
  }

  return {
    onWelcome(settings, cfg) {
      // Every (re)connection reconciles from scratch.
      for (const cat of HUB_SETTINGS_CATEGORIES) {
        unwatch(cat.id);
      }

      for (const k of Object.keys(hubValues)) {
        delete hubValues[k];
      }

      Object.assign(hubValues, settings);
      config = { ...cfg };

      sync();
    },

    onConfig(cfg) {
      config = { ...cfg };

      for (const id of Object.keys(hubValues)) {
        if (!config[id]) {
          delete hubValues[id];
        }
      }

      sync();
    },

    onSettings(category, value) {
      hubValues[category] = value;

      const cat = findHubSettingsCategory(category);

      if (cat && active(cat.id)) {
        adopt(cat, value);
      }
    },

    refresh: sync,

    dispose() {
      for (const cat of HUB_SETTINGS_CATEGORIES) {
        unwatch(cat.id);
      }
    },
  };
}