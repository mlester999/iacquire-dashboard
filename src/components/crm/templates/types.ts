// Serializable shapes the templates screen receives from its server view. No secrets: test destinations are the workspace's own addresses.
import type { Channel } from "@/lib/messaging";

export interface ChannelState {
  channel: Channel;
  enabled: boolean;
  providerLabel: string;
  /** This environment lets the channel's provider send at all (its own kill switch). */
  writesEnabled: boolean;
  whyOff: string | null;
}

export interface TestDestination {
  channel: Channel;
  address: string;
  label: string;
}

export interface FolderOption {
  id: string;
  name: string;
}
