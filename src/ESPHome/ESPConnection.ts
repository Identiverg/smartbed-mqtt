import { Connection } from '@2colors/esphome-native-api';
import type { EntityList, ListEntitiesButtonResponse } from '@2colors/esphome-native-api';
import { Deferred } from '@utils/deferred';
import { logInfo, logWarn } from '@utils/logger';
import { IESPConnection } from './IESPConnection';
import { connect } from './connect';
import { BLEProxy } from './options';
import { BLEAdvertisement } from './types/BLEAdvertisement';
import { BLEDevice } from './types/BLEDevice';
import { IBLEDevice } from './types/IBLEDevice';

export class ESPConnection implements IESPConnection {
  private restartButtonKeys = new Map<string, number>();

  constructor(private connections: Connection[], private proxies: BLEProxy[] = []) {}

  async reconnect(): Promise<void> {
    this.disconnect();
    logInfo('[ESPHome] Reconnecting...');
    const configs = this.proxies.length
      ? this.proxies
      : this.connections.map((connection) => ({
          host: connection.host,
          port: connection.port,
          password: connection.password,
          encryptionKey: (connection as any).encryptionKey,
          expectedServerName: (connection as any).expectedServerName,
        }));
    this.connections = await Promise.all(configs.map((config) => connect(new Connection(config))));
  }

  async rebootProxy(host: string, port?: number): Promise<void> {
    const normalizedPort = this.normalizePort(port);
    const connection = this.connections.find(
      (candidate) => candidate.host === host && candidate.port === normalizedPort
    );
    const primaryResult = await this.tryRebootWithConnection(host, normalizedPort, connection);
    if (primaryResult) return;

    const proxyConfig = this.getProxyConfig(host, normalizedPort);
    if (!proxyConfig) {
      logWarn(`[ESPHome] No proxy config found for host: ${host}`);
      return;
    }

    const tempConnection = new Connection(proxyConfig);
    try {
      const tempResult = await this.tryRebootWithConnection(host, normalizedPort, tempConnection, true);
      if (!tempResult) logWarn(`[ESPHome] Failed to reboot proxy: ${host}`);
    } finally {
      tempConnection.disconnect();
    }
  }

  disconnect(): void {
    logInfo('[ESPHome] Disconnecting...');

    for (const connection of this.connections) {
      connection.disconnect();
      connection.connected = false;
    }
  }

  async getBLEDevices(deviceNames: string[], nameMapper?: (name: string) => string): Promise<IBLEDevice[]> {
    logInfo(`[ESPHome] Searching for device(s): ${deviceNames.join(', ')}`);
    deviceNames = deviceNames.map((name) => name.toLowerCase());
    const bleDevices: IBLEDevice[] = [];
    const complete = new Deferred<void>();
    await this.discoverBLEDevices(
      (bleDevice) => {
        const { name, mac } = bleDevice;
        let index = deviceNames.indexOf(mac);
        if (index === -1) index = deviceNames.indexOf(name.toLowerCase());
        if (index === -1) return;

        deviceNames.splice(index, 1);
        logInfo(`[ESPHome] Found device: ${name} (${mac})`);
        bleDevices.push(bleDevice);
        if (deviceNames.length) return;
        complete.resolve();
      },
      complete,
      nameMapper
    );
    if (deviceNames.length) logWarn(`[ESPHome] Cound not find address for device(s): ${deviceNames.join(', ')}`);
    return bleDevices;
  }

  async discoverBLEDevices(
    onNewDeviceFound: (bleDevice: IBLEDevice) => void,
    complete: Promise<void>,
    nameMapper?: (name: string) => string
  ) {
    const seenAddresses: number[] = [];
    const listenerBuilder = (connection: Connection) => ({
      connection,
      listener: (advertisement: BLEAdvertisement) => {
        let { name } = advertisement;
        const { address } = advertisement;

        if (seenAddresses.includes(address) || !name) return;
        seenAddresses.push(address);

        if (nameMapper) name = nameMapper(name);
        onNewDeviceFound(new BLEDevice(name, advertisement, connection));
      },
    });
    const listeners = this.connections.map(listenerBuilder);
    for (const { connection, listener } of listeners) {
      connection.on('message.BluetoothLEAdvertisementResponse', listener).subscribeBluetoothAdvertisementService();
    }
    await complete;
    for (const { connection, listener } of listeners) {
      connection.off('message.BluetoothLEAdvertisementResponse', listener);
    }
  }

  private async getRestartButtonKey(connection: Connection): Promise<number | undefined> {
    const cacheKey = this.getProxyKey(connection.host, connection.port);
    const cached = this.restartButtonKeys.get(cacheKey);
    if (cached !== undefined) return cached;

    const entities = (await connection.listEntitiesService()) as EntityList;
    const restartButton = entities.find(
      (entry) => entry.component === 'Button' && this.isRestartButton(entry.entity as ListEntitiesButtonResponse)
    );
    if (!restartButton) return undefined;

    const restartKey = (restartButton.entity as ListEntitiesButtonResponse).key;
    this.restartButtonKeys.set(cacheKey, restartKey);
    return restartKey;
  }

  private isRestartButton(entity: ListEntitiesButtonResponse): boolean {
    if (entity.deviceClass?.toLowerCase() === 'restart') return true;
    const candidates = [entity.objectId, entity.name, entity.uniqueId]
      .filter((value) => value)
      .map((value) => value!.toLowerCase());
    return candidates.some((value) => value.includes('restart') || value.includes('reboot'));
  }

  private async tryRebootWithConnection(
    host: string,
    port: number,
    connection?: Connection,
    useLocalConnection: boolean = false
  ): Promise<boolean> {
    if (!connection) return false;
    try {
      await this.ensureAuthorized(connection);

      const restartKey = await this.getRestartButtonKey(connection);
      if (restartKey === undefined) {
        logWarn(`[ESPHome] Restart button not found for proxy: ${host}`);
        return false;
      }

      logInfo(`[ESPHome] Rebooting proxy: ${host}:${port}`);
      connection.buttonCommandService({ key: restartKey });
      return true;
    } catch (error) {
      if (!useLocalConnection) {
        logWarn(`[ESPHome] Proxy connection failed for host: ${host}`, error);
      }
      return false;
    }
  }

  private async ensureAuthorized(connection: Connection, timeoutMs: number = 10_000): Promise<void> {
    if (connection.authorized) return;

    await new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const onAuthorized = () => {
        cleanup();
        resolve();
      };
      const onError = (error: any) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        connection.off('authorized', onAuthorized);
        connection.off('error', onError);
        if (timeout) clearTimeout(timeout);
      };

      connection.once('authorized', onAuthorized);
      connection.once('error', onError);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`[ESPHome] Authorization timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (!connection.connected) {
        try {
          connection.connect();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    });
  }

  private getProxyConfig(host: string, port: number): BLEProxy | undefined {
    return this.proxies.find(
      (proxy) => proxy.host === host && this.normalizePort(proxy.port) === port
    );
  }

  private getProxyKey(host: string, port?: number): string {
    return `${host}:${this.normalizePort(port)}`;
  }

  private normalizePort(port?: number): number {
    return port ?? 6053;
  }
}
