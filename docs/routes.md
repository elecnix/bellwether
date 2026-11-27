# Routes

Some harnesses run behind a launcher: a wrapper that starts the harness and routes its requests, such as through a model router or under another tenant's key. A route tells Bellwether about one such launcher on this machine. `agent_spawn` with `via` then starts a child behind it, and `agent_restart` or `agent_spawn` with `resume` moves a live child onto a route or off it while keeping its conversation.

```text
agent_spawn kind=claude name=worker via=example-router model=example-fast
agent_restart target=worker via=none
```

## The routes file

Routes live in `~/.config/bellwether/routes.json`, or in the file that `BELLWETHER_ROUTES` names. A route describes this machine's launcher, so it belongs with the operator's other settings, outside the Bellwether home. A wipe of that home leaves it in place. Edit it by hand. The home under `~/.bellwether` holds state that the daemon writes and prunes, and no person edits it.

```json
{
  "routes": {
    "example-router": {
      "launcher": ["example-router", "--yes"],
      "tierArgs": ["--model", "{tier}"],
      "tiers": ["example-deep", "example-fast"],
      "defaultTier": "example-deep",
      "key": { "env": "EXAMPLE_ROUTER_KEY" },
      "harnesses": ["claude", "pi", "codex"],
      "description": "Its requests go through the example router, which picks the provider."
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `launcher` | The argv prefix that runs in front of the harness. Required. |
| `tierArgs` | The arguments that pass the tier, placed after the launcher and before the harness name. Each `{tier}` becomes the tier. Defaults to `--model {tier}`. |
| `tiers` | Tier names the launcher accepts. When listed, Bellwether refuses any other `model` on this route. |
| `defaultTier` | The tier for a child whose spawn names none. |
| `key` | How the launcher receives a key file. `{ "env": "NAME" }` has the pane's shell read the file into that variable, and `{ "flag": "--some-flag" }` passes the file's path with that flag. A route without `key` refuses `key_file`. |
| `harnesses` | The harness kinds the launcher runs. Defaults to claude, pi and codex. |
| `harnessArgs` | Arguments a harness needs on this route, by kind, placed right after the harness name. Bellwether starts every child past the shell's functions and aliases, so a flag that a `claude` function adds reaches no child, and the route lists such flags itself. |
| `description` | One line on what a child on this route sees that a bare one does not. `bellwether doctor` prints it. |

Bellwether reserves `via none` for a bare start, so no route can take that name.

## Launching a routed child

A child on a route runs the launcher, then the tier, then the harness name and the harness's own arguments, which the launcher hands on unchanged:

```text
example-router --yes --model example-fast claude --mcp-config=… --dangerously-load-development-channels=server:bellwether @…/brief.md
```

On a route, `model` names a tier and goes to the launcher, so Bellwether passes no `--model` to the harness. A pi child starts the same way. The launcher and the tier come first, then `pi -e <extension>` and its brief. The route's tier picks the model, so a pi child doesn't inherit a provider and model pair from its parent, and the spawn refuses `provider` on a route.

Bellwether types the launch line at the shell prompt of the tab it has just created, then waits for herdr to detect the harness in that pane and gives the agent its name.

## Launching a bare child

A bare child starts the same way, with no launcher. Its line puts the shell's `command` builtin in front of the harness:

```text
command claude --mcp-config=… --dangerously-load-development-channels=server:bellwether @…/brief.md
```

herdr's `agent.start` would type the bare name `claude`, and a shell function or alias of that name would run in its place. With `command`, the shell finds the harness on its `PATH` and skips both. The operator's startup files can't add channels or flags to a child.

Restarting a parent session is different. That session belongs to the operator and still starts through `agent.start`. A shell function of the harness's name applies to it, just as when the operator starts it by hand.

## Key files

`key_file` names a file containing a key, such as another tenant's, and the launcher runs under that key. Only the path travels. With an `env` key, the line reads `EXAMPLE_ROUTER_KEY="$(cat /path/to/key)" example-router …`, and the pane's shell reads the file when it runs that line. The key never appears on a command line, in a herdr request, on the child's record or in a log.

The child's record keeps the key file's path, and `agent_list` marks the route with `(key file)`. Someone debugging routing can then tell that two children ran under different keys.

## Refusals

Each refusal happens before Bellwether writes a record or opens a tab, and names the flag to add or drop.

| Request | Refusal |
| --- | --- |
| A tier of some route, passed as `model` without `via` | names the route that has the tier, and says to add `via` |
| `via` a route, with a `model` that is not one of its tiers | names the route's tiers, and says to drop `model` or drop `via` |
| `via` a route, with no routes file at all | names the file, and says to create it with that route or pass `via none` |
| `via` a route, with a routes file that defines none | names the file, and says to add the route there or pass `via none` |
| `via` a name the routes file does not define | lists the defined routes, and offers `via none` for a bare start |
| `key_file` that does not exist or is empty | names the file |
| `key_file` without `via`, or on a route with no `key` | says to add `via`, or to add `key` to the route |
| `provider` on a route | says to drop `provider`, because the tier picks the model |
| `via` with `machine` set to another machine | a route is this machine's launcher |

## Changing route on a live child

`agent_restart` with `via` restarts a child on the same session behind another route, or bare with `via none`. `agent_spawn` with `resume` does the same for a child that has exited. Each passes the harness its resume flag, so the conversation continues: `--resume <session id>` for Claude Code and `--session <file>` for pi. Only the launcher in front of the harness changes.

A restart or resume that omits `via` leaves the child on its current route, with its tier and key file, because the record holds how Bellwether launched the child. A resume never drops a route unless it passes `via none`, and `via none` always starts the harness bare, with no launcher and none of the launcher's variables.

A pi session records its provider, so a pi child leaving a route needs `model` and `provider` for the bare start, and the restart refuses without them.

Bellwether refuses a resume with `via` for a child that is still alive, because a resume only messages a live child and cannot change its route. Call `agent_restart` with `via` instead.

`agent_move` refuses a child on a route, since the other machine's routes file does not hold this machine's launcher. Restart the child with `via none` first.

## Doctor

`bellwether doctor` names the routes file and lists the routes it defines. Each route then gets one line. That line gives the launcher a child on the route runs under, the tiers and the default tier, and how the launcher receives a key file, followed by the route's own `description`.

The line also shows the live children on that route. A child recorded on a route that the file no longer defines fails the check, because a restart could not start it behind that route again.

## An older daemon

A daemon from before routes would ignore `via` and `key_file` and start the child bare. So when the daemon's hello does not list routes, the client refuses any call with either argument and names the release that brings them. `bellwether doctor` reports the same gap.
