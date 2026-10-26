import { EventEmitter } from 'node:events';

/** "Something changed" for one user: an audit event type and the action it concerns. Never carries payloads. */
export interface ChangeEvent { userId: string; eventType: string; actionId: string | null }

/** In-process fan-out for live alerts (GET /api/stream and Web Push). Fed by the audit log, so every audited change is announced. */
export function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish: (e: ChangeEvent) => { emitter.emit('change', e); },
    subscribe: (fn: (e: ChangeEvent) => void) => { emitter.on('change', fn); return () => { emitter.off('change', fn); }; },
    listenerCount: () => emitter.listenerCount('change')
  };
}
export type EventBus = ReturnType<typeof createEventBus>;
