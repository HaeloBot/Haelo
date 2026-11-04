// Using Haelo from your own agent code with the official MCP client.
// Run Haelo first:  haelo serve --http   (token printed at startup / in <stateDir>/http-token)
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "my-agent", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${process.env.HAELO_HTTP_TOKEN}` } },
  }),
);

console.log(await client.callTool({ name: "haelo_status", arguments: {} }));
console.log(
  await client.callTool({
    name: "place_order",
    arguments: { symbol: "SOL/USDC", side: "buy", notional_usd: 25, rationale: "example" },
  }),
);
await client.close();
