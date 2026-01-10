import { IDeviceData } from '@ha/IDeviceData';
import { byte } from '@utils/byte';
import { logWarn } from '@utils/logger';
import { intToBytes } from '@utils/intToBytes';
import { sum } from '@utils/sum';
import { BLEController } from 'BLE/BLEController';
import { IBLEDevice } from 'ESPHome/types/IBLEDevice';

const buildCommand = (command: number) => {
  const data = [0xe5, 0xfe, 0x16, ...intToBytes(command).reverse()];
  const checksum = data.reduce(sum) ^ 0xff;
  data.push(checksum);
  return data.map(byte);
};
const disconnectDelayMs = 5_000;

export const controllerBuilder = async (deviceData: IDeviceData, bleDevice: IBLEDevice) => {
  const { getCharacteristic } = bleDevice;
  const candidates = [
    {
      label: 'base-ffe5',
      serviceUuid: '0000ffe5-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '0000ffe9-0000-1000-8000-00805f9b34fb',
      notifyServiceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
      notifyCharacteristicUuid: '0000ffe4-0000-1000-8000-00805f9b34fb',
    },
    {
      label: 'alt-fff0',
      serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '0000fff2-0000-1000-8000-00805f9b34fb',
    },
    {
      label: 'alt-ffb0',
      serviceUuid: '0000ffb0-0000-1000-8000-00805f9b34fb',
      writeCharacteristicUuid: '0000ffb2-0000-1000-8000-00805f9b34fb',
    },
  ];

  for (const candidate of candidates) {
    const writeCharacteristic = await getCharacteristic(
      candidate.serviceUuid,
      candidate.writeCharacteristicUuid,
      false
    );
    if (!writeCharacteristic) continue;

    if (candidate.label !== 'base-ffe5') {
      logWarn('[Keeson] Using fallback GATT characteristic:', JSON.stringify(candidate));
    }

    const requireResponse = false;
    return new BLEController(
      deviceData,
      bleDevice,
      writeCharacteristic.handle,
      buildCommand,
      {},
      false,
      requireResponse,
      disconnectDelayMs
    );
  }

  return undefined;
};
