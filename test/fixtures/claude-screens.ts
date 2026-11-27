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

/**
 * The channel question as an operator met it in issue #133: a shell function
 * added its own development channels, so it lists five, and the selection
 * sits on "Exit". The channel names other than Bellwether's are synthetic.
 */
export const CHANNEL_FIVE_EXIT_SELECTED = CHANNEL_EXIT_SELECTED.replace('Channels: server:your-attention, server:bellwether', 'Channels: server:example-one, server:example-two, server:example-three, server:example-four, server:bellwether');

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

// The two questions below are built from the dialog strings in Claude Code
// 2.1.332's build (its title, question and option labels), laid out as its
// permission dialogs draw: a tool header, the call, the reason, the question
// and the numbered options with the first one selected.

/** Auto mode's question about a file-tool read outside the working directories. */
export const OUTSIDE_READ_QUESTION = ` Read file

   Read(/var/tmp/example-other-repo/eslint.config.js)

 Read outside the working directories
 Auto mode and the sandbox read outside the working directories without asking. Yes or No answers for this read; the rest is for later reads.

 Allow this read outside the working directories?
 ❯ 1. Yes, and keep allowing any reads outside the working directories
   2. No, and block reads outside the working directories from now on
   3. No, and ask again next time
   4. Yes, but ask again next time
`;

/** A shell command Claude Code could not prove free of a dangerous rm, which it asks a person to approve. */
export const DANGEROUS_RM_QUESTION = ` Bash command

   python3 - <<'EOF' > config.toml.new && mv config.toml.new config.toml

 Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed

 Do you want to proceed?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently (esc)
`;

/** A startup question no entry in Claude Code's set names. */
export const UNKNOWN_STARTUP_QUESTION = ` Example settings migration

 Claude Code found settings from an earlier example release.

 Import them into this session?
 ❯ 1. Yes, import them
   2. No, start fresh
`;

/**
 * A screen under a shell whose own prompt begins with ❯, as zsh themes such as
 * pure draw it: the launch line replaces the bash prompt the probe captured.
 */
export function underGlyphPrompt(screen: string): string {
  const launch = '❯ command claude --mcp-config=/var/tmp/bw/mcp.json --settings=/var/tmp/bw/settings.json --dangerously-load-development-channels=server:bellwether';
  return screen.replace(/^[^\n]*\n/, `${launch}\n`);
}

/**
 * The channel question as issue #160 quotes it from a Mac: the pane's prompt
 * line, the warning, and the numbered options with the cursor on 1. The
 * paths stand in for the real ones the issue elides.
 */
export const CHANNEL_UNDER_GLYPH_PROMPT = `❯ command claude --mcp-config=/var/tmp/bw/mcp.json --settings=/var/tmp/bw/settings.json --dangerously-load-development-channels=server:bellwether
  WARNING: Loading development channels
  ❯ 1. I am using this for local development
    2. Exit
`;

/** The same question with the prompt line absent, as a pane that scrolled it away shows it. */
export const CHANNEL_WITHOUT_PROMPT = CHANNEL_UNDER_GLYPH_PROMPT.replace(/^[^\n]*\n/, '');

/** The channel question with the selection marker on both options, which no reader can resolve. */
export const CHANNEL_TWO_MARKED = CHANNEL_UNDER_GLYPH_PROMPT.replace('    2. Exit', '  ❯ 2. Exit');
