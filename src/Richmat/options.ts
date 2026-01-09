import { getRootOptions } from '@utils/options';

export interface RichmatDevice {
  friendlyName: string;
  name: string;
  remoteCode: string;
  stayConnected: boolean | undefined;
  commandProtocol: 'wilinke' | 'nordic' | 'single' | 'prefix55' | 'prefixaa' | undefined;
  motorPulseCount?: number;
  motorPulseDelayMs?: number;
}

interface OptionsJson {
  richmatDevices: RichmatDevice[];
}

const options: OptionsJson = getRootOptions();

export const getDevices = () => {
  const devices = options.richmatDevices;
  if (Array.isArray(devices)) {
    return devices;
  }
  return [];
};
