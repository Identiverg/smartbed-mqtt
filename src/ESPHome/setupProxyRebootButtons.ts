import { Button } from '@ha/Button';
import { IMQTTConnection } from '@mqtt/IMQTTConnection';
import { logInfo } from '@utils/logger';
import { buildMQTTDeviceData } from 'Common/buildMQTTDeviceData';
import { buildEntityConfig } from 'Common/buildEntityConfig';
import { IESPConnection } from './IESPConnection';
import { BLEProxy, getProxies } from './options';

const buildProxyAddress = (proxy: BLEProxy) => {
  const portSuffix = proxy.port ? `:${proxy.port}` : '';
  return `${proxy.host}${portSuffix}`;
};

const buildProxyName = (proxy: BLEProxy) => proxy.expectedServerName || proxy.host;

export const setupProxyRebootButtons = (mqtt: IMQTTConnection, esphome: IESPConnection) => {
  const proxies = getProxies();
  if (!proxies.length) return;

  for (const proxy of proxies) {
    const proxyName = buildProxyName(proxy);
    const proxyAddress = buildProxyAddress(proxy);
    const friendlyName = `BLE Proxy ${proxyName}`;
    const deviceData = buildMQTTDeviceData({ friendlyName, name: proxyName, address: proxyAddress }, 'ESPHome');
    logInfo('[ESPHome] Exposing reboot control for proxy:', proxyName);
    new Button(
      mqtt,
      deviceData,
      buildEntityConfig('ProxyReboot', { category: 'config', icon: 'mdi:restart' }),
      async () => esphome.rebootProxy(proxy.host, proxy.port)
    ).setOnline();
  }
};
