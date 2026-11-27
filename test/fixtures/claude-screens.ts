// Claude Code's startup screens, copied from a real Claude Code 2.1.332 pane
// that herdr read with `pane.read --source visible`. The probe that captured
// them is described in docs/probes.md, section 6.
export const TRUST_NO_SELECTED = `user@host:/var/tmp/bw-dlg-kamEEq$ claude --dangerously-load-development-channels=server:bellwether --model haiku
───────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /var/tmp/bw-dlg-kamEEq

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

export const TRUST_YES_SELECTED = TRUST_NO_SELECTED.replace(' ❯ No, exit\n   Yes, I trust this folder', '   No, exit\n ❯ Yes, I trust this folder');

export const CHANNEL_ACCEPT_SELECTED = `user@host:/var/tmp/bw-dlg-kamEEq$ claude --dangerously-load-development-channels=server:bellwether --model haiku
───────────────────────────────────────────────────────────────────────────────
  WARNING: Loading development channels

  --dangerously-load-development-channels is for local channel development only. Do not use this option to run
  channels you have downloaded off the internet.

  Please use --channels to run a list of approved channels.

  Channels: server:your-attention, server:bellwether

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
`;

export const CHANNEL_EXIT_SELECTED = CHANNEL_ACCEPT_SELECTED.replace('  ❯ 1. I am using this for local development\n    2. Exit', '    1. I am using this for local development\n  ❯ 2. Exit');

export const CLAUDE_PROMPT = ` ▐▛███▛█   Claude Code v2.1.332
▝▜██████▀  Haiku 5.5 · Claude Ultra
 ▝▝   ▝▝   /var/tmp/bw-dlg-kamEEq

▎ Channels (experimental) messages from server:your-attention, server:bellwether inject directly in this session ·
▎ restart without --dangerously-load-development-channels to stop

───────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for <filepath>"
───────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

/** A permission question the child asks while it works, which the operator owns. */
export const PERMISSION_QUESTION = ` Bash command

   rm -rf build

 Do you want to proceed?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently (esc)
`;
