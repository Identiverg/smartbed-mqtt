import { BluetoothGATTService, Connection } from '@2colors/esphome-native-api';
import { Dictionary } from '@utils/Dictionary';
import { logInfo, logWarn } from '@utils/logger';
import { wait } from '@utils/wait';
import { BLEAdvertisement } from './BLEAdvertisement';
import { BLEDeviceInfo } from './BLEDeviceInfo';
import { IBLEDevice } from './IBLEDevice';

const BT_BASE_UUID_SUFFIX = '0000-1000-8000-00805f9b34fb';
const CONNECT_TIMEOUT_MS = 15_000;
const DISCONNECT_TIMEOUT_MS = 10_000;
const PAIR_TIMEOUT_MS = 15_000;
const ADVERTISEMENT_REFRESH_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 8_000;
const NOTIFY_TIMEOUT_MS = 8_000;
const PROXY_AUTH_TIMEOUT_MS = 10_000;

const normalizeUuid = (uuid: string) => {
  if (!uuid) return '';
  let normalized = uuid.toLowerCase();
  if (normalized.startsWith('0x')) normalized = normalized.slice(2);
  if (!normalized.includes('-') && normalized.length <= 8) {
    return `${normalized.padStart(8, '0')}-${BT_BASE_UUID_SUFFIX}`;
  }
  return normalized;
};

type ConnectionWithRegistry = Connection & {
  __bleDeviceRegistry?: Map<number, (connected: boolean) => void>;
  __bleDeviceRegistryListener?: (message: { address: number; connected: boolean; error?: number }) => void;
  __bleRegistryDisconnectedListener?: () => void;
  __bleActiveAddress?: number;
  __bleConnectLock?: Promise<void>;
};

const getConnectionRegistry = (connection: Connection) => {
  const connectionWithRegistry = connection as ConnectionWithRegistry;
  if (!connectionWithRegistry.__bleDeviceRegistry) {
    connectionWithRegistry.__bleDeviceRegistry = new Map();
  }
  if (!connectionWithRegistry.__bleDeviceRegistryListener) {
    connectionWithRegistry.__bleDeviceRegistryListener = ({ address, connected }) => {
      if (connected) {
        connectionWithRegistry.__bleActiveAddress = address;
      } else if (connectionWithRegistry.__bleActiveAddress === address) {
        connectionWithRegistry.__bleActiveAddress = undefined;
      }
      const handler = connectionWithRegistry.__bleDeviceRegistry?.get(address);
      if (handler) handler(connected);
    };
    connection.on('message.BluetoothDeviceConnectionResponse', connectionWithRegistry.__bleDeviceRegistryListener);
  }
  if (!connectionWithRegistry.__bleRegistryDisconnectedListener) {
    connectionWithRegistry.__bleRegistryDisconnectedListener = () => {
      connectionWithRegistry.__bleActiveAddress = undefined;
    };
    connection.on('disconnected', connectionWithRegistry.__bleRegistryDisconnectedListener);
  }
  return connectionWithRegistry.__bleDeviceRegistry;
};

export class BLEDevice implements IBLEDevice {
  private connected = false;
  private paired = false;
  private connecting?: Promise<void>;
  private disconnecting?: Promise<void>;
  private advertisementRefresh?: Promise<boolean>;
  private connectionResponseHandler = (connected: boolean) => this.handleConnectionResponse(connected);

  private servicesList?: BluetoothGATTService[];
  private serviceCache: Dictionary<BluetoothGATTService | null> = {};

  private deviceInfo?: BLEDeviceInfo;

  public mac: string;
  public get address() {
    return this.advertisement.address;
  }
  public get manufacturerDataList() {
    return this.advertisement.manufacturerDataList;
  }
  public get serviceUuidsList() {
    return this.advertisement.serviceUuidsList;
  }

  constructor(public name: string, public advertisement: BLEAdvertisement, private connection: Connection) {
    this.mac = this.address.toString(16).padStart(12, '0');
    const registry = getConnectionRegistry(this.connection);
    registry.set(this.address, this.connectionResponseHandler);
  }

  usesConnection = (connection: Connection) => this.connection === connection;

  updateConnection = (connection: Connection) => {
    if (this.connection === connection) return;
    try {
      const registry = getConnectionRegistry(this.connection);
      registry.delete(this.address);
    } catch {}
    this.connection = connection;
    const registry = getConnectionRegistry(this.connection);
    registry.set(this.address, this.connectionResponseHandler);
    this.connected = false;
    this.connecting = undefined;
    this.disconnecting = undefined;
    this.servicesList = undefined;
    this.serviceCache = {};
  };

  pair = async () => {
    try {
      const { paired, error } = await this.withTimeout(
        'pair',
        this.connection.pairBluetoothDeviceService(this.address),
        PAIR_TIMEOUT_MS
      );
      this.paired = paired;
      if (!paired && error) {
        throw new Error(`Pair failed with error ${error}`);
      }
    } catch (error) {
      logWarn(`[BLE] Failed to pair device: ${this.name}`, error);
      throw error;
    }
  };

  connect = async () => {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.withConnectionLock(async () => {
      const connectOnce = async () => {
        const { addressType } = this.advertisement;
        await this.ensureProxyConnected();
        await this.disconnectActiveConnection();
        let response = await this.withTimeout(
          'connect',
          this.connection.connectBluetoothDeviceService(this.address, addressType),
          CONNECT_TIMEOUT_MS
        );
        if ((!response.connected || response.error) && response.error === 0 && !response.connected) {
          await wait(300);
          response = await this.withTimeout(
            'connect retry',
            this.connection.connectBluetoothDeviceService(this.address, addressType),
            CONNECT_TIMEOUT_MS
          );
        }
        if (!response.connected || response.error) {
          throw new Error(`Connect failed with error ${response.error ?? 'unknown'}`);
        }
        this.connected = true;
        if (this.paired) await this.pair();
      };

      try {
        await connectOnce();
      } catch (error) {
        this.connected = false;
        this.servicesList = undefined;
        this.serviceCache = {};
        const refreshed = await this.tryRefreshAdvertisement(error);
        if (refreshed) {
          try {
            await connectOnce();
            return;
          } catch (retryError) {
            error = retryError;
          }
        }
        this.maybeFlagConnectionError(error);
        logWarn(`[BLE] Failed to connect to device: ${this.name}`, error);
        try {
          await this.disconnect();
        } catch {}
        throw error;
      }
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  };

  disconnect = async () => {
    const wasConnected = this.connected;
    this.connected = false;
    this.servicesList = undefined;
    this.serviceCache = {};
    if (this.disconnecting) return this.disconnecting;
    if (!wasConnected) return;
    this.disconnecting = this.withConnectionLock(async () => {
      try {
        if (!this.connection.connected || !this.connection.authorized) return;
        const activeAddress = this.getActiveAddress();
        if (activeAddress !== undefined && activeAddress !== this.address) return;
        await this.withTimeout(
          'disconnect',
          this.connection.disconnectBluetoothDeviceService(this.address),
          DISCONNECT_TIMEOUT_MS
        );
      } catch (error) {
        logWarn(`[BLE] Failed to disconnect device: ${this.name}`, error);
      } finally {
        this.disconnecting = undefined;
      }
    });
    return this.disconnecting;
  };

  writeCharacteristic = async (handle: number, bytes: Uint8Array, response = true) => {
    if (!this.connected) throw new Error('Write requested while disconnected');
    await this.withTimeout(
      'write characteristic',
      this.connection.writeBluetoothGATTCharacteristicService(this.address, handle, bytes, response),
      WRITE_TIMEOUT_MS
    );
  };

  getServices = async () => {
    if (!this.servicesList) {
      const maxAttempts = 3;
      const timeoutSeconds = 20;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (!this.connected) await this.connect();
          await wait(1000);
          const { servicesList } = await this.connection.listBluetoothGATTServicesService(
            this.address,
            timeoutSeconds
          );
          this.servicesList = servicesList;
          break;
        } catch (error) {
          logWarn(`[BLE] Failed to fetch GATT services (attempt ${attempt}/${maxAttempts}) for:`, this.name, error);
          try {
            await this.disconnect();
          } catch {}
          if (attempt < maxAttempts) await wait(1000);
        }
      }
      this.servicesList = this.servicesList ?? [];
    }
    return this.servicesList;
  };

  getCharacteristic = async (serviceUuid: string, characteristicUuid: string, writeLogs = true) => {
    const normalizedServiceUuid = normalizeUuid(serviceUuid);
    const normalizedCharacteristicUuid = normalizeUuid(characteristicUuid);
    const service = await this.getService(normalizedServiceUuid);

    if (!service) {
      writeLogs && logInfo('[BLE] Could not find expected service for device:', normalizedServiceUuid, this.name);
      return undefined;
    }

    const characteristic = service?.characteristicsList?.find(
      (c) => normalizeUuid(c.uuid) === normalizedCharacteristicUuid
    );
    if (!characteristic) {
      writeLogs &&
        logInfo('[BLE] Could not find expected characteristic for device:', normalizedCharacteristicUuid, this.name);
      return undefined;
    }

    return characteristic;
  };

  subscribeToCharacteristic = async (handle: number, notify: (data: Uint8Array) => void) => {
    this.connection.on('message.BluetoothGATTNotifyDataResponse', (message) => {
      if (message.address != this.address || message.handle != handle) return;
      notify(new Uint8Array([...Buffer.from(message.data, 'base64')]));
    });
    try {
      if (!this.connected) await this.connect();
      await this.withTimeout(
        'notify characteristic',
        this.connection.notifyBluetoothGATTCharacteristicService(this.address, handle),
        NOTIFY_TIMEOUT_MS
      );
    } catch (error) {
      logWarn(`[BLE] Failed to subscribe to characteristic for device: ${this.name}`, error);
    }
  };

  readCharacteristic = async (handle: number) => {
    if (!this.connected) throw new Error('Read requested while disconnected');
    const response = await this.withTimeout(
      'read characteristic',
      this.connection.readBluetoothGATTCharacteristicService(this.address, handle),
      READ_TIMEOUT_MS
    );
    return new Uint8Array([...Buffer.from(response.data, 'base64')]);
  };

  getDeviceInfo = async () => {
    if (this.deviceInfo) return this.deviceInfo;
    const services = await this.getServices();
    const deviceInfoServiceUuid = normalizeUuid('0000180a-0000-1000-8000-00805f9b34fb');
    const service = services.find((s) => normalizeUuid(s.uuid) === deviceInfoServiceUuid);
    if (!service) return undefined;

    const deviceInfo: BLEDeviceInfo = (this.deviceInfo = {});
    const setters: Dictionary<(value: string) => void> = {
      [normalizeUuid('00002a24-0000-1000-8000-00805f9b34fb')]: (value: string) => (deviceInfo.modelNumber = value),
      [normalizeUuid('00002a25-0000-1000-8000-00805f9b34fb')]: (value: string) => (deviceInfo.serialNumber = value),
      [normalizeUuid('00002a26-0000-1000-8000-00805f9b34fb')]: (value: string) => (deviceInfo.firmwareRevision = value),
      [normalizeUuid('00002a27-0000-1000-8000-00805f9b34fb')]: (value: string) => (deviceInfo.hardwareRevision = value),
      [normalizeUuid('00002a28-0000-1000-8000-00805f9b34fb')]: (value: string) => (deviceInfo.softwareRevision = value),
      [normalizeUuid('00002a29-0000-1000-8000-00805f9b34fb')]: (value: string) => (deviceInfo.manufacturerName = value),
    };
    for (const { uuid, handle } of service.characteristicsList) {
      const setter = setters[normalizeUuid(uuid)];
      if (!setter) continue;
      try {
        const value = await this.readCharacteristic(handle);
        setter(Buffer.from(value).toString());
      } catch {}
    }

    return this.deviceInfo;
  };

  private getService = async (serviceUuid: string) => {
    const normalizedServiceUuid = normalizeUuid(serviceUuid);
    const cachedService = this.serviceCache[normalizedServiceUuid];
    if (cachedService !== undefined) return cachedService;

    const services = await this.getServices();
    const service = services.find((s) => normalizeUuid(s.uuid) === normalizedServiceUuid) || null;
    this.serviceCache[normalizedServiceUuid] = service;
    return service;
  };

  private handleConnectionResponse = (connected: boolean) => {
    this.connected = connected;
    if (!connected) {
      this.servicesList = undefined;
      this.serviceCache = {};
    }
  };

  private async withTimeout<T>(operation: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`[BLE] ${operation} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private getConnectionWithRegistry(): ConnectionWithRegistry {
    return this.connection as ConnectionWithRegistry;
  }

  private getActiveAddress(): number | undefined {
    return this.getConnectionWithRegistry().__bleActiveAddress;
  }

  private async disconnectActiveConnection(): Promise<void> {
    const connectionWithRegistry = this.getConnectionWithRegistry();
    const activeAddress = connectionWithRegistry.__bleActiveAddress;
    if (activeAddress === undefined || activeAddress === this.address) return;

    try {
      await this.withTimeout(
        'disconnect active device',
        this.connection.disconnectBluetoothDeviceService(activeAddress),
        DISCONNECT_TIMEOUT_MS
      );
    } catch (error) {
      logWarn('[BLE] Failed to disconnect active device before connect', error);
    } finally {
      if (connectionWithRegistry.__bleActiveAddress === activeAddress) {
        connectionWithRegistry.__bleActiveAddress = undefined;
      }
    }
    await wait(200);
  }

  private async withConnectionLock<T>(operation: () => Promise<T>): Promise<T> {
    const connectionWithRegistry = this.getConnectionWithRegistry();
    const previous = connectionWithRegistry.__bleConnectLock || Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    connectionWithRegistry.__bleConnectLock = previous.catch(() => {}).then(() => current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureProxyConnected(timeoutMs: number = PROXY_AUTH_TIMEOUT_MS): Promise<void> {
    if (this.connection.connected && this.connection.authorized) return;

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
        this.connection.off('authorized', onAuthorized);
        this.connection.off('error', onError);
        if (timeout) clearTimeout(timeout);
      };

      this.connection.once('authorized', onAuthorized);
      this.connection.once('error', onError);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`[BLE] Proxy connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (!this.connection.connected) {
        try {
          this.connection.connect();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    });
  }

  private async tryRefreshAdvertisement(error: unknown): Promise<boolean> {
    if (!this.shouldRefreshAdvertisement(error)) return false;
    const deviceLabel = this.name || this.advertisement?.name || this.mac;
    logInfo(`[BLE] Refreshing advertisement for device: ${deviceLabel}`);
    try {
      const refreshed = await this.refreshAdvertisement();
      if (!refreshed) {
        logWarn(`[BLE] Advertisement refresh timed out for device: ${deviceLabel}`);
      }
      return refreshed;
    } catch (refreshError) {
      logWarn(`[BLE] Advertisement refresh failed for device: ${deviceLabel}`, refreshError);
      return false;
    }
  }

  private shouldRefreshAdvertisement(error: unknown): boolean {
    if (!error) return false;
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (normalized.includes('not authorized') || normalized.includes('not connected')) return false;
    return normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('bluetoothdeviceconnectionresponse');
  }

  private async refreshAdvertisement(
    timeoutMs: number = ADVERTISEMENT_REFRESH_TIMEOUT_MS
  ): Promise<boolean> {
    const targetName = (this.advertisement?.name || '').toLowerCase();
    if (!targetName) return false;
    if (this.advertisementRefresh) return this.advertisementRefresh;

    try {
      await this.ensureProxyConnected();
    } catch {
      return false;
    }

    this.advertisementRefresh = new Promise<boolean>((resolve) => {
      let timeout: NodeJS.Timeout | undefined;
      const onAdvertisement = (advertisement: BLEAdvertisement) => {
        if (!advertisement?.name) return;
        if (advertisement.name.toLowerCase() !== targetName) return;
        cleanup();
        this.updateAdvertisement(advertisement);
        resolve(true);
      };
      const cleanup = () => {
        this.connection.off('message.BluetoothLEAdvertisementResponse', onAdvertisement);
        if (timeout) clearTimeout(timeout);
      };

      this.connection.on('message.BluetoothLEAdvertisementResponse', onAdvertisement);
      try {
        this.connection.subscribeBluetoothAdvertisementService();
      } catch {}
      timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    });

    try {
      return await this.advertisementRefresh;
    } finally {
      this.advertisementRefresh = undefined;
    }
  }

  private updateAdvertisement(advertisement: BLEAdvertisement) {
    const registry = getConnectionRegistry(this.connection);
    const previousAddress = this.address;
    this.advertisement = advertisement;
    this.mac = advertisement.address.toString(16).padStart(12, '0');
    if (previousAddress !== advertisement.address) {
      registry.delete(previousAddress);
      registry.set(advertisement.address, this.connectionResponseHandler);
    }
  }

  private maybeFlagConnectionError(error: unknown) {
    if (!error) return;
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    const triggers = [
      'bluetoothdeviceconnectionresponse',
      'helloresponse',
      'write after end',
      'not connected',
      'not authorized',
      'econnreset',
    ];
    if (!triggers.some((trigger) => normalized.includes(trigger))) return;
    if (this.connection.listenerCount('error') === 0) return;
    try {
      this.connection.emit('error', error);
    } catch {}
  }
}
