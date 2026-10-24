/**
 * Tool catalog: every tool, its operations, and each operation's base intent and base risk
 * (docs/PROJECT_REQUIREMENTS.md §2, docs/INTENT_AND_RISK.md). Shared by permissions, intent and adapters.
 */
export type Intent =
  | 'READ_DATA' | 'SEND_MESSAGE' | 'SEND_EMAIL' | 'PUBLISH_CONTENT' | 'EDIT_CONTENT' | 'DELETE_CONTENT'
  | 'SCHEDULE_EVENT' | 'MODIFY_EVENT' | 'CANCEL_EVENT' | 'SET_REMINDER' | 'MAKE_PAYMENT' | 'REFUND'
  | 'SUBSCRIBE' | 'CONNECT_SOCIAL' | 'UNKNOWN';

export interface OperationDef { intent: Intent; baseRisk: number; write: boolean; label: string }
export interface ToolDef { name: string; operations: Record<string, OperationDef> }

const read = (label: string, baseRisk = 5): OperationDef => ({ intent: 'READ_DATA', baseRisk, write: false, label });
const op = (intent: Intent, baseRisk: number, label: string): OperationDef => ({ intent, baseRisk, write: true, label });

export const CATALOG: Record<string, ToolDef> = {
  gmail: { name: 'Gmail', operations: {
    read: read('Read inbox'), search: read('Search mail'),
    send: op('SEND_EMAIL', 30, 'Send email'), reply: op('SEND_EMAIL', 30, 'Reply'), forward: op('SEND_EMAIL', 30, 'Forward'),
    delete: op('DELETE_CONTENT', 80, 'Delete email')
  } },
  calendar: { name: 'Calendar', operations: {
    view: read('View events'),
    create: op('SCHEDULE_EVENT', 30, 'Create event'), invite: op('SCHEDULE_EVENT', 30, 'Invite people'),
    update: op('MODIFY_EVENT', 30, 'Change event'), cancel: op('CANCEL_EVENT', 35, 'Cancel event')
  } },
  clock: { name: 'Clock / Reminders', operations: {
    list_alarms: read('List alarms'),
    set_alarm: op('SET_REMINDER', 10, 'Set alarm'), set_reminder: op('SET_REMINDER', 10, 'Set reminder')
  } },
  whatsapp: { name: 'WhatsApp', operations: {
    read_chats: read('Read chats', 10),
    send_message: op('SEND_MESSAGE', 30, 'Send message'), send_media: op('SEND_MESSAGE', 30, 'Send media')
  } },
  instagram: { name: 'Instagram', operations: {
    read_feed: read('Read feed'), read_insights: read('Read insights'),
    post: op('PUBLISH_CONTENT', 50, 'Post'), story: op('PUBLISH_CONTENT', 50, 'Post a story'),
    comment: op('PUBLISH_CONTENT', 50, 'Comment'), dm: op('SEND_MESSAGE', 30, 'Direct message')
  } },
  linkedin: { name: 'LinkedIn', operations: {
    read_profile: read('Read profile'), read_feed: read('Read feed'),
    post: op('PUBLISH_CONTENT', 50, 'Post'), message: op('SEND_MESSAGE', 30, 'Message'), connect: op('CONNECT_SOCIAL', 30, 'Send connection request')
  } },
  x: { name: 'X (Twitter)', operations: {
    read_timeline: read('Read timeline'),
    post: op('PUBLISH_CONTENT', 50, 'Post'), reply: op('PUBLISH_CONTENT', 50, 'Reply'), repost: op('PUBLISH_CONTENT', 50, 'Repost'),
    dm: op('SEND_MESSAGE', 30, 'Direct message')
  } },
  payments: { name: 'Payments', operations: {
    view_balance: read('View balance', 10), view_history: read('View history', 10),
    pay: op('MAKE_PAYMENT', 60, 'Pay'), transfer: op('MAKE_PAYMENT', 60, 'Transfer'),
    refund: op('REFUND', 50, 'Refund'), subscribe: op('SUBSCRIBE', 50, 'Subscribe')
  } },
  blog: { name: 'Blog / CMS', operations: {
    list_drafts: read('List drafts'),
    publish: op('PUBLISH_CONTENT', 50, 'Publish'), edit_live: op('EDIT_CONTENT', 50, 'Edit live post'),
    delete: op('DELETE_CONTENT', 80, 'Delete post')
  } }
};

export const operationDef = (tool: string, operation: string): OperationDef | undefined =>
  Object.prototype.hasOwnProperty.call(CATALOG, tool) && Object.prototype.hasOwnProperty.call(CATALOG[tool].operations, operation)
    ? CATALOG[tool].operations[operation] : undefined;
