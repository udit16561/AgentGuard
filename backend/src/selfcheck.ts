import type { Config } from './config';
import { liveUnavailable } from './integrations/google/oauth';

/**
 * Startup self-check (v0.9.0): which features are on, and that none of the optional ones is needed. Every key is
 * optional: with none set the app runs fully in MOCK mode. Secrets are reported as set or not set, never printed.
 */
export interface Feature { id: string; name: string; on: boolean; optional: boolean; detail: string }

export function selfCheck(config: Config) {
  const live = liveUnavailable({ config });
  const features: Feature[] = [
    { id: 'integrations', name: 'Tools', on: true, optional: false,
      detail: config.integrationMode === 'live' ? 'MOCK for all 9 tools, except Calendar once you switch it to LIVE' : 'MOCK: all 9 tools simulated, nothing real is sent' },
    { id: 'gates', name: 'Approvals and audit', on: true, optional: false, detail: 'three gates, hash-bound approvals, append-only audit log' },
    { id: 'guard', name: 'Intent and risk', on: true, optional: false,
      detail: 'deterministic rules; a model you add under Settings → Models can only raise the risk' },
    { id: 'assistant', name: 'Assistant', on: true, optional: false, detail: 'built-in offline assistant (no key), or your own model' },
    { id: 'preferenceModel', name: 'Preference parser', on: true, optional: false,
      detail: config.preferenceModelProvider === 'anthropic' && config.preferenceModelApiKey ? 'deterministic rules, plus the server model (key set)' : 'deterministic rules' },
    { id: 'liveCalendar', name: 'Live Google Calendar', on: !live, optional: true,
      detail: live === 'INTEGRATION_MODE_OFF' ? 'not configured (optional; INTEGRATION_MODE=mock)' : live === 'GOOGLE_NOT_CONFIGURED' ? 'not configured (optional; GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set)' : 'available: Google client set' },
    { id: 'pushAlerts', name: 'Phone push alerts', on: !!(config.vapidPublicKey && config.vapidPrivateKey), optional: true,
      detail: config.vapidPublicKey && config.vapidPrivateKey ? 'on (VAPID keys set)' : 'off (optional; in-app alerts still work)' }
  ];
  const usableWithoutKeys = features.filter(f => !f.optional).every(f => f.on);
  const lines = [
    'AgentGuard self-check',
    ...features.map(f => `  ${f.on ? '[on] ' : '[off]'} ${f.name}: ${f.detail}`),
    usableWithoutKeys ? '  OK: 100% usable with no API keys and no paid services (MOCK mode).' : '  Something required is off: see the lines above.'
  ];
  return { features, usableWithoutKeys, lines };
}
