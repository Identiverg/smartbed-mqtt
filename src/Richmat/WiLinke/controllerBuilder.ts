import { IDeviceData } from '@ha/IDeviceData';
import { logWarn } from '@utils/logger';
import { BLEController } from 'BLE/BLEController';
import { IBLEDevice } from 'ESPHome/types/IBLEDevice';
import { supportedBeds } from './supportedBeds';

const buildCommand = (command: number) => [110, 1, 0, command, command + 111];
const canWriteWithoutResponse = (properties?: number) => !!(properties && (properties & 0x4));
const isWritable = (properties?: number) => !!(properties && (properties & 0x4 || properties & 0x8 || properties & 0x40));
const isVendorService = (uuid: string) => uuid.startsWith('0000ff');
const preferredServiceUuids = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ffe5-0000-1000-8000-00805f9b34fb',
];

export const controllerBuilder = async (deviceData: IDeviceData, bleDevice: IBLEDevice) => {
  const { name, getCharacteristic, getServices } = bleDevice;

  for (const { serviceUuid, writeCharacteristicUuid } of supportedBeds) {
    const characteristic = await getCharacteristic(serviceUuid, writeCharacteristicUuid, false);
    if (!characteristic || !isWritable(characteristic.properties)) continue;
    const requireResponse = !canWriteWithoutResponse(characteristic.properties);
    return new BLEController(deviceData, bleDevice, characteristic.handle, buildCommand, {}, false, requireResponse);
  }

  const services = await getServices();
  const vendorServices = services.filter((service) => isVendorService(service.uuid));
  const singleCharCandidates = vendorServices
    .filter((service) => (service.characteristicsList || []).length === 1)
    .map((service) => ({ service, characteristic: service.characteristicsList[0] }))
    .filter(({ characteristic }) => isWritable(characteristic.properties));
  if (singleCharCandidates.length === 1) {
    const { service, characteristic } = singleCharCandidates[0];
    const requireResponse = !canWriteWithoutResponse(characteristic.properties);
    logWarn(
      '[Richmat] Auto-selected writable GATT characteristic for device:',
      name,
      JSON.stringify({ serviceUuid: service.uuid, characteristicUuid: characteristic.uuid, properties: characteristic.properties })
    );
    return new BLEController(deviceData, bleDevice, characteristic.handle, buildCommand, {}, false, requireResponse);
  }

  const writableCandidates = vendorServices
    .flatMap((service) =>
      (service.characteristicsList || [])
        .filter((characteristic) => isWritable(characteristic.properties))
        .map((characteristic) => ({ service, characteristic }))
    )
    .sort((a, b) => a.service.uuid.localeCompare(b.service.uuid));
  for (const preferredUuid of preferredServiceUuids) {
    const preferred = writableCandidates.find((candidate) => candidate.service.uuid === preferredUuid);
    if (preferred) {
      const requireResponse = !canWriteWithoutResponse(preferred.characteristic.properties);
      logWarn(
        '[Richmat] Auto-selected preferred GATT characteristic for device:',
        name,
        JSON.stringify({
          serviceUuid: preferred.service.uuid,
          characteristicUuid: preferred.characteristic.uuid,
          properties: preferred.characteristic.properties,
        })
      );
      return new BLEController(
        deviceData,
        bleDevice,
        preferred.characteristic.handle,
        buildCommand,
        {},
        false,
        requireResponse
      );
    }
  }

  if (writableCandidates.length === 1) {
    const { service, characteristic } = writableCandidates[0];
    const requireResponse = !canWriteWithoutResponse(characteristic.properties);
    logWarn(
      '[Richmat] Auto-selected only writable GATT characteristic for device:',
      name,
      JSON.stringify({ serviceUuid: service.uuid, characteristicUuid: characteristic.uuid, properties: characteristic.properties })
    );
    return new BLEController(deviceData, bleDevice, characteristic.handle, buildCommand, {}, false, requireResponse);
  }

  if (services.length) {
    const summary = services.map((service) => ({
      uuid: service.uuid,
      characteristics: (service.characteristicsList || []).map((characteristic) => ({
        uuid: characteristic.uuid,
        properties: characteristic.properties,
      })),
    }));
    logWarn('[Richmat] Discovered GATT services/characteristics for device:', name, JSON.stringify(summary));
  } else {
    logWarn('[Richmat] No GATT services discovered for device:', name);
  }
  return undefined;
};
