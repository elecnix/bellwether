#!/usr/bin/env node
// A Claude Code child's stand-in for a second Bellwether server. When the
// operator added a Bellwether server under a name other than `bellwether`,
// the child's own MCP config lists that name too, pointing here. Claude Code
// lets --mcp-config win a name, so the child starts this server instead of
// the duplicate: it offers no tools, joins no daemon and sends nothing. The
// child's Bellwether tools come from its own server alone, which carries its
// child id.
//
// stdout carries the MCP protocol, so nothing is logged to it.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BELLWETHER_VERSION } from '../../core/version.ts';

const mcp = new Server(
  { name: 'bellwether-stand-down', version: BELLWETHER_VERSION },
  { capabilities: { tools: {} }, instructions: 'This server stands in for a second Bellwether server, so this session has one set of Bellwether tools. It offers none itself.' },
);
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

const quit = (): never => process.exit(0);
process.stdin.on('end', quit);
process.stdin.on('close', quit);
process.on('SIGTERM', quit);
mcp.onclose = quit;
await mcp.connect(new StdioServerTransport());
