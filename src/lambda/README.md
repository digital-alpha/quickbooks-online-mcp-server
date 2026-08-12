# FinOS QuickBooks token broker (Node)

Keeps the QuickBooks client secret and refresh token inside AWS. The Claude
Desktop extension only ever holds a device credential — revocable, and useless
on its own.

## Phase 1: Callback Payload Inspection

In Phase 1, the `/callback` handler in `auth-lambda.mjs` is simplified to allow inspecting the OAuth callback payload from Intuit before wiring up Parameter Store / DynamoDB persistence:

1. **Environment Variables**: Configure your credentials in `.env` (or pass via CLI):
   - `QUICKBOOKS_CLIENT_ID` (or `CLIENT_ID`)
   - `QUICKBOOKS_CLIENT_SECRET` (or `CLIENT_SECRET`)
   - `REDIRECT_URI` (automatically populated upon deployment)

2. **Deploy**:
   ```bash
   node src/lambda/deploy.mjs
   ```
   Copy the printed `{authUrl}/callback` and paste it into the Intuit Developer Portal as your **Redirect URI**.

3. **Inspect Callback**:
   - Open `{authUrl}/start` in your browser.
   - Authorize with your QuickBooks Sandbox account.
   - Intuit redirects to `{authUrl}/callback`.
   - The browser displays both the **query parameters** (`code`, `realmId`, `state`) and the **exchanged OAuth tokens** (`access_token`, `refresh_token`, `expires_in`, `x_refresh_token_expires_in`).
   - You can also view the sample payload schema in [.env.example](file:///home/ayushaman/Documents/Ayush_Code/Code_files/digital_alpha/quickbooks-online-mcp-server/.env.example).

## Layout

| File | Purpose |
|---|---|
| `auth-lambda.mjs` | `GET /start` and `GET /callback` — the OAuth handshake & payload inspection |
| `token-lambda.mjs` | `POST /enroll` and `POST /token` — the broker |
| `deploy.mjs` | AWS SDK v3 provisioning, idempotent |
| `test-flow.mjs` | end-to-end verification |


The handlers import only `@aws-sdk/client-dynamodb` and `@aws-sdk/client-ssm`,
both present in the `nodejs22.x` runtime, so each deploys as a single file with
no `node_modules`. `fetch`, `crypto`, and `URLSearchParams` are all built in.

The SDK packages in `devDependencies` are for `deploy.mjs` running on your
machine, not for the Lambdas.

## Setup

### 1. Install the deploy dependencies

```bash
npm install
```

### 2. Store the app credentials

From your Intuit app's Keys & credentials page, Development section:

```bash
aws ssm put-parameter --region us-east-1 \
  --name /finos/qbo/client_id --type SecureString --value 'YOUR_CLIENT_ID'

aws ssm put-parameter --region us-east-1 \
  --name /finos/qbo/client_secret --type SecureString --value 'YOUR_CLIENT_SECRET'
```

These are the only secrets you handle by hand, and only once.

### 3. Deploy

```bash
npm run deploy
```

Prints three URLs at the end. Re-run any time to push code changes.

### 4. Register the redirect URI

Copy the printed `/callback` URL into the Intuit portal under
Settings → Redirect URIs. It must match byte for byte, including the absence of
a trailing slash.

### 5. Enroll a company

`/start` has been removed — it wrote its CSRF state under a different SSM
key than `/callback` read it back from, so it never actually completed a
sign-in. Call the `connect_quickbooks` tool (with `environment: "sandbox"`
or `"production"`) from the client that uses this connector instead; it
starts the device-authorization flow and returns a sign-in link to open.

### 6. Verify

```bash
node test-flow.mjs <token-url> <setup-code>
```

Walks enrollment, token minting, a real CompanyInfo call, cache behaviour,
single-use enforcement, and rejection of a bogus credential.

## Data model

One table, prefixed keys:

| Key | Contents | Lifetime |
|---|---|---|
| `state#<random>` | CSRF token for the OAuth round trip | 10 min, TTL |
| `tenant#default` | refresh token, realm id, cached access token | permanent |
| `code#<sha256>` | setup code claim, points at a tenant | 15 min, TTL |
| `cred#<sha256>` | device credential, points at a tenant | until revoked |

Setup codes and device credentials are stored hashed, so a table dump is not
directly usable.

## The refresh token race

Intuit invalidates the old refresh token when it issues a new one, so two
concurrent refreshes would persist a dead token and lock the tenant out until
re-enrollment.

`mintAccessToken` guards this with a conditional write on the old refresh token
value. The loser's write throws `ConditionalCheckFailedException`, and it
re-reads to pick up whatever the winner stored. Access tokens are also cached
until two minutes before expiry, so refreshes are rare and the race is mostly
avoided rather than merely survived.

Worth exercising deliberately in sandbox before going near real books.

## Revoking someone

```bash
aws dynamodb scan --region us-east-1 --table-name finos-qbo-broker \
  --filter-expression 'begins_with(pk, :p)' \
  --expression-attribute-values '{":p":{"S":"cred#"}}' \
  --projection-expression 'pk,label,created_at'

aws dynamodb delete-item --region us-east-1 --table-name finos-qbo-broker \
  --key '{"pk":{"S":"cred#<hash>"}}'
```

Their extension stops working on the next token request. No client-side action.

## Going to production

1. Complete Intuit's app assessment questionnaire, get production keys
2. Seed the production credentials in SSM — this is a separate path from
   sandbox, not an overwrite of it:
   ```bash
   aws ssm put-parameter --region us-east-1 \
     --name /finos/qbo/production/client_id --type SecureString --value 'YOUR_PRODUCTION_CLIENT_ID'

   aws ssm put-parameter --region us-east-1 \
     --name /finos/qbo/production/client_secret --type SecureString --value 'YOUR_PRODUCTION_CLIENT_SECRET'
   ```
3. Register the same `/callback` URL under Production Settings
4. Connect the real company by passing `environment: "production"` to
   `connect_quickbooks` (see "Enroll a company" above — `/start` no
   longer exists).

The OAuth endpoint is identical for both environments. Only the API base URL
and credential pair change, resolved per tenant by
`resolve_environment_config()` in both `auth_lambda.py` and `token_lambda.py`.

## Going multi-tenant

Every device credential currently points at `tenant#default`. To let people
connect their own companies, write `tenant#<realm_id>` in the callback and store
that realm on the setup code. `token-lambda.mjs` needs no change — it already
resolves credential → tenant → token.

## Notes

- Both Function URLs are `AuthType: NONE`, so all authorization is
  application-level. The device credential is the only gate on `/token`.
- Handlers log event names and labels only, never tokens. Keep it that way —
  CloudWatch logs are readable by anyone with console access.
- Rate limiting is not implemented. Before production, add a per-credential
  counter plus reserved concurrency on `finos-qbo-token`.
- `deploy.mjs` hand-rolls a single-entry ZIP rather than pulling in `archiver`.
  If you later need to bundle `node_modules`, swap `makeZip` for a real zip
  library — the rest of the script is unaffected.
