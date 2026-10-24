/** In-memory app state. Nothing here is persisted: sessions are cookies the page cannot read. */
export const state = {
  me: null,            // { id, email, plan, timezone, killSwitch }
  catalog: {},         // tool -> { name, operations: { op: label } }
  pendingCount: 0
};

export function setCatalog(tools) {
  state.catalog = Object.fromEntries(tools.map(t => [t.tool, {
    name: t.name,
    operations: Object.fromEntries(t.operations.map(o => [o.operation, o.label])),
    intents: Object.fromEntries(t.operations.map(o => [o.operation, o.intent]))
  }]));
}
export const toolName = tool => state.catalog[tool]?.name ?? tool;
export const opLabel = (tool, op) => state.catalog[tool]?.operations?.[op] ?? op;
export const opIntent = (tool, op) => state.catalog[tool]?.intents?.[op];
/** the only intents the backend lets a user auto-allow */
export const canAutoAllow = (tool, op) => ['READ_DATA', 'SET_REMINDER'].includes(opIntent(tool, op));
