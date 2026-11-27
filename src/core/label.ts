// How a message names a child. Two children may share a name, so the name is
// the human label and the pane id tells them apart. A child whose tab never
// opened has no pane yet, and its own id stands in.
export function childLabel(child: { name: string; paneId?: string; id?: string }): string {
  const handle = child.paneId || child.id?.slice(0, 8);
  return handle ? `${child.name} (${handle})` : child.name;
}
