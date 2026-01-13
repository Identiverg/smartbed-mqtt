import { Connection } from '@2colors/esphome-native-api';
import type { ConnectionConfig } from '@2colors/esphome-native-api';
import { logError, logInfo, logWarn } from '@utils/logger';
import { wait } from '@utils/wait';

export const connect = (connection: Connection) => {
  return new Promise<Connection>((resolve, reject) => {
    const errorHandler = (error: any) => {
      logError('[ESPHome] Failed Connecting:', error);
      reject(error);
    };
    connection.once('authorized', async () => {
      logInfo('[ESPHome] Connected:', connection.host);
      connection.off('error', errorHandler);
      // TODO: Fix next two lines after new version of esphome-native-api is released
      const deviceInfo = await connection.deviceInfoService();
      const { bluetoothProxyFeatureFlags } = deviceInfo as any;
      if (!bluetoothProxyFeatureFlags) {
        logError('[ESPHome] No Bluetooth proxy features detected:', connection.host);
        return reject();
      }
      resolve(connection);
    });
    const doConnect = (handler: (error: any) => void) => {
      try {
        connection.once('error', handler);
        connection.connect();
        connection.off('error', handler);
        connection.once('error', errorHandler);
      } catch (err) {
        errorHandler(err);
      }
    };
    const retryHandler = (error: any) => {
      logError('[ESPHome] Failed Connecting (will retry):', error);
      doConnect(errorHandler);
    };
    doConnect(retryHandler);
  });
};

export const connectWithRetry = async (config: ConnectionConfig) => {
  let delayMs = 1_000;
  const maxDelayMs = 30_000;
  const port = config.port ?? 6053;
  while (true) {
    const connection = new Connection({ ...config, reconnect: config.reconnect ?? false });
    try {
      return await connect(connection);
    } catch (error) {
      logWarn(`[ESPHome] Connect failed, retrying in ${delayMs}ms: ${config.host}:${port}`);
      try {
        connection.disconnect();
      } catch {}
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
};
