/**
 * Lambda B: finos-qbo-token (Phase 2: Parameter Store Multi-Tenant)
 *
 *   POST /enroll  {"setup_code": "..."}      one-time swap for a device credential
 *   POST /token   header X-Finos-Credential  short-lived QBO access token
 *
 * The MCP server only ever holds a device credential. The client secret and
 * the tenant refresh token never leave AWS.
 *
 * All data is stored in AWS SSM Parameter Store:
 *   /finos/qbo/client_id                        — Intuit app client ID
 *   /finos/qbo/client_secret                    — Intuit app client secret
 *   /finos/qbo/codes/<hash>                     — setup code → tenant mapping
 *   /finos/qbo/creds/<hash>                     — device credential → tenant mapping
 *   /finos/qbo/tenants/<realmId>/refresh_token  — long-lived refresh token
 *   /finos/qbo/tenants/<realmId>/access_token   — cached short-lived access token
 *   /finos/qbo/tenants/<realmId>/metadata       — realm_id, access_expires, updated_at
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
const QBO_ENV = process.env.QBO_ENV ?? "sandbox";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// Only the API base differs between environments.
const API_BASE =
  QBO_ENV === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

// Refresh early so in-flight calls never race the expiry.
const EXPIRY_SKEW_SECONDS = 120;

const ssm = new SSMClient({});
let paramCache = null;

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const now = () => Math.floor(Date.now() / 1000);

const json = (payload, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

// ── App Credentials ──────────────────────────────────────────────────────────

async function getAppCredentials() {
  // 1. Prefer environment variables
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

// ── Intuit Token Refresh ─────────────────────────────────────────────────────

async function refreshWithIntuit(refreshToken) {
  const { client_id, client_secret } = await getAppCredentials();
  const basic = Buffer.from(`${client_id}:${client_secret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = new Error("refresh_rejected");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ── Route: POST /enroll ──────────────────────────────────────────────────────

async function handleEnroll(event) {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const setupCode = body.setup_code;
  if (!setupCode) return json({ error: "setup_code_required" }, 400);

  const label = String(body.label ?? "unnamed").slice(0, 64);
  const codeHash = sha256(setupCode);

  // Look up and consume the setup code from Parameter Store
  const codeVal = await ssmGet(`${SSM_PREFIX}/codes/${codeHash}`);
  if (!codeVal) return json({ error: "invalid_or_expired_code" }, 401);

  let codeData;
  try {
    codeData = JSON.parse(codeVal);
  } catch {
    return json({ error: "invalid_or_expired_code" }, 401);
  }

  // Check expiry
  if (codeData.expires_at < now()) {
    await ssmDelete(`${SSM_PREFIX}/codes/${codeHash}`);
    return json({ error: "invalid_or_expired_code" }, 401);
  }

  // Delete the setup code to make it single-use
  await ssmDelete(`${SSM_PREFIX}/codes/${codeHash}`);

  // Generate a device credential and store mapping in Parameter Store
  const deviceCredential = randomBytes(32).toString("base64url");
  const credHash = sha256(deviceCredential);
  await ssmPut(
    `${SSM_PREFIX}/creds/${credHash}`,
    JSON.stringify({
      tenant_id: codeData.tenant_id,
      label,
      created_at: now(),
    }),
    "String"
  );

  console.log(JSON.stringify({ event: "device_enrolled", label }));
  return json({ device_credential: deviceCredential });
}

// ── Route: POST /token ───────────────────────────────────────────────────────

async function mintAccessToken(tenantId) {
  const tenantPrefix = `${SSM_PREFIX}/tenants/${tenantId}`;

  // Fetch tenant metadata and tokens from Parameter Store
  const [metadataVal, refreshTokenVal, accessTokenVal] = await Promise.all([
    ssmGet(`${tenantPrefix}/metadata`),
    ssmGet(`${tenantPrefix}/refresh_token`),
    ssmGet(`${tenantPrefix}/access_token`),
  ]);

  if (!refreshTokenVal || !metadataVal) {
    return { error: "tenant_not_enrolled" };
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataVal);
  } catch {
    return { error: "tenant_not_enrolled" };
  }

  // Return cached access token if still valid
  const expires = Number(metadata.access_expires ?? 0);
  if (expires > now() + EXPIRY_SKEW_SECONDS && accessTokenVal) {
    return {
      payload: {
        access_token: accessTokenVal,
        realm_id: metadata.realm_id,
        api_base: API_BASE,
        expires_at: expires,
      },
    };
  }

  // Refresh the token with Intuit
  let fresh;
  try {
    fresh = await refreshWithIntuit(refreshTokenVal);
  } catch (err) {
    console.log(JSON.stringify({ event: "refresh_failed", status: err.status }));
    return { error: "refresh_rejected" };
  }

  // Update Parameter Store with new tokens
  const newExpires = now() + Number(fresh.expires_in ?? 3600);
  await Promise.all([
    ssmPut(`${tenantPrefix}/refresh_token`, fresh.refresh_token),
    ssmPut(`${tenantPrefix}/access_token`, fresh.access_token),
    ssmPut(
      `${tenantPrefix}/metadata`,
      JSON.stringify({
        realm_id: metadata.realm_id,
        access_expires: newExpires,
        updated_at: now(),
      }),
      "String"
    ),
  ]);

  return {
    payload: {
      access_token: fresh.access_token,
      realm_id: metadata.realm_id,
      api_base: API_BASE,
      expires_at: newExpires,
    },
  };
}

async function handleToken(event) {
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const credential = headers["x-finos-credential"];
  if (!credential) return json({ error: "credential_required" }, 401);

  const credHash = sha256(credential);
  const credVal = await ssmGet(`${SSM_PREFIX}/creds/${credHash}`);
  if (!credVal) return json({ error: "unauthorized" }, 401);

  let credData;
  try {
    credData = JSON.parse(credVal);
  } catch {
    return json({ error: "unauthorized" }, 401);
  }

  const { payload, error } = await mintAccessToken(credData.tenant_id);
  if (error) return json({ error }, error === "refresh_rejected" ? 502 : 409);

  console.log(JSON.stringify({ event: "token_issued", label: credData.label }));
  return json(payload);
}

// ── Lambda Entry Point ───────────────────────────────────────────────────────

export const handler = async (event) => {
  const path = (event.requestContext?.http?.path ?? "/").replace(/\/+$/, "");

  try {
    if (path.endsWith("/enroll")) return await handleEnroll(event);
    if (path.endsWith("/token")) return await handleToken(event);
    return json({ error: "not_found" }, 404);
  } catch (err) {
    console.log(JSON.stringify({ event: "error", name: err.name, message: err.message }));
    return json({ error: "internal" }, 500);
  }
};
