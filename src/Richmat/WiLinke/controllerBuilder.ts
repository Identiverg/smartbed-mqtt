import { IDeviceData } from '@ha/IDeviceData';
import { logWarn } from '@utils/logger';
import { BLEController } from 'BLE/BLEController';
import { IBLEDevice } from 'ESPHome/types/IBLEDevice';
import { supportedBeds } from './supportedBeds';

const buildCommand = (command: number) => [110, 1, 0, command, command + 111];

export const controllerBuilder = async (deviceData: IDeviceData, bleDevice: IBLEDevice) => {
  const { name, getCharacteristic, getServices } = bleDevice;

  for (const { serviceUuid, writeCharacteristicUuid } of supportedBeds) {
    const characteristic = await getCharacteristic(serviceUuid, writeCharacteristicUuid, false);
    if (!characteristic) continue;
    return new BLEController(deviceData, bleDevice, characteristic.handle, buildCommand);
  }

  const services = await getServices();
  if (services.length) {
    const summary = services.map((service) => ({
      uuid: service.uuid,
      characteristics: (service.characteristicsList || []).map((characteristic) => characteristic.uuid),
    }));
    logWarn('[Richmat] Discovered GATT services/characteristics for device:', name, JSON.stringify(summary));
  } else {
    logWarn('[Richmat] No GATT services discovered for device:', name);
  }
  return undefined;
};
