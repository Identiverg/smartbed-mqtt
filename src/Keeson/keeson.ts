import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { buildDictionary } from '@utils/buildDictionary';
import { logError, logInfo, logWarn } from '@utils/logger';
import { setupDeviceInfoSensor } from 'BLE/setupDeviceInfoSensor';
import { buildMQTTDeviceData } from 'Common/buildMQTTDeviceData';
import { IESPConnection } from 'ESPHome/IESPConnection';
import { getDevices } from './options';
import { setupMassageButtons } from './setupMassageButtons';
import { setupPresetButtons } from './setupPresetButtons';
import { setupMotorEntities } from './setupMotorEntities';
import { controllerBuilder as ksbtControllerBuilder } from './KSBT/controllerBuilder';
import { controllerBuilder as baseI5ControllerBuilder } from './BaseI5/controllerBuilder';
import { controllerBuilder as baseI4ControllerBuilder } from './BaseI4/controllerBuilder';

export const keeson = async (mqtt: IMQTTConnection, esphome: IESPConnection): Promise<void> => {
  const devices = getDevices();
  if (!devices.length) return logInfo('[Keeson] No devices configured');

  const devicesMap = buildDictionary(devices, (device) => ({ key: device.name.toLowerCase(), value: device }));
  const deviceNames = Object.keys(devicesMap);

  if (deviceNames.length !== devices.length) return logError('[Keeson] Duplicate name detected in configuration');

  const bleDevices = await esphome.getBLEDevices(deviceNames);
  for (const bleDevice of bleDevices) {
    const { name, mac, address, connect, disconnect, getDeviceInfo } = bleDevice;
    const device = devicesMap[mac] || devicesMap[name.toLowerCase()];

    if (!device) {
      logInfo(`[Keeson] Device not found in configuration for MAC: ${mac} or Name: ${name}`);
      continue;
    }
    const { variant, motorPulseCount, motorPulseDelayMs, ...deviceConfig } = device;

    const deviceData = buildMQTTDeviceData({ ...deviceConfig, address }, 'Keeson');
    await connect();

    const tryBuild = async (label: string, builder: typeof ksbtControllerBuilder) => {
      const controller = await builder(deviceData, bleDevice);
      if (controller) logInfo('[Keeson] Using protocol for device:', name, label);
      return controller;
    };

    let controller;
    switch (variant) {
      case 'ksbt':
        controller = await tryBuild('ksbt', ksbtControllerBuilder);
        break;
      case 'base':
        controller =
          (await tryBuild('base-i5', baseI5ControllerBuilder)) ||
          (await tryBuild('base-i4', baseI4ControllerBuilder));
        break;
      case 'auto':
      case undefined:
      default: {
        controller =
          (await tryBuild('ksbt', ksbtControllerBuilder)) ||
          (await tryBuild('base-i5', baseI5ControllerBuilder)) ||
          (await tryBuild('base-i4', baseI4ControllerBuilder));
        break;
      }
    }

    if (!controller) {
      const {
        advertisement: { manufacturerDataList, serviceUuidsList },
      } = bleDevice;
      const services = await bleDevice.getServices();
      if (services.length) {
        const summary = services.map((service) => ({
          uuid: service.uuid,
          characteristics: (service.characteristicsList || []).map((characteristic) => ({
            uuid: characteristic.uuid,
            properties: characteristic.properties,
          })),
        }));
        logWarn('[Keeson] Discovered GATT services/characteristics for device:', name, JSON.stringify(summary));
      } else {
        logWarn('[Keeson] No GATT services discovered for device:', name);
      }
      logWarn(
        '[Keeson] Device not supported, please contact me on Discord',
        name,
        JSON.stringify({ name, address, manufacturerDataList, serviceUuidsList })
      );
      await disconnect();
      continue;
    }

    logInfo('[Keeson] Setting up entities for device:', name);
    setupPresetButtons(mqtt, controller);
    setupMassageButtons(mqtt, controller);
    setupMotorEntities(mqtt, controller, { motorPulseCount, motorPulseDelayMs });

    const deviceInfo = await getDeviceInfo();
    if (deviceInfo) setupDeviceInfoSensor(mqtt, controller, deviceInfo);
  }
};
