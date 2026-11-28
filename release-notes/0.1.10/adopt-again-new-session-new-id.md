---
prs: [259]
---
On another machine, an adoption of a pane whose first session has left now gets a new child id for the new session. Before this change, the far machine kept the parent's old claim on that pane and handed back the old child id. One child id stood for two sessions.
