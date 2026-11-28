---
prs: [237]
---
An adoption on another machine whose answer the relay lost no longer leaves a claim there that answers to nobody. The parent records the child as in doubt and sends `relay-adopt` again, holding the child's events until an answer comes. A kept claim clears the doubt, and a refusal ends the child with the reason in its exit event.
