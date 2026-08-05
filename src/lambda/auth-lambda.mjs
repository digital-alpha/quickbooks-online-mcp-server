/**
 * Lambda A: finos-qbo-auth (Phase 2: Parameter Store Multi-Tenant)
 *
 *   GET /start     redirect the user to Intuit's consent screen
 *   GET /callback  exchange auth code, store tokens in Parameter Store,
 *                  generate a 15-minute Setup Code for the user
 *
 * All tenant data is stored in AWS SSM Parameter Store:
 *   /finos/qbo/client_id              — Intuit app client ID
 *   /finos/qbo/client_secret          — Intuit app client secret
 *   /finos/qbo/states/<state>         — CSRF state token (temporary, 10 min)
 *   /finos/qbo/tenants/<realmId>/*    — refresh_token, access_token, metadata
 *   /finos/qbo/codes/<hash>           — setup code → tenant mapping (15 min)
 */

import { createHash, randomBytes } from "node:crypto";
import {
  SSMClient,
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from "@aws-sdk/client-ssm";

const SSM_PREFIX = process.env.SSM_PREFIX ?? "/finos/qbo";
const REDIRECT_URI = process.env.REDIRECT_URI;

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

const SETUP_CODE_TTL_SECONDS = 900; // 15 minutes

const ssm = new SSMClient({});
let paramCache = null;

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

// ── App Credentials ──────────────────────────────────────────────────────────

async function getAppCredentials() {
  // 1. Prefer environment variables if available
  const envClientId = process.env.CLIENT_ID || process.env.QUICKBOOKS_CLIENT_ID;
  const envClientSecret = process.env.CLIENT_SECRET || process.env.QUICKBOOKS_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    return { client_id: envClientId, client_secret: envClientSecret };
  }

  // 2. Fallback to SSM Parameter Store
  if (paramCache) return paramCache;
  const res = await ssm.send(
    new GetParametersCommand({
      Names: [`${SSM_PREFIX}/client_id`, `${SSM_PREFIX}/client_secret`],
      WithDecryption: true,
    })
  );

  const found = {};
  for (const p of res.Parameters ?? []) {
    found[p.Name.split("/").pop()] = p.Value;
  }
  if (!found.client_id || !found.client_secret) {
    throw new Error("Missing client_id / client_secret in env vars or SSM");
  }
  paramCache = found;
  return paramCache;
}

// ── SSM Helpers ──────────────────────────────────────────────────────────────

async function ssmPut(name, value, type = "SecureString") {
  await ssm.send(
    new PutParameterCommand({ Name: name, Value: value, Type: type, Overwrite: true })
  );
}

async function ssmGet(name) {
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true })
    );
    return res.Parameter?.Value ?? null;
  } catch (err) {
    if (err.name === "ParameterNotFound") return null;
    throw err;
  }
}

async function ssmDelete(name) {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: name }));
    return true;
  } catch (err) {
    if (err.name === "ParameterNotFound") return false;
    throw err;
  }
}

// ── HTML Page Helper ─────────────────────────────────────────────────────────

function page(title, bodyHtml, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body:
      `<!doctype html><meta charset=utf-8>` +
      `<meta name=viewport content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title><style>` +
      `body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;` +
      `padding:0 1.5rem;line-height:1.6;color:#1a1a1a}` +
      `code{display:block;background:#f4f4f2;padding:1rem;border-radius:8px;` +
      `font-size:1.1rem;word-break:break-all;margin:1rem 0;text-align:center}` +
      `small{color:#666}</style>` +
      `<h2>${escapeHtml(title)}</h2>${bodyHtml}`,
  };
}

// ── Intuit Token Exchange ────────────────────────────────────────────────────

async function postForm(url, form, clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = new Error("intuit_rejected");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ── Route Handlers ───────────────────────────────────────────────────────────

async function handleStart() {
  const { client_id } = await getAppCredentials();
  const state = randomBytes(24).toString("base64url");

  // Store CSRF state in Parameter Store with an expiry timestamp
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes
  await ssmPut(
    `${SSM_PREFIX}/states/${state}`,
    JSON.stringify({ expires_at: expiresAt }),
    "String"
  );

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", client_id);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);

  return { statusCode: 302, headers: { Location: url.toString() }, body: "" };
}

async function handleCallback(event) {
  const qs = event.queryStringParameters ?? {};
  const { code, state, realmId, error } = qs;

  if (error) {
    return page("Authorization declined", "<p>You can close this tab.</p>", 400);
  }
  if (!code || !state || !realmId) {
    return page("Invalid request", "<p>Missing parameters.</p>", 400);
  }

  // Verify and consume the CSRF state token (single-use)
  const stateKey = `${SSM_PREFIX}/states/${state}`;
  const stateVal = await ssmGet(stateKey);
  if (!stateVal) {
    return page(
      "Link expired",
      "<p>This authorization link was already used or has expired. Please start again.</p>",
      400
    );
  }
  // Check expiry
  try {
    const parsed = JSON.parse(stateVal);
    if (parsed.expires_at < Math.floor(Date.now() / 1000)) {
      await ssmDelete(stateKey);
      return page("Link expired", "<p>This authorization link has expired. Please start again.</p>", 400);
    }
  } catch { /* non-JSON state — accept it */ }
  // Delete state to make it single-use
  await ssmDelete(stateKey);

  // Exchange authorization code for tokens with Intuit
  const { client_id, client_secret } = await getAppCredentials();
  const tokens = await postForm(
    TOKEN_URL,
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI },
    client_id,
    client_secret
  );

  // Store tenant tokens in Parameter Store under /finos/qbo/tenants/<realmId>/
  const tenantPrefix = `${SSM_PREFIX}/tenants/${realmId}`;
  const now = Math.floor(Date.now() / 1000);
  await Promise.all([
    ssmPut(`${tenantPrefix}/refresh_token`, tokens.refresh_token),
    ssmPut(`${tenantPrefix}/access_token`, tokens.access_token),
    ssmPut(
      `${tenantPrefix}/metadata`,
      JSON.stringify({
        realm_id: realmId,
        access_expires: now + Number(tokens.expires_in ?? 3600),
        updated_at: now,
      }),
      "String"
    ),
  ]);

  // Generate a 15-minute single-use Setup Code
  const setupCode = randomBytes(24).toString("base64url");
  const codeHash = sha256(setupCode);
  await ssmPut(
    `${SSM_PREFIX}/codes/${codeHash}`,
    JSON.stringify({
      tenant_id: realmId,
      expires_at: now + SETUP_CODE_TTL_SECONDS,
    }),
    "String"
  );

  console.log(JSON.stringify({ event: "enrolled", realm_id: realmId }));

  return page(
    "Connected to QuickBooks",
    "<p>Paste this setup code into the QuickBooks extension in Claude:</p>" +
      `<code>${escapeHtml(setupCode)}</code>` +
      "<p><small>Valid for 15 minutes and usable once. " +
      "If it expires, reopen the setup link.</small></p>"
  );
}

// ── Lambda Entry Point ───────────────────────────────────────────────────────

export const handler = async (event) => {
  const path = (event.requestContext?.http?.path ?? "/").replace(/\/+$/, "");

  try {
    if (path.endsWith("/start")) return await handleStart();
    if (path.endsWith("/callback") || path === "") return await handleCallback(event);
    return page("Not found", "<p>Unknown path.</p>", 404);
  } catch (err) {
    if (err.message === "intuit_rejected") {
      console.log(JSON.stringify({ event: "intuit_error", status: err.status }));
      return page("QuickBooks rejected the request", "<p>Please try again.</p>", 502);
    }
    console.log(JSON.stringify({ event: "error", name: err.name, message: err.message }));
    return page("Something went wrong", "<p>Please try again.</p>", 500);
  }
};
