/**
 * The phone-on-the-same-Wi-Fi dev server (v0.6.0, written first): a local CA and a server certificate for the LAN
 * IP, so the phone gets a secure context (needed for the service worker and Web Push) once it trusts the dev CA.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { lanAddress, makeDevCerts } from '../../src/dev/certs';

describe('LAN dev server', () => {
  it('LAN-01 picks a private IPv4 address of this machine, never loopback or a virtual adapter if a real one exists', () => {
    const fake = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      'vEthernet (WSL)': [{ address: '172.28.48.1', family: 'IPv4', internal: false }],
      'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.42', family: 'IPv4', internal: false }]
    } as unknown as ReturnType<typeof os.networkInterfaces>;
    expect(lanAddress(fake)).toBe('192.168.1.42');
    expect(lanAddress({ lo: fake.lo } as never)).toBeNull();
  });

  it('LAN-02 makes a dev CA and a server certificate for the LAN IP and localhost, signed by that CA, and reuses them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-certs-'));
    const first = await makeDevCerts(dir, '192.168.1.42');
    for (const f of [first.caCert, first.cert, first.key]) expect(fs.existsSync(f)).toBe(true);
    const ca = new crypto.X509Certificate(fs.readFileSync(first.caCert));
    const leaf = new crypto.X509Certificate(fs.readFileSync(first.cert));
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIP('192.168.1.42')).toBe('192.168.1.42');
    expect(leaf.checkHost('localhost')).toBe('localhost');
    expect(new Date(leaf.validTo).getTime() - Date.now()).toBeLessThan(826 * 86_400_000);   // phones reject longer server certs
    crypto.createPrivateKey(fs.readFileSync(first.key));   // a usable key
    const again = await makeDevCerts(dir, '192.168.1.42');
    expect(fs.readFileSync(again.caCert, 'utf8')).toBe(fs.readFileSync(first.caCert, 'utf8'));   // same CA: the phone trusts it once
    const moved = await makeDevCerts(dir, '192.168.1.77');
    expect(new crypto.X509Certificate(fs.readFileSync(moved.cert)).checkIP('192.168.1.77')).toBe('192.168.1.77');
    expect(fs.readFileSync(moved.caCert, 'utf8')).toBe(fs.readFileSync(first.caCert, 'utf8'));
  });
});
