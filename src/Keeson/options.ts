import { getRootOptions } from '@utils/options';

export interface KeesonDevice {
  friendlyName: string;
  name: string;
  variant?: 'auto' | 'base' | 'ksbt';
  stayConnected?: boolean;
  motorPulseCount?: number;
  motorPulseDelayMs?: number;
}

interface OptionsJson {
  keesonDevices: KeesonDevice[];
}

const options: OptionsJson = getRootOptions();

export const getDevices = () => {
  const devices = options.keesonDevices;
  if (Array.isArray(devices)) {
    return devices;
  }
  return [];
};
