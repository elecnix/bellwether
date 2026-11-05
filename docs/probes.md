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

The channel block Claude read:

```text
<channel source="bellwether" source="bellwether" probe="phase0">
PROBE-A3 idle wake, single line
</channel>
```

**Verdict: a channel notification starts a turn in an idle Claude session.** The request arrived 141 ms after the probe wrote the line, and the turn finished in 424 ms with nobody asked and no timer waited out. So the Claude adapter can wake an idle parent with a channel notification alone, and one wake path is enough.

**The notification sent during a turn: probed.** The scripted server ran with `HOLD_UNTIL` and `HOLD_EACH=1`, so it answered a request only once a release file existed and removed the file afterwards. That keeps one turn unanswered while a second notification goes in.

```sh
(PORT=8788 LOG=/tmp/bw-probe/req-during2.jsonl HOLD_UNTIL=/tmp/bw-probe/release \
  HOLD_EACH=1 HOLD_TIMEOUT_MS=120000 node scripts/scripted-anthropic.ts &)
node scripts/channel-probe.ts --phase during --session bw-probe --pane w1:p5 \
  --inbox /tmp/bw-probe/q1/inbox.txt --log /tmp/bw-probe/req-during2.jsonl \
  --transcript /tmp/bw-probe/claude-config/projects/-private-tmp-bw-probe-q1 \
  --release /tmp/bw-probe/release \
  --text "PROBE-D5 first turn, held open" \
  --text2 "PROBE-D6 sent while in flight" --between 2500 --seconds 60
```

```text
{"at":"2026-11-05T06:22:43.640Z","ms":113,"source":"sent","message":"wrote one channel line","text":"PROBE-D5 first turn, held open"}
{"at":"2026-11-05T06:22:43.847Z","ms":320,"source":"turn","message":"the first turn started and is held open","turns":1,"status":{"agent_status":"working","completion_seq":null,"revision":1}}
{"at":"2026-11-05T06:22:46.348Z","ms":2821,"source":"sent","message":"wrote one channel line","text":"PROBE-D6 sent while in flight"}
{"at":"2026-11-05T06:22:46.348Z","ms":2821,"source":"mid-turn","message":"the second line is now queued while a turn is in flight"}
{"at":"2026-11-05T06:22:46.665Z","ms":3138,"source":"turn","message":"a follow-up turn appeared after the held turn was answered","turns":2,"status":{"agent_status":"working","completion_seq":null,"revision":1}}
{"at":"2026-11-05T06:23:47.519Z","ms":63992,"source":"summary","turns":[{"turn":1,"at":"2026-11-05T06:22:43.676Z","channels":["PROBE-A3 idle wake, single line","PROBE-E2 mid-turn #1","PROBE-E2 mid-turn #2","PROBE-E2 mid-turn #3","PROBE-D5 first turn, held open"]},{"turn":2,"at":"2026-11-05T06:22:46.493Z","channels":["PROBE-A3 idle wake, single line","PROBE-E2 mid-turn #1","PROBE-E2 mid-turn #2","PROBE-E2 mid-turn #3","PROBE-D5 first turn, held open","PROBE-D6 sent while in flight"]}],"assistantMessages":7}
```

Both requests at the turn boundary, so the boundary comes from the server rather than from the driver's own notes:

```sh
jq -c 'select(.path|startswith("/v1/messages")) | {at, msgs:(.body.messages|length), suggestion:(.body.messages|tostring|test("SUGGESTION MODE"))}' /tmp/bw-probe/req-during2.jsonl
```

```text
{"at":"2026-11-05T06:22:43.676Z","msgs":12,"suggestion":false}
{"at":"2026-11-05T06:22:46.369Z","msgs":14,"suggestion":true}
{"at":"2026-11-05T06:22:46.493Z","msgs":14,"suggestion":false}
{"at":"2026-11-05T06:23:46.938Z","msgs":16,"suggestion":true}
```

A second run sent three notifications while a turn was held open, and one follow-up turn received all three:

```sh
node scripts/channel-probe.ts --phase during --burst 3 --session bw-probe --pane w1:p5 \
  --inbox /tmp/bw-probe/q1/inbox.txt --log /tmp/bw-probe/req-burst.jsonl \
  --release /tmp/bw-probe/release --text "PROBE-E1 first turn" \
  --text2 "PROBE-E2 mid-turn" --between 2000 --seconds 60
```

```text
{"at":"2026-11-05T06:21:07.664Z","ms":318,"source":"turn","message":"the first turn started and is held open","turns":1}
{"at":"2026-11-05T06:21:09.667Z","ms":2321,"source":"sent","text":"PROBE-E2 mid-turn #1"}
{"at":"2026-11-05T06:21:09.667Z","ms":2321,"source":"sent","text":"PROBE-E2 mid-turn #2"}
{"at":"2026-11-05T06:21:09.667Z","ms":2321,"source":"sent","text":"PROBE-E2 mid-turn #3"}
{"at":"2026-11-05T06:21:09.987Z","ms":2641,"source":"turn","message":"a follow-up turn appeared after the held turn was answered","turns":2}
{"at":"2026-11-05T06:22:13.546Z","ms":66200,"source":"summary","turns":[{"turn":1,"channels":["PROBE-A3 idle wake, single line","PROBE-E1 first turn"]},{"turn":2,"channels":["PROBE-A3 idle wake, single line","PROBE-E2 mid-turn #1","PROBE-E2 mid-turn #2","PROBE-E2 mid-turn #3"]}],"assistantMessages":5}
```

**Verdict: a notification sent during a turn waits, then starts its own turn.** It never interrupts the turn in flight: turn 1 read its own line and no later one, and turn 2 read the mid-turn line. Notifications sent together still produced one turn, not three, so Claude Code merges a burst into one next turn. The Claude adapter can send one notice per child event and let Claude Code group them, with no merge step of its own and no notice lost.

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

The question hid a trap. herdr carries `completion_seq` on `AgentInfo`, which answers `agent.list`, `agent.get` and `api snapshot` under `.agents`. The pane projections, `pane.list`, `pane.get` and `.panes` in the snapshot, use `PaneInfo`, and `PaneInfo` has no such field at all:

```sh
python3 -c "
import json
d=json.load(open('/tmp/herdr-schema.json'))
defs=d['schemas']['success_response']['\$defs']
print('PaneInfo has completion_seq:', 'completion_seq' in defs['PaneInfo']['properties'])
print('AgentInfo has completion_seq:', 'completion_seq' in defs['AgentInfo']['properties'])"
```

```text
PaneInfo has completion_seq: False
AgentInfo has completion_seq: True
```

Read `pane.list` and the answer looks like null everywhere. Read `agent.list` and both harnesses report a number. One read of each, at the same moment:

```sh
herdr --session bw-probe agent list |
  jq -c '.result.agents[] | {pane_id,name,harness:.agent,agent_status,completion_seq,state_change_seq}'
herdr --session bw-probe pane list |
  jq -c '.result.panes[] | select(.agent!=null) | {pane_id,harness:.agent,agent_status,completion_seq,state_change_seq}'
```

```text
=== agent.list (AgentInfo)
{"pane_id":"w1:p5","name":"q1","harness":"claude","agent_status":"done","completion_seq":25,"state_change_seq":25}
{"pane_id":"w1:p6","name":"q2","harness":"claude","agent_status":"idle","completion_seq":null,"state_change_seq":6}
{"pane_id":"w1:p7","name":"q2r","harness":"claude","agent_status":"blocked","completion_seq":null,"state_change_seq":7}
{"pane_id":"w1:p9","name":"q5pi","harness":"pi","agent_status":"done","completion_seq":21,"state_change_seq":21}

=== pane.list (PaneInfo)
{"pane_id":"w1:p5","harness":"claude","agent_status":"done","completion_seq":null,"state_change_seq":null}
{"pane_id":"w1:p6","harness":"claude","agent_status":"idle","completion_seq":null,"state_change_seq":null}
{"pane_id":"w1:p7","harness":"claude","agent_status":"blocked","completion_seq":null,"state_change_seq":null}
{"pane_id":"w1:p9","harness":"pi","agent_status":"done","completion_seq":null,"state_change_seq":null}
```

**Pi: probed.** A real Pi 1.5.0 session in its own pane took one prompt. The subscription delivered two events, and the second one includes the number:

```sh
herdr --session bw-probe agent start q5pi --kind pi --pane w1:p9 -- --model ollama-cloud/deepseek-v4-flash
node scripts/herdr-watch.ts --session bw-probe --pane w1:p9 --seconds 75
herdr --session bw-probe agent prompt q5pi "Reply with the single word ok and nothing else."
```

```text
{"at":"06:25:56.180","source":"event","agent_status":"working","completion_seq":null,"state_change_seq":20,"revision":1}
{"at":"06:25:56.501","source":"event","agent_status":"done","completion_seq":21,"state_change_seq":21,"revision":1}
```

**Claude: probed.** A screen-detected Claude Code pane took a channel notification with the scripted server holding the turn open, so `working` was observable for thirty seconds rather than a few hundred milliseconds:

```sh
printf 'PROBE-H1 slow claude turn\n' >> /tmp/bw-probe/q1/inbox.txt
node scripts/herdr-watch.ts --session bw-probe --pane w1:p5 --seconds 75
```

```text
{"at":"06:29:22.680","source":"event","agent_status":"working","completion_seq":null,"state_change_seq":24,"revision":1}
{"at":"06:29:52.797","source":"event","agent_status":"done","completion_seq":25,"state_change_seq":25,"revision":1}
```

The numbers only move when herdr sees a transition. A Claude turn that finishes under a second, or runs while the scripted server answers instantly, can leave `completion_seq` where it was, because screen detection never caught `working` at all. The 30-second held turn is what makes the Claude reading trustworthy.

**Verdict: herdr 0.9.5 reports `completion_seq` for both harnesses, and only on the agent projection.** Bellwether reads it from the projection that lacks it: `watcher.ts` takes it from `pane.list` and from `snapshot['panes']`, and both are `PaneInfo`. The fix is to read `agent.list`, `agent.get` or `snapshot['agents']`, and to keep `state_change_seq` beside `completionSeq` in the child record, because the two move together and a stalled `state_change_seq` is the cheapest evidence that detection missed a turn.
