---
prs: []
---
Bellwether now delivers a message it never types, such as a teleport's notice, when its session next connects. Before this change, the reply and `bellwether doctor` said the session would receive it. It never did. The replay skipped messages the adapter had left unanswered.

A push the session didn't answer within 5 seconds now shows in `agent_list` as in doubt, and a late answer makes it pushed. A read that arrives before the relay loses its answer leaves the message read. It is not in doubt. A child on another machine that retired after its session took a message stops marking it undelivered once the relay comes back.

`agent_list` gives every message one of seven words: sending, held, pushed, in doubt, typed, read or undelivered. A self-restart that waits counts only messages the model has received. A brief whose message the session reads after its start now shows as read.
