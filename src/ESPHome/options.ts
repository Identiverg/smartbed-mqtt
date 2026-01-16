import { getRootOptions } from '@utils/options';

export interface BLEProxy {
  host: string;
  port: number | undefined;
  password: string | undefined;
  encryptionKey: string | undefined;
  expectedServerName: string | undefined;
}

export interface BLEProxyRecoveryOptions {
  autoRebootOnTimeout: boolean;
  rebootWindowMinutes: number;
  rebootCooldownMinutes: number;
}

interface OptionsJson {
  bleProxies: BLEProxy[];
  bleProxyAutoRebootOnTimeout?: boolean;
  bleProxyAutoRebootWindowMinutes?: number;
  bleProxyAutoRebootCooldownMinutes?: number;
}

const options: OptionsJson = getRootOptions();

export const getProxies = () => {
  const proxies = options.bleProxies;
  if (Array.isArray(proxies)) {
    return proxies;
  }
  return [];
};

export const getRecoveryOptions = (): BLEProxyRecoveryOptions => ({
  autoRebootOnTimeout: options.bleProxyAutoRebootOnTimeout ?? false,
  rebootWindowMinutes: Math.max(1, options.bleProxyAutoRebootWindowMinutes ?? 5),
  rebootCooldownMinutes: Math.max(1, options.bleProxyAutoRebootCooldownMinutes ?? 30),
});
