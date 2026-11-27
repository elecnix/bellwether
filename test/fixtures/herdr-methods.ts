// The methods Bellwether calls, and the fields each one must carry. The full
// schema comes from `herdr api schema --json`; this table is the subset the
// client uses, so a test can validate a request without the herdr binary.
export const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  'agent.list': [],
  'agent.get': ['target'],
  'pane.list': [],
  'pane.current': [],
  'workspace.list': [],
  'workspace.create': [],
  'workspace.close': ['workspace_id'],
  'tab.list': [],
  'tab.rename': ['tab_id', 'label'],
  'session.snapshot': [],
  'tab.create': [],
  'tab.close': ['tab_id'],
  'agent.start': ['name', 'kind', 'pane_id'],
  'agent.prompt': ['target', 'text'],
  'agent.send_keys': ['target', 'keys'],
  'agent.rename': ['target'],
  'pane.send_input': ['pane_id'],
  'pane.read': ['pane_id', 'source'],
  'pane.close': ['pane_id'],
  'pane.process_info': ['pane_id'],
  'events.subscribe': ['subscriptions'],
  'integration.list': [],
};

/** The reason a request is refused, or undefined when it is well formed. */
export function validateRequest(method: string, params: Record<string, unknown>): string | undefined {
  const required = REQUIRED_FIELDS[method];
  if (required === undefined) return `unknown method ${method}`;
  for (const field of required) {
    if (params[field] === undefined) return `missing required field ${field} for ${method}`;
  }
  return undefined;
}
