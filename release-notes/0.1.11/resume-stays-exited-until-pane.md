---
prs: [292]
---
A child whose resume a stopped daemon interrupted, before its new tab opened, no longer drops out of view. The record had lost its pane and had no exit recorded, so the watcher skipped it. That was the gap. Neither `agent_list` nor doctor showed where the session was. Now the record remains exited until the new tab reports a pane. When a crossing's rollback or its recovery resumes the child on the source, `crossingFailed` stays on the record until that tab exists. Doctor then prints its `fail` line along with the resume that brings the child back.
