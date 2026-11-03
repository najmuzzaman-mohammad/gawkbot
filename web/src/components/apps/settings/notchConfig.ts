import type { ConfigSnapshot, ConfigUpdate } from "../../../api/client";

/**
 * Settings the notch page owns. They live here, not in api/client.ts, which
 * sits at its file-size ceiling; the broker reads and writes them through
 * the same GET/PATCH /config as every other field.
 */
export interface NotchConfig {
  /** Bots act on this Mac without asking each turn; default false. */
  mac_computer_always_allow?: boolean;
  /** Bots speak up out loud when they need you or finish; default true. */
  notch_announce?: boolean;
  /** The office looks for bots worth having once a day; default true, at 9. */
  notch_ideas?: boolean;
  notch_ideas_hour?: number;
}

export type NotchConfigSnapshot = ConfigSnapshot & NotchConfig;
export type NotchConfigUpdate = ConfigUpdate & Partial<NotchConfig>;

/**
 * Props for a section that reads notch settings. A parent holding a plain
 * ConfigSnapshot and a ConfigUpdate saver satisfies it: the snapshot only
 * gains optional keys, and the saver accepts a superset of the patch.
 */
export interface NotchSectionProps {
  cfg: NotchConfigSnapshot;
  save: (patch: NotchConfigUpdate) => Promise<void>;
}
