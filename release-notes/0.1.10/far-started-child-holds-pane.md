---
prs: [259]
---
A child that a parent on another machine started now holds its pane on that machine, as an adopted session does. A second parent there can no longer watch that pane through `agent_adopt`. The child holds the pane for as long as its own Bellwether server or extension stays connected to that machine's daemon.
