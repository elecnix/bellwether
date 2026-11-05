# Bellwether phase 0 findings

Each question from the design gets a section below with the command, the output trimmed to what answers it, and a verdict.

The probes ran against a herdr server of their own, which left the operator's session alone:

```sh
(herdr --session bw-probe server >/tmp/bw-probe-server.log 2>&1 &)
until [ -S ~/.config/herdr/sessions/bw-probe/herdr.sock ]; do sleep 0.3; done
herdr --session bw-probe status
```

```text
server:
  status: running
  version: 0.9.5
  socket: /Users/nicolas/.config/herdr/sessions/bw-probe/herdr.sock
```

Versions: herdr 0.9.5, Claude Code 2.1.312, Pi 1.5.0.

The scripts live in `scripts/` and run under plain `node`, because Node 22.18 strips type annotations by itself.

- `scripts/channel-stub.ts` is a one-way Claude Code channel. Each line appended to `CHANNEL_INBOX` becomes one `notifications/claude/channel` event. A cursor file counts the lines already sent, so a line cannot arrive twice or vanish.
- `scripts/scripted-anthropic.ts` answers `/v1/messages` and logs each request as one JSON line. With `HOLD_UNTIL` set, it holds a request open, which lets a probe send a notification mid-turn.
- `scripts/channel-probe.ts` drives question 1. It writes one inbox line, then records a request at the scripted server (a turn), the transcript gaining an assistant message, and herdr's pane fields.
- `scripts/herdr-watch.ts` prints the pane fields at every `pane.agent_status_changed` event.

## 1. An idle Claude session, and a notification sent mid-turn

> Does a channel notification start a turn in an idle Claude session, and what happens to one sent during a turn? The channels doc says Claude Code groups it into the next turn. tuicommander's doc says it can't start a later turn.

The session ran with the development channel flag against the scripted Messages server, so every turn shows up as one logged request.

```sh
herdr --session bw-probe tab create --workspace w1 --cwd /tmp/bw-probe/q1 --label q1-claude \
  --env CLAUDE_CONFIG_DIR=/tmp/bw-probe/claude-config \
  --env ANTHROPIC_BASE_URL=http://127.0.0.1:8788 \
  --env ANTHROPIC_API_KEY=probe-key --no-focus
herdr --session bw-probe agent start q1 --kind claude --pane w1:p5 -- \
  --dangerously-load-development-channels server:bellwether
```

Claude Code stopped at four dialogs on the way up, covering project trust, MCP server consent, the API key and the development channel warning. The channel warning reads:

```text
  WARNING: Loading development channels
  Channels: server:bellwether
  ❯ 1. I am using this for local development
    2. Exit
```

One `Enter` cleared it and the pane reported `idle`. Then one line went into the channel inbox while the session was idle:

```sh
node scripts/channel-probe.ts --phase idle --session bw-probe --pane w1:p5 \
  --inbox /tmp/bw-probe/q1/inbox.txt --log /tmp/bw-probe/req-q1c.jsonl \
  --transcript /tmp/bw-probe/claude-config/projects/-private-tmp-bw-probe-q1 \
  --text "PROBE-A3 idle wake, single line" --seconds 20
```

```text
{"at":"2026-11-05T06:14:42.793Z","ms":110,"source":"start","message":"baseline","phase":"idle","turns":0,"assistantMessages":4,"status":{"agent_status":"idle","completion_seq":null,"revision":1}}
{"at":"2026-11-05T06:14:42.794Z","ms":110,"source":"sent","message":"wrote one channel line","text":"PROBE-A3 idle wake, single line"}
{"at":"2026-11-05T06:14:43.108Z","ms":424,"source":"turn","message":"a turn started from an idle session","turns":1,"status":{"agent_status":"idle","completion_seq":null,"revision":1}}
{"at":"2026-11-05T06:15:03.966Z","ms":21282,"source":"summary","message":"what the model was shown, per turn","baseTurns":0,"turns":[{"turn":1,"at":"2026-11-05T06:14:42.935Z","channels":["PROBE-A3 idle wake, single line"]}],"suggestionRequests":0,"assistantMessages":4,"status":{"agent_status":"idle","completion_seq":null,"revision":1}}
```

The request behind that turn, from the server's own log:

```sh
jq -c 'select(.path|startswith("/v1/messages")) | {at, msgs:(.body.messages|length)}' /tmp/bw-probe/req-q1c.jsonl
```

```text
{"at":"2026-11-05T06:14:42.935Z","msgs":2}
```

The block the model read:

```text
<channel source="bellwether" source="bellwether" probe="phase0">
PROBE-A3 idle wake, single line
</channel>
```

**Verdict: a channel notification starts a turn in an idle Claude session.** The request arrived 141 ms after the probe wrote the line, and the turn finished in 424 ms with nobody asked and no timer waited out. So the Claude adapter can wake an idle parent with a channel notification alone, and one wake path is enough.

**Unprobed: the notification sent during a turn.** The driver for that half is `scripts/channel-probe.ts --phase during --release /tmp/bw-probe/release`, run against a scripted server started with `HOLD_UNTIL=/tmp/bw-probe/release HOLD_EACH=1`. This document has no measurement for it yet, so the grouping claim in the design still rests on the documentation.

## 2. Both development channels in one `claude` command

> Does one claude command accept two development channels, server:your-attention and server:bellwether?

The probe project declares both servers in `.mcp.json`, each a stub with its own inbox:

```sh
cat /tmp/bw-probe/q2/.mcp.json
```

```json
{
  "mcpServers": {
    "your-attention": {
      "command": "node",
      "args": ["/Users/nicolas/Source/bellwether/probes/scripts/channel-stub.ts"],
      "env": { "CHANNEL_INBOX": "/tmp/bw-probe/q2/attention.inbox", "CHANNEL_SOURCE": "your_attention" }
    },
    "bellwether": {
      "command": "node",
      "args": ["/Users/nicolas/Source/bellwether/probes/scripts/channel-stub.ts"],
      "env": { "CHANNEL_INBOX": "/tmp/bw-probe/q2/bellwether.inbox", "CHANNEL_SOURCE": "bellwether" }
    }
  }
}
```

One flag, comma-separated:

```sh
herdr --session bw-probe agent start q2 --kind claude --pane w1:p6 -- \
  --dangerously-load-development-channels server:bellwether,server:your-attention
```

```text
  WARNING: Loading development channels
  Channels: server:bellwether,server:your-attention
  ❯ 1. I am using this for local development
```

The repeated flag, without a comma:

```sh
herdr --session bw-probe agent start q2r --kind claude --pane w1:p7 -- \
  --dangerously-load-development-channels server:bellwether \
  --dangerously-load-development-channels server:your-attention
```

```text
  WARNING: Loading development channels
  Channels: server:bellwether, server:your-attention
```

**Verdict: one command accepts both channels, and both spellings enable both servers.** The comma form arrives as one list item and the repeated form as two, and Claude Code shows both names either way. The wrapper line in the design, `claude --dangerously-load-development-channels server:your-attention,server:bellwether`, works as written.

One negative result matters: `claude -p` takes any string after that flag, because print mode ignores the development flag entirely and validates the name later or never.

```sh
claude -p --dangerously-load-development-channels nonsense -- "say ok"
```

```text
ok
```

A malformed channel name fails only in an interactive session, at the `Channels:` line of that warning dialog, so a test built on `claude -p` cannot validate channel specs.

## 3. Channels with an API key and a custom `ANTHROPIC_BASE_URL`

> Do channels work with an API key and a custom ANTHROPIC_BASE_URL?

The session from question 1 used both: `ANTHROPIC_API_KEY=probe-key` and `ANTHROPIC_BASE_URL=http://127.0.0.1:8788`, pointing at the scripted server. That config directory has no claude.ai login in it:

```sh
CLAUDE_CONFIG_DIR=/tmp/bw-probe/claude-config claude auth status
```

```text
{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty",
  "configDirectory": "/tmp/bw-probe/claude-config"
}
```

The scripted server received every turn with the key on it:

```sh
jq -c 'select(.path|startswith("/v1/messages")) | {at, hasApiKey, authorization}' /tmp/bw-probe/req-q1c.jsonl
```

```text
{"at":"2026-11-05T06:14:42.935Z","hasApiKey":true,"authorization":null}
```

That request is the turn which the channel notification started, as quoted under question 1.

**Verdict: channels work with an API key and a custom base URL.** A notification woke a session that never contacted Anthropic, and the model call went to the local endpoint. The lab can put a Claude child on a scripted Messages server, so the Claude rows belong at tier 3 and do not move to tier 4.

## 4. Does `agent.start` inherit the `env` from `tab.create`?

> Does the harness started by agent.start inherit the env given to tab.create?

Bellwether's own end-to-end smoke test already proved it: a Pi child started through `tab.create` and `agent.start` read `BELLWETHER_PARENT` from its own environment and wrote a report to its parent's spool. A one-line check confirms it here, on a pane made with one variable:

```sh
herdr --session bw-probe tab create --workspace w1 --cwd /tmp/bwp1 --label claude-probe \
  --env PROBE_ENV=hello --no-focus
herdr --session bw-probe pane run w1:p2 'echo "PROBE_ENV=[$PROBE_ENV]"'
herdr --session bw-probe pane read w1:p2 --source recent-unwrapped --lines 10
```

```text
❯ echo "PROBE_ENV=[$PROBE_ENV]"
PROBE_ENV=[hello]
```

`tab.create` passes the variable to the shell it starts, and `agent.start` passes it on to the harness it launches in that shell. The Claude process from question 1 carries all three variables the tab set:

```sh
ps eww -p "$(pgrep -f 'claude --dangerously-load-development-channels' | head -1)" |
  tr ' ' '\n' | grep -E '^(CLAUDE_CONFIG_DIR|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY)='
```

```text
CLAUDE_CONFIG_DIR=/tmp/bw-probe/claude-config
ANTHROPIC_BASE_URL=http://127.0.0.1:8788
ANTHROPIC_API_KEY=probe-key
```

**Verdict: yes, `agent.start` inherits the `env` from `tab.create`, for the shell and for the harness started inside it.** So `spawn` passes `BELLWETHER_PARENT`, `BELLWETHER_CHILD` and `BELLWETHER_DEPTH` once at `tab.create` and leaves the harness command line alone.

## 5. `completion_seq` on a Claude pane and a Pi pane

> Does herdr 0.9.5 report completion_seq for Claude, whose status comes from screen detection, and for Pi, whose status comes from its integration?

**Claude: probed.** An interactive Claude Code session ran in three panes. Each pane moved through `working` and back to `idle`, and every read from every entry point showed `completion_seq` absent.

```sh
herdr --session bw-probe agent list | jq -c '.result.agents[] | {pane_id,name,agent_status,state_change_seq,completion_seq}'
```

```text
{"pane_id":"w1:p5","name":"q1","agent_status":"idle","state_change_seq":4,"completion_seq":null}
{"pane_id":"w1:p6","name":"q2","agent_status":"idle","state_change_seq":6,"completion_seq":null}
{"pane_id":"w1:p7","name":"q2r","agent_status":"blocked","state_change_seq":7,"completion_seq":null}
```

```sh
herdr --session bw-probe pane list | jq -c '.result.panes[] | {pane_id,agent,agent_status,completion_seq}'
```

```text
{"pane_id":"w1:p1","agent":null,"agent_status":"unknown","completion_seq":null}
{"pane_id":"w1:p5","agent":"claude","agent_status":"idle","completion_seq":null}
{"pane_id":"w1:p6","agent":"claude","agent_status":"idle","completion_seq":null}
{"pane_id":"w1:p7","agent":"claude","agent_status":"blocked","completion_seq":null}
```

`state_change_seq` does move: 4 for a pane that ran two turns, and 7 for the pane blocked at a dialog. The schema calls `completion_seq` "the current idle transition completed work, independently of who has viewed it", so a null there records that herdr has not yet counted an idle transition as completed work.

**Pi: unprobed here.** The bootstrap smoke test saw `completion_seq` null for a Pi child while its status moved `working` to `done`, recorded in that pull request's body. This document measures Claude and leaves Pi to the lab.

**Verdict for Claude: herdr 0.9.5 doesn't report `completion_seq` for a screen-detected Claude pane, so the status-change fallback in `classifier.ts` serves Claude as well as Pi and is the MVP's only completion signal.** `state_change_seq` is the field that does report a change, so the child record is worth widening to keep it next to `completionSeq`.
