import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { buildDictionary } from '@utils/buildDictionary';
import { logError, logInfo, logWarn } from '@utils/logger';
import { setupDeviceInfoSensor } from 'BLE/setupDeviceInfoSensor';
import { buildMQTTDeviceData } from 'Common/buildMQTTDeviceData';
import { IESPConnection } from 'ESPHome/IESPConnection';
import { Features } from './Features';
import { controllerBuilder as nordicControllerBuilder } from './Nordic/controllerBuilder';
import { isSupported as isNordicSupported } from './Nordic/isSupported';
import { controllerBuilder as wiLinkeControllerBuilder } from './WiLinke/controllerBuilder';
import { isSupported as isWiLinkeSupported } from './WiLinke/isSupported';
import { RichmatDevice, getDevices } from './options';
import { remoteFeatures } from './remoteFeatures';
import { setupMassageButtons } from './setupMassageButtons';
import { setupPresetButtons } from './setupPresetButtons';
import { setupUnderBedLightButton } from './setupUnderBedLightButton';
import { setupMotorEntities } from './setupMotorEntities';

const checks = [isNordicSupported, isWiLinkeSupported];
const controllerBuilders = [nordicControllerBuilder, wiLinkeControllerBuilder];
const buildCommandBuilder = (commandProtocol?: RichmatDevice['commandProtocol']) => {
  switch (commandProtocol) {
    case 'single':
    case 'nordic':
      return (command: number) => [command & 0xff];
    case 'prefix55': {
      const prefix = [0x55, 0x01, 0x00];
      return (command: number) => {
        const checksum = (command + prefix[0] + prefix[1]) & 0xff;
        return [...prefix, command & 0xff, checksum];
      };
    }
    case 'prefixaa': {
      const prefix = [0xaa, 0x01, 0x00];
      return (command: number) => {
        const checksum = (command + prefix[0] + prefix[1]) & 0xff;
        return [...prefix, command & 0xff, checksum];
      };
    }
    case 'wilinke':
    default:
      return (command: number) => [110, 1, 0, command & 0xff, (command + 111) & 0xff];
  }
};

export const richmat = async (mqtt: IMQTTConnection, esphome: IESPConnection) => {
  const devices = getDevices();
  if (!devices.length) return logInfo('[Richmat] No devices configured');

  const devicesMap = buildDictionary(devices, (device) => ({ key: device.name.toLowerCase(), value: device }));
  const deviceNames = Object.keys(devicesMap);
  if (deviceNames.length !== devices.length) return logError('[Richmat] Duplicate name detected in configuration');
  const bleDevices = await esphome.getBLEDevices(deviceNames);
  for (const bleDevice of bleDevices) {
    const { name, mac, address, connect, disconnect } = bleDevice;

    const controllerBuilder = checks
      .map((check, index) => (check(bleDevice) ? controllerBuilders[index] : undefined))
      .filter((check) => check)[0];
    if (controllerBuilder === undefined) {
      const {
        advertisement: { manufacturerDataList, serviceUuidsList },
      } = bleDevice;
      logWarn(
        '[Richmat] Device not supported, please contact me on Discord',
        name,
        JSON.stringify({ name, address, manufacturerDataList, serviceUuidsList })
      );
      continue;
    }

    const { remoteCode, motorPulseCount, motorPulseDelayMs, ...device } =
      devicesMap[mac] || devicesMap[name.toLowerCase()];

    const features = remoteFeatures[remoteCode];
    if (!features) {
      logWarn('[Richmat] Remote code not supported, please contact me on Discord', remoteCode);
      continue;
    }

    const commandProtocol = device.commandProtocol ?? 'wilinke';
    const commandBuilder = buildCommandBuilder(commandProtocol);
    logInfo('[Richmat] Using command protocol for device:', name, commandProtocol);

    const deviceData = buildMQTTDeviceData({ ...device, address }, 'Richmat');
    await connect();

    const controller = await controllerBuilder(deviceData, bleDevice, commandBuilder);
    if (!controller) {
      await disconnect();
      continue;
    }

    if (!device.stayConnected) await disconnect();

    const hasFeature = (feature: Features) => (features & feature) === feature;
    logInfo('[Richmat] Setting up entities for device:', name);
    setupPresetButtons(mqtt, controller, hasFeature);
    setupMassageButtons(mqtt, controller, hasFeature);
    setupUnderBedLightButton(mqtt, controller, hasFeature);
    setupMotorEntities(mqtt, controller, hasFeature, { motorPulseCount, motorPulseDelayMs });

    const deviceInfo = await bleDevice.getDeviceInfo();
    if (deviceInfo) setupDeviceInfoSensor(mqtt, controller, deviceInfo);
  }
};
