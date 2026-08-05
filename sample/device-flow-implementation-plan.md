# Removing the setup-code paste from the QuickBooks connector

Implementation plan for replacing the manual setup-code step with an in-chat
authorization flow, on the existing bundled extension. No hosting required.

## Current state

Read from `quickbooks-mcp-server.dxt` v1.0.0:

| | |
|---|---|
| Tools registered | 141 |
| Broker logic | inlined in `dist/clients/quickbooks-client.js` |
| Credential source | `FINOS_CREDENTIAL` from `user_config.setup_code` |
| Token endpoint | `.../tns3j43iqkkkyn4i6f5o7ovpuy0jqhlq.../token` |
| Auth endpoint | `.../hloy65ewpdrktmoe5lsd2bzely0ikopb.../start` |
| Dead code shipped | `dist/auth-server.js` — nothing imports it |

Current user experience is six visible steps: install, prompt window, copy the
start URL, sign in, copy the setup code, paste and save. The setup code expires
in fifteen minutes, so an interrupted install fails and restarts.

Target is two: install, sign in.

## Target flow

```
User:   "show me my balance sheet"
        server finds no credential, raises NotConnectedError
Claude: calls connect_quickbooks
        server -> Lambda /authorize -> returns Intuit consent URL
Claude: "Open this link and sign in: https://appcenter.intuit.com/..."
User:   signs in, approves
        Intuit -> Lambda /callback -> stores tokens, mints device credential
Browser:"You can close this tab"
User:   "done"
Claude: calls finish_quickbooks_connection
        server -> Lambda /poll -> receives credential, writes it locally
Claude: "Connected. Here's your balance sheet..."
```

Nothing is displayed to copy. Nothing is pasted. No settings window, no
restart. Re-authorization later follows the same path, triggered by the 401
from a revoked credential.

## Files to add

Five in the MCP server, one in the Lambda.

| File | Destination | Status |
|---|---|---|
| `broker-auth.ts` | `src/clients/` | new |
| `connect-quickbooks.tool.ts` | `src/tools/` | new |
| `connect-quickbooks.handler.ts` | `src/handlers/` | new |
| `finish-quickbooks-connection.tool.ts` | `src/tools/` | new |
| `finish-quickbooks-connection.handler.ts` | `src/handlers/` | new |
| `device_flow.py` | Lambda | merge, see below |

The tool/handler split mirrors the convention used by all 141 existing tools:
a tool file declaring name, description and Zod schema, and a handler file
holding the logic.

### Extract the broker logic

Broker calls currently live inside `quickbooks-client.ts`. Move them into
`broker-auth.ts` and have the client delegate:

```ts
import { getBrokerAuth } from "./broker-auth.js";

static async getInstance(): Promise<QuickBooks> {
  const { accessToken, realmId, isSandbox } = await getBrokerAuth();
  return new QuickBooks(
    "", "",          // client id/secret unused: no in-process refresh
    accessToken,
    false,           // no token secret under OAuth 2.0
    realmId,
    isSandbox,
    false, null, "2.0",
    undefined        // no refresh token on this machine
  );
}

static async getAuthCredentials() {
  return getBrokerAuth();
}
```

Both accessors are what all 141 handlers call, so no handler changes are
required.

### Register the two tools

In `src/index.ts`, alongside the existing registrations:

```ts
import { ConnectQuickbooksTool } from "./tools/connect-quickbooks.tool.js";
import { FinishQuickbooksConnectionTool }
  from "./tools/finish-quickbooks-connection.tool.js";

RegisterTool(server, ConnectQuickbooksTool);
RegisterTool(server, FinishQuickbooksConnectionTool);
```

Both names are READ category by prefix, so `QUICKBOOKS_DISABLE_WRITE`,
`_UPDATE` and `_DELETE` will not suppress them. This matters: a read-only
deployment must still be able to authorize.

### Credential storage

`broker-auth.ts` resolves in this order:

1. `~/.finos/qbo-credential.json`, written by the connect tool
2. `FINOS_CREDENTIAL` from the environment

File first, so authorizing through chat overrides an installed value without
touching extension settings and without a restart. The directory is created
`0700` and the file written `0600`.

A child process cannot write to the OS keychain that manages `user_config`, so
a file the server owns is the only writable option. It also survives extension
updates, since the extension directory is replaced but the home directory is
not.

## Lambda changes

Keep both existing functions. Merging them would change the redirect URI and
require re-registration with Intuit, which is avoidable.

| Route | Function | Change |
|---|---|---|
| `/authorize` | token Lambda | add |
| `/poll` | token Lambda | add |
| `/token` | token Lambda | keep as-is |
| `/callback` | auth Lambda | modify |
| `/enroll` | token Lambda | remove, superseded by `/poll` |
| `/start` | auth Lambda | remove, superseded by `/authorize` |

The two functions coordinate through Parameter Store, which they already share.

`device_flow.py` contains `/authorize`, `/callback` and `/poll`. Split it
across the two functions along the lines above, and carry the existing `/token`
route across unchanged.

`/callback` changes from rendering a setup code to writing the device
credential into the pending record and showing a plain confirmation page.

### New parameter paths

```
/finos/qbo/states/<sha256(state)>     {poll_hash, expires_at}
/finos/qbo/pending/<sha256(poll)>     {status, device_credential?, realm_id?, expires_at}
```

Both short-lived. `codes/` is no longer written and existing entries can be
deleted.

### Write ordering

In `/callback`, write `refresh_token` before `access_token`. Parameter Store
has no multi-parameter transaction, so a failure between the two leaves a mixed
state. Refresh-first leaves a live refresh token with a stale access token,
which self-heals on next use. The reverse order persists a dead refresh token
and locks the tenant out permanently.

### Credential transport on `/token`

The device credential moves from a custom header to a query parameter, per
review feedback.

Before:

```js
fetch(`${BROKER_URL}/token`, {
  method: 'POST',
  headers: { 'X-Finos-Credential': BROKER_CREDENTIAL },
});
```

After:

```js
const url = new URL(`${BROKER_URL}/token`);
url.searchParams.set('credential', BROKER_CREDENTIAL);
fetch(url, { method: 'GET' });
```

Lambda side:

```python
credential = (event.get("queryStringParameters") or {}).get("credential")
```

`/authorize` and `/poll` continue to take JSON request bodies; only `/token`
changes.

Two operational notes follow from this and should be observed:

**Never log the raw event object in the `/token` handler.** Lambda Function
URLs do not log request paths by default, so nothing is exposed as configured
today. A single `print(event)` added during troubleshooting would place the
credential in CloudWatch in plaintext, and log retention outlives credential
rotation. The same applies to any CloudFront distribution or load balancer
placed in front later, both of which log full request paths as standard.

**`/token` is no longer idempotent under retry.** The route can trigger a
refresh-token rotation against Intuit, which is a state change, and HTTP
clients and proxies treat GET as safe to retry. Reserved concurrency of 1 on
the token function remains the guard against concurrent rotation and should not
be removed.

### Cleanup

Parameter Store has no TTL. `device_flow.py` includes `sweep_expired()`, which
removes expired `states/` and `pending/` entries. Call it opportunistically
from `/token` — roughly one invocation in twenty — rather than adding a
scheduled trigger.

## Manifest changes

Remove `user_config` and the `FINOS_CREDENTIAL` mapping. Install becomes a
single click with no prompt window.

```json
{
  "manifest_version": "0.1",
  "name": "custom-quickbooks",
  "display_name": "QuickBooks (FinOS)",
  "version": "1.1.0",
  "description": "QuickBooks Online tools for the FinOS accounting workflows",
  "author": { "name": "Digital Alpha" },
  "server": {
    "type": "node",
    "entry_point": "dist/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/dist/index.js"],
      "env": {
        "FINOS_BROKER_URL": "https://tns3j43iqkkkyn4i6f5o7ovpuy0jqhlq.lambda-url.us-east-1.on.aws",
        "QUICKBOOKS_DISABLE_DELETE": "true"
      }
    }
  },
  "compatibility": { "platforms": ["darwin", "win32", "linux"] }
}
```

`FINOS_AUTH_URL` is no longer needed — the URL now comes from `/authorize` at
runtime rather than being hardcoded for the user to visit.

Version must increase on every upload; the org registry rejects a repeat. 1.0.0
is already spent.

## Build and ship

```bash
npm run build
npm prune --production
npx @anthropic-ai/mcpb validate .
npx @anthropic-ai/mcpb pack

# must return nothing
unzip -l custom-quickbooks.mcpb | grep -iE "\.env|client_secret"
```

Add `dist/auth-server.js` to `.mcpbignore`, or delete the source file. It is
shipped but unreferenced, and it contains the old interactive OAuth flow that
should not exist in a distributed bundle.

Upload via Organization settings → Connectors → Desktop, then "..." →
Add to team. Propagation takes up to two hours.

## Testing order

Isolate the Lambda before rebuilding the extension.

1. `curl -X POST <token-url>/authorize` — expect `auth_url` and `poll_token`
2. Open `auth_url` in a browser, complete the Intuit flow, confirm the
   confirmation page shows no code
3. `curl -X POST <token-url>/poll -d '{"poll_token":"..."}'` — expect
   `status: complete` with a device credential
4. Repeat step 3 — expect `expired`, confirming single use
5. `curl "<token-url>/token?credential=..."` — expect an access token
   (note: shell history will retain the credential; clear it afterwards)
6. Only now rebuild and install the extension locally
7. Delete `~/.finos/qbo-credential.json`, ask a QuickBooks question, confirm
   Claude offers the link
8. Complete the flow, confirm the credential file appears with `0600`
   permissions and that no restart is needed

Step 4 is the one most likely to reveal a bug, because it depends on the
delete-before-return ordering in `/poll`.

## Rollback

The change is additive. If the flow misbehaves after rollout, restore
`user_config` in the manifest, bump to 1.1.1, and re-upload. The file-first
credential resolution means an installed `FINOS_CREDENTIAL` still works, so the
old path remains functional throughout.

---

# Why Claude cannot supply the code

Two independent reasons. They are frequently conflated, and both need
addressing separately.

## Reason 1: there is no channel for it

A bundled extension is a child process. Claude Desktop launches
`node dist/index.js` and communicates over standard input and output.

Three consequences follow, none of which are matters of effort:

**Pipes carry no headers.** A credential travels in an `Authorization` header.
There is no request, therefore no header, therefore nowhere for a token to sit.

**Environment variables are fixed at process launch.** A child process cannot
ask its parent to change its environment, and cannot write to the OS keychain
that Claude Desktop manages. Whatever the process starts with is what it has.

**The packaging format has no hook.** MCPB defines no OAuth field, no token
field, and no post-install callback. `user_config` — the prompt shown at
install — is the only channel through which a secret can enter, and it is
one-directional and one-time.

There is also no Connect button for a bundled extension. That control belongs
to remote connectors. Install is: click install, answer any `user_config`
prompt, process spawns. No point in that sequence exists at which Claude could
hand over a value.

## Reason 2: a client-chosen code is a security hole

This reason is independent of transport and would apply even after hosting.

If the client generates the identifier and places it in the authorization URL,
then the value in the URL *is* the redeemable credential:

1. An attacker generates code `X`
2. Sends a colleague a link containing `X`, indistinguishable from a normal
   setup link
3. The colleague signs into their real QuickBooks company and approves
4. `X` is now bound to that company
5. The attacker redeems `X` and holds access to those books

This is session fixation, and preventing it is precisely why OAuth defines the
`state` parameter as something the client must not be able to choose or predict.

The fix costs one network round trip: the Lambda generates the identifier
instead. User experience is unchanged.

---

# How the Intuit native connector works

Intuit's connector is a **remote** MCP server at
`https://ai-inc.quickbooks.intuit.com/v1/mcp`. Claude reaches it by HTTPS
request rather than by spawning a process, which changes what is possible.

## The flow

1. **Discovery.** Claude calls the MCP endpoint without credentials. The server
   returns `401` with a `WWW-Authenticate` header pointing at
   `/.well-known/oauth-protected-resource`.
2. **Metadata.** That document names the authorization server. Claude then
   fetches the server's `/.well-known/oauth-authorization-server` for the
   `/authorize` and `/token` endpoints.
3. **Client identity.** Claude identifies itself by pre-registration, a Client
   ID Metadata Document, or Dynamic Client Registration.
4. **PKCE.** Claude generates a random `code_verifier` and sends only its
   SHA-256 hash, the `code_challenge`, in the authorization URL.
5. **Consent.** The browser opens Intuit's consent screen. The user signs in
   and selects a company.
6. **Redirect.** Intuit redirects to Claude's pre-registered redirect URI with
   an authorization code. This is machine-to-machine; nothing is displayed.
7. **Exchange.** Claude posts the code together with the `code_verifier`.
   Intuit verifies that the hash matches and issues tokens.
8. **Use.** Every subsequent MCP request carries
   `Authorization: Bearer <token>`. Claude refreshes on expiry.

## Why this is not vulnerable to the attack above

| | Client-generated code | OAuth 2.1 with PKCE |
|---|---|---|
| Value in the URL | the redeemable secret | a one-way hash of a secret |
| Holding it permits redemption | yes | no; the pre-image is required |
| Where the credential arrives | wherever the code is redeemed | a pre-registered redirect URI |

Two protections stack. Nothing redeemable travels in the clickable URL, and the
authorization code is delivered to a registered endpoint rather than shown to a
person. An attacker who crafts a link never receives the code.

## Why this cannot be replicated locally

PKCE protects a redirect back to a client's registered URI. A stdio child
process has no URI to register and cannot receive a redirect. The protection
is unavailable, not merely unimplemented.

This is why the seamless connect is a property of remote MCP servers rather
than a connector setting. Reproducing it requires moving the server behind an
HTTPS endpoint — the same migration already scoped for the platform work.

## Verifying this directly

```bash
curl -i https://ai-inc.quickbooks.intuit.com/v1/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s https://ai-inc.quickbooks.intuit.com/.well-known/oauth-protected-resource
```

The first should return `401` with a `WWW-Authenticate` header. The second
returns the metadata document naming Intuit's authorization server. Following
that server's own metadata endpoint gives the full endpoint list and the
supported challenge methods — which is also a useful reference for what a
hosted server would need to publish.
