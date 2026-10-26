import { api } from './api.js';

/**
 * Phone alerts (Web Push) on this device. Subscribing needs a secure context, a service worker and, on iPhone,
 * the app added to the Home Screen first. A notification only ever opens the Review screen.
 */
export function pushSupport() {
  if (!window.isSecureContext) return { ok: false, why: 'Alerts need a secure (https) connection.' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return { ok: false, why: ios ? 'On iPhone, first tap Share → Add to Home Screen, then open AgentGuard from the Home Screen.' : 'This browser does not support web push alerts.' };
  }
  if (Notification.permission === 'denied') return { ok: false, why: 'Notifications are blocked for this site. Allow them in the browser’s site settings.' };
  return { ok: true };
}

const keyBytes = b64 => {
  const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

export async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush(publicKey) {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSubscribe(sub.toJSON());
  return sub;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}
