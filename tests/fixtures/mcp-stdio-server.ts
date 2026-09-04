import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { protectStdout } from "../../src/mcp/stdio-safety.ts";

protectStdout();
console.log("stdio fixture startup diagnostic");

const server = new Server(
  { name: "stdio-safety-fixture", version: "0.0.1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
await server.connect(new StdioServerTransport());
