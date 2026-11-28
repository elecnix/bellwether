---
prs: [229]
---
When another machine loses its claim on an adopted child, as after a reboot, a message no longer falls back to typing silently. The parent's daemon claims the pane there again under the same child id, sends the message into the session, and the reply says the claim came back. `agent_adopt` on a pane this session already holds asks that machine too, restoring a lost claim. A child that machine won't take back keeps `farRecordLost`. Doctor prints a `warn` line.
