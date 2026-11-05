#!/usr/bin/env node
// The Claude Code MCP channel entry point. Claude Code starts it over stdio,
// and the plugin manifest runs it from the plugin root.
import '../src/integrations/claude/channel.ts';
