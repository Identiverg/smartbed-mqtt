import { IDeviceData } from '@ha/IDeviceData';
import { BLEController } from 'BLE/BLEController';
import { IBLEDevice } from 'ESPHome/types/IBLEDevice';

const canWriteWithoutResponse = (properties?: number) => !!(properties && (properties & 0x4));

export const controllerBuilder = async (
  deviceData: IDeviceData,
  bleDevice: IBLEDevice,
  commandBuilder?: (command: number) => number[]
) => {
  const { getCharacteristic } = bleDevice;

  const characteristic = await getCharacteristic(
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
  );
  if (!characteristic) return undefined;

  const requireResponse = !canWriteWithoutResponse(characteristic.properties);
  const buildCommand = commandBuilder ?? ((byte: number) => [byte]);
  return new BLEController(deviceData, bleDevice, characteristic.handle, buildCommand, {}, false, requireResponse);
};
