/**
 * npm run dev:lan: open AgentGuard on a phone on the same Wi-Fi (development only).
 *   https://<LAN IP>:4443  the app, over HTTPS (service worker and Web Push need a secure context)
 *   http://<LAN IP>:4080   a setup page that only serves the dev CA certificate to install on the phone once
 * Missing VAPID keys and TOKEN_ENCRYPTION_KEY are generated into backend/.env (git-ignored) on first run.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import dotenv from 'dotenv';
import webpush from 'web-push';
import { lanAddress, makeDevCerts } from './certs';
import { createApp } from '../app';
import { dbPathFromUrl } from '../server-config';

const ROOT = path.resolve(__dirname, '../..');
const ENV_FILE = path.join(ROOT, '.env');
const HTTPS_PORT = Number(process.env.LAN_HTTPS_PORT ?? 4443);
const SETUP_PORT = Number(process.env.LAN_SETUP_PORT ?? 4080);

function ensureEnv() {
  dotenv.config({ path: ENV_FILE, quiet: true });
  const add: string[] = [];
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    const keys = webpush.generateVAPIDKeys();
    add.push(`VAPID_PUBLIC_KEY=${keys.publicKey}`, `VAPID_PRIVATE_KEY=${keys.privateKey}`, 'VAPID_SUBJECT=mailto:owner@agentguard.dev');
  }
  const tek = process.env.TOKEN_ENCRYPTION_KEY;
  if (!tek || Buffer.from(tek, 'base64').length !== 32) add.push(`TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
  if (!process.env.DATABASE_URL) add.push('DATABASE_URL=file:./dev.db');
  if (add.length) {
    const before = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    // drop placeholder lines that are being replaced, keep everything else
    const names = new Set(add.map(l => l.split('=')[0]));
    const kept = before.split(/\r?\n/).filter(l => l && !names.has(l.split('=')[0]));
    fs.writeFileSync(ENV_FILE, [...kept, '# added by npm run dev:lan', ...add, ''].join('\n'), { mode: 0o600 });
    for (const l of add) { const [k, ...v] = l.split('='); process.env[k] = v.join('='); }
    console.log(`Added ${[...names].join(', ')} to backend/.env (git-ignored).`);
  }
}

const setupPage = (url: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentGuard on your phone</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px}a.b{display:inline-block;background:#4F46E5;color:#fff;padding:12px 16px;border-radius:10px;text-decoration:none;font-weight:700}code{background:#eef;padding:2px 4px;border-radius:4px}</style>
<h1>AgentGuard on your phone</h1>
<p>Step 1: install the development certificate once, so the phone trusts this computer.</p>
<p><a class="b" href="/agentguard-dev-ca.crt">Download the certificate</a></p>
<p><b>Android:</b> Settings → Security → More security settings → Encryption &amp; credentials → Install a certificate → <i>CA certificate</i> → pick the downloaded file.<br>
<b>iPhone:</b> open the download, then Settings → Profile Downloaded → Install; then Settings → General → About → Certificate Trust Settings → turn on “AgentGuard Dev CA”.</p>
<p>Step 2: open <a href="${url}">${url}</a> and sign in. Then Settings → Phone alerts → Turn on alerts.<br>
On iPhone, first tap Share → <i>Add to Home Screen</i> and open AgentGuard from there (iOS allows alerts only for installed apps).</p>
<p>This page only serves the certificate. Remove the certificate from the phone when you are done testing.</p>`;

async function main() {
  ensureEnv();
  const ip = process.env.LAN_IP || lanAddress();
  if (!ip) { console.error('No Wi-Fi/LAN IPv4 address found. Connect to a network, or set LAN_IP.'); process.exit(1); }
  const certs = await makeDevCerts(path.join(ROOT, '.certs'), ip);
  // createApp reads the config now, after ensureEnv() filled in what was missing
  const { app } = await createApp({ dbPath: dbPathFromUrl(process.env.DATABASE_URL) });
  const url = `https://${ip}:${HTTPS_PORT}`;

  https.createServer({ key: fs.readFileSync(certs.key), cert: fs.readFileSync(certs.cert) }, app).listen(HTTPS_PORT, '0.0.0.0');
  http.createServer((req, res) => {
    if (req.url === '/agentguard-dev-ca.crt') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="agentguard-dev-ca.crt"' });
      res.end(fs.readFileSync(certs.caCert));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(setupPage(url));
  }).listen(SETUP_PORT, '0.0.0.0');

  console.log(`\nAgentGuard on your Wi-Fi (development, MOCK tools):
  1. On the phone, open  http://${ip}:${SETUP_PORT}  and install the dev certificate (once).
  2. Then open           ${url}
  On this PC:            https://localhost:${HTTPS_PORT}
If the phone cannot connect, allow Node.js through Windows Firewall for private networks.
Demo agent:            AGENTGUARD_URL=https://localhost:${HTTPS_PORT} NODE_EXTRA_CA_CERTS=.certs/agentguard-dev-ca.crt npm run demo:agent -- pay 500 Ravi\n`);
}

void main();
