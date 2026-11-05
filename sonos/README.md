# Sonos

Give an iterate project's agents the person's Sonos system: play from their linked music services
(Spotify and others), Sonos Favorites and playlists, volume, grouping and transport. Nothing to
receive and no package: Sonos hosts an official MCP server, [Sonos 27mcp](https://support.sonos.com/en/article/control-your-sonos-system-with-ai-using-sonos-27mcp),
at `https://mcp.ws.sonos.com/mcp`, so this recipe is only the connection.

The server speaks OAuth 2.1 with PKCE and open client registration, and the person signs in with
their Sonos account. It is Early Access, English only, and needs an S2 system on a Sonos account.
If an action fails, try it on <https://play.sonos.com>; the server can do only what that can.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you).

## 1. Connect

Follow [zero-trust-mcp.md](../zero-trust-mcp.md) with `/secrets/sonos` as the secret, and these
endpoints in place of the Worker's (from `https://mcp.ws.sonos.com/.well-known/oauth-authorization-server`):

- register: `https://mcp.ws.sonos.com/mcp-oauth/register`
- authorize: `https://mcp.ws.sonos.com/mcp-oauth/authorize`
- token: `https://mcp.ws.sonos.com/mcp-oauth/token`
- scope: `playback-control-all partner-content:read`
- `urls: ["https://mcp.ws.sonos.com"]`

The person's link goes to a Sonos consent page, then the Sonos sign-in.

## 2. Use it

```js
async (itx) => {
  const mcp = await itx.connectToMcp("https://mcp.ws.sonos.com/mcp", {
    headers: {
      authorization: 'Bearer getSecret("/secrets/sonos", { field: "accessToken" })',
    },
  });
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  await mcp.close();
  return tools;
};
```

Sonos's terms say the tools change: list them each time and never hard-code their names. Then
write the connection down for the project's agents (`AGENTS.md` in `/repos/config`).
