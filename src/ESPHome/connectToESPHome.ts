import { logInfo } from '@utils/logger';
import { ESPConnection } from './ESPConnection';
import { IESPConnection } from './IESPConnection';
import { connectWithRetry } from './connect';
import { BLEProxy, getProxies } from './options';

export const connectToESPHome = async (): Promise<IESPConnection> => {
  logInfo('[ESPHome] Connecting...');

  const proxies = getProxies();
  const connections =
    proxies.length == 0
      ? []
      : await Promise.all(
          proxies.map(async (config: BLEProxy) => await connectWithRetry(config))
        );
  return new ESPConnection(connections, proxies);
};
