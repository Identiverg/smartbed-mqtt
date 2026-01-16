import { Connection } from '@2colors/esphome-native-api';
import type { ConnectionConfig, EntityList, ListEntitiesButtonResponse } from '@2colors/esphome-native-api';
import { Deferred } from '@utils/deferred';
import { logInfo, logWarn } from '@utils/logger';
import { IESPConnection } from './IESPConnection';
import { connectWithRetry } from './connect';
import { BLEProxy, BLEProxyRecoveryOptions, getRecoveryOptions } from './options';
import { BLEAdvertisement } from './types/BLEAdvertisement';
import { BLEDevice } from './types/BLEDevice';
import { IBLEDevice } from './types/IBLEDevice';

export class ESPConnection implements IESPConnection {
  private restartButtonKeys = new Map<string, number>();
  private bleDevices = new Set<BLEDevice>();
  private connectionRefreshes = new Map<string, Promise<void>>();
  private intentionalDisconnects = new Set<Connection>();
  private proxyTimeouts = new Map<string, number>();
  private proxyReboots = new Map<string, number>();
  private proxyRecovery: BLEProxyRecoveryOptions;

  constructor(
    private connections: Connection[],
    private proxies: BLEProxy[] = [],
    recoveryOptions: BLEProxyRecoveryOptions = getRecoveryOptions()
  ) {
    this.proxyRecovery = recoveryOptions;
    this.connections.forEach((connection) => this.attachConnectionHandlers(connection));
  }

  async reconnect(): Promise<void> {
    const previousConnections = this.connections;
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
    this.connections = await Promise.all(configs.map((config) => connectWithRetry(config)));
    this.connections.forEach((connection) => this.attachConnectionHandlers(connection));
    const connectionByKey = new Map(
      this.connections.map((connection) => [this.getProxyKey(connection.host, connection.port), connection])
    );
    for (const device of this.bleDevices) {
      const previous = previousConnections.find((connection) => device.usesConnection(connection));
      if (!previous) continue;
      const next = connectionByKey.get(this.getProxyKey(previous.host, previous.port));
      if (next) device.updateConnection(next);
    }
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

    const tempConnection = new Connection({ ...proxyConfig, reconnect: false });
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
      this.intentionalDisconnects.add(connection);
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
        const device = new BLEDevice(name, advertisement, connection);
        this.registerBLEDevice(device);
        onNewDeviceFound(device);
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

  private registerBLEDevice(device: BLEDevice) {
    this.bleDevices.add(device);
  }

  private attachConnectionHandlers(connection: Connection) {
    const key = this.getProxyKey(connection.host, connection.port);
    connection.on('error', (error) => {
      logWarn(`[ESPHome] Connection error (${key})`, error);
      this.maybeAutoRebootProxy(connection, error);
      this.scheduleConnectionRefresh(connection, 'error');
    });
    connection.on('disconnected', () => {
      logWarn(`[ESPHome] Connection disconnected (${key})`);
      this.scheduleConnectionRefresh(connection, 'disconnected');
    });
  }

  private scheduleConnectionRefresh(connection: Connection, reason: string) {
    if (this.intentionalDisconnects.has(connection)) {
      this.intentionalDisconnects.delete(connection);
      return;
    }
    if (!this.connections.includes(connection)) return;
    const key = this.getProxyKey(connection.host, connection.port);
    if (this.connectionRefreshes.has(key)) return;
    const refresh = this.refreshConnection(connection, reason)
      .catch((error) => {
        logWarn(`[ESPHome] Connection refresh failed (${key})`, error);
      })
      .finally(() => {
        if (this.connectionRefreshes.get(key) === refresh) {
          this.connectionRefreshes.delete(key);
        }
      });
    this.connectionRefreshes.set(key, refresh);
  }

  private async refreshConnection(connection: Connection, reason: string) {
    const key = this.getProxyKey(connection.host, connection.port);
    logWarn(`[ESPHome] Refreshing connection (${key}) due to ${reason}`);
    const config = this.buildConnectionConfig(connection);
    const newConnection = await connectWithRetry(config);
    this.replaceConnection(connection, newConnection);
  }

  private buildConnectionConfig(connection: Connection): ConnectionConfig {
    const normalizedPort = this.normalizePort(connection.port);
    const proxyConfig = this.getProxyConfig(connection.host, normalizedPort);
    if (proxyConfig) {
      return {
        ...proxyConfig,
        port: normalizedPort,
      };
    }
    return {
      host: connection.host,
      port: normalizedPort,
      password: connection.password,
      encryptionKey: (connection as any).encryptionKey,
      expectedServerName: (connection as any).expectedServerName,
      clientInfo: connection.clientInfo,
      reconnectInterval: connection.reconnectInterval,
      pingInterval: connection.pingInterval,
      pingAttempts: connection.pingAttempts,
    };
  }

  private replaceConnection(previous: Connection, next: Connection) {
    const key = this.getProxyKey(previous.host, previous.port);
    const index = this.connections.findIndex(
      (connection) => this.getProxyKey(connection.host, connection.port) === key
    );
    if (index >= 0) {
      this.connections[index] = next;
    } else {
      this.connections.push(next);
    }
    this.attachConnectionHandlers(next);

    for (const device of this.bleDevices) {
      if (device.usesConnection(previous)) device.updateConnection(next);
    }

    try {
      this.intentionalDisconnects.add(previous);
      previous.disconnect();
    } catch {}
  }

  private getProxyKey(host: string, port?: number): string {
    return `${host}:${this.normalizePort(port)}`;
  }

  private normalizePort(port?: number): number {
    return port ?? 6053;
  }

  private maybeAutoRebootProxy(connection: Connection, error: unknown) {
    if (!this.proxyRecovery.autoRebootOnTimeout) return;
    if (!this.isBleConnectTimeout(error)) return;
    const key = this.getProxyKey(connection.host, connection.port);
    const now = Date.now();
    const lastTimeout = this.proxyTimeouts.get(key);
    this.proxyTimeouts.set(key, now);

    const cooldownMs = this.proxyRecovery.rebootCooldownMinutes * 60_000;
    const windowMs = this.proxyRecovery.rebootWindowMinutes * 60_000;
    const lastReboot = this.proxyReboots.get(key) ?? 0;
    if (now - lastReboot < cooldownMs) return;
    if (!lastTimeout || now - lastTimeout > windowMs) return;

    this.proxyReboots.set(key, now);
    this.proxyTimeouts.delete(key);
    logWarn(`[ESPHome] Auto-rebooting proxy (${key}) after repeated BLE timeouts`);
    void this.rebootProxy(connection.host, connection.port);
  }

  private isBleConnectTimeout(error: unknown): boolean {
    if (!error) return false;
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes('bluetoothdeviceconnectionresponse') ||
      normalized.includes('sendmessage timeout') ||
      normalized.includes('timed out')
    );
  }
}
