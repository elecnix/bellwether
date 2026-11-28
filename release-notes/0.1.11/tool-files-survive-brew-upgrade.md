---
prs: [285]
---
A child's tool files now point at Node and Bellwether through their Homebrew `opt/` links, which survive `brew upgrade`. An older file can still point into a `Cellar/` directory that an upgrade deleted. The daemon then writes its own install's path in place of the missing one, at its start and when the child's server connects. `bellwether doctor` warns about each path it wrote. Before this change, Claude Code could not start such a child's server again, and the dialog hook failed on each notification.
