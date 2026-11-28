---
prs: []
---
On another machine, an adoption of a pane whose first session has left now gets a new child id for the new session. Before this change, the far machine kept the parent's old claim on that pane and handed back the old child id. One child id stood for two sessions.

A child that a parent on another machine started now holds its pane on that machine, as an adopted session does. A second parent there can no longer watch that pane through `agent_adopt`. The child holds the pane for as long as its own Bellwether server or extension stays connected to that machine's daemon.

An adopted child whose harness quit waits for its session to come back to the pane. A parent on another machine can adopt the pane once the session is back, before the watcher here hears of it. The waiting child then stops waiting. Before, it came back too, so two parents watched one pane.
