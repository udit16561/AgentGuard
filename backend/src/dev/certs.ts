import 'reflect-metadata';   // required by @peculiar/x509
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as x509 from '@peculiar/x509';

/**
 * Development only: certificates for opening AgentGuard on a phone over the same Wi-Fi. Service workers and Web
 * Push need a secure context, so the LAN dev server speaks HTTPS with a server certificate for the LAN IP, signed
 * by a local "AgentGuard Dev CA" that the phone trusts once. The CA is made once and reused; the server
 * certificate is remade when the IP changes. Files live in a git-ignored folder.
 */
x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);
const subtle = crypto.webcrypto.subtle;
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const SERVER_DAYS = 397;   // phones reject server certificates valid for longer
const CA_DAYS = 3650;

const VIRTUAL = /vethernet|wsl|virtualbox|vmware|hyper-v|docker|vbox|loopback|br-|veth|tailscale|zerotier/i;
const privateV4 = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** This machine's address on the local network: a private IPv4 on a real adapter, preferring 192.168.x.x. */
export function lanAddress(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string | null {
  const all = Object.entries(ifaces).flatMap(([name, list]) => (list ?? [])
    .filter(a => a.family === 'IPv4' && !a.internal && privateV4(a.address))
    .map(a => ({ name, address: a.address })));
  const real = all.filter(a => !VIRTUAL.test(a.name));
  const pick = (xs: typeof all) => xs.find(a => a.address.startsWith('192.168.')) ?? xs[0];
  return (pick(real) ?? pick(all))?.address ?? null;
}

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

async function keyPem(key: CryptoKey) { return pem('PRIVATE KEY', await subtle.exportKey('pkcs8', key)); }
async function importKey(file: string) {
  const der = crypto.createPrivateKey(fs.readFileSync(file)).export({ type: 'pkcs8', format: 'der' });
  return subtle.importKey('pkcs8', der, ALG, true, ['sign']);
}

export interface DevCerts { caCert: string; caKey: string; cert: string; key: string }

export async function makeDevCerts(dir: string, ip: string): Promise<DevCerts> {
  fs.mkdirSync(dir, { recursive: true });
  const files: DevCerts = {
    caCert: path.join(dir, 'agentguard-dev-ca.crt'), caKey: path.join(dir, 'agentguard-dev-ca.key'),
    cert: path.join(dir, 'server.crt'), key: path.join(dir, 'server.key')
  };

  if (!fs.existsSync(files.caCert) || !fs.existsSync(files.caKey)) {
    const keys = await subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
    const ca = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: crypto.randomBytes(8).toString('hex'), name: `CN=AgentGuard Dev CA (${os.hostname()})`,
      notBefore: days(-1), notAfter: days(CA_DAYS), keys, signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
      ]
    });
    fs.writeFileSync(files.caKey, await keyPem(keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(files.caCert, ca.toString('pem') + '\n');
    fs.rmSync(files.cert, { force: true });
  }

  const current = fs.existsSync(files.cert) && fs.existsSync(files.key) ? new crypto.X509Certificate(fs.readFileSync(files.cert)) : null;
  const caPem = fs.readFileSync(files.caCert);
  const fresh = current && current.checkIP(ip) === ip && current.checkIssued(new crypto.X509Certificate(caPem))
    && new Date(current.validTo).getTime() - Date.now() > 30 * 86_400_000;
  if (!fresh) {
    const ca = new x509.X509Certificate(caPem);
    const caKey = await importKey(files.caKey);
    const keys = await subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: crypto.randomBytes(8).toString('hex'), subject: 'CN=AgentGuard dev server', issuer: ca.subject,
      notBefore: days(-1), notAfter: days(SERVER_DAYS), publicKey: keys.publicKey, signingKey: caKey as unknown as CryptoKey, signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: ip }, { type: 'ip', value: '127.0.0.1' }, { type: 'dns', value: 'localhost' }]),
        await x509.AuthorityKeyIdentifierExtension.create(await ca.publicKey.export()),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
      ]
    });
    fs.writeFileSync(files.key, await keyPem(keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(files.cert, cert.toString('pem') + '\n');
  }
  return files;
}
