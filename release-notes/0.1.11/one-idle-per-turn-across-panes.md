---
prs: [289]
---
After a restart, resume, move or teleport, the parent no longer hears a child's last turn again, and the resumed session's first screen no longer counts as a turn. A turn that herdr numbers a few seconds after it ends now gives one `idle` event. Before, a teleported child sent two `idle` events, ten seconds apart, for a turn that its transcript ends once.
