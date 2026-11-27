import test from 'node:test';
import assert from 'node:assert/strict';
import {addresses} from '../server.mjs';

const ipv4 = address => ({address, family: 'IPv4', internal: false});

test('shared Wi-Fi addresses are eligible only within 100.64.0.0/10', () => {
  const ips = ['100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0'];
  assert.deepEqual(addresses({wifi: ips.map(ipv4)}), ips.slice(1, 3));
});

test('existing private interfaces take precedence over shared VPN addresses', () => {
  assert.deepEqual(addresses({
    vpn: [ipv4('100.65.0.2')],
    wifi: [ipv4('192.168.1.2')],
    internal: [{...ipv4('100.65.0.3'), internal: true}],
  }), ['192.168.1.2', '100.65.0.2']);
});
