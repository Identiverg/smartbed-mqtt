import { logError, logInfo } from '@utils/logger';
import mqtt from 'mqtt';
import { IMQTTConnection } from './IMQTTConnection';
import MQTTConfig from './MQTTConfig';
import { MQTTConnection } from './MQTTConnection';

export const connectToMQTT = (): Promise<IMQTTConnection> => {
  logInfo('[MQTT] Connecting...');
  const client = mqtt.connect(MQTTConfig);

  return new Promise((resolve) => {
    client.once('connect', () => {
      logInfo('[MQTT] Connected');
      resolve(new MQTTConnection(client));
    });
    client.on('error', (error) => {
      logError('[MQTT] Connect Error', error);
    });
  });
};
