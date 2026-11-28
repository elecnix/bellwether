---
prs: [282]
---
A parent frees a child with `agent_free` or `bellwether free`. The child leaves the parent's registry and becomes a peer at its child id. Once freed, its turns no longer wake the parent, and its briefs go to its own record. Its reports go nowhere. Peers exchange messages with `peer_send`, and the receiving daemon checks the token that both sides share.
