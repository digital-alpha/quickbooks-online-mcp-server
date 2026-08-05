#!/usr/bin/env node
/**
 * Verify the broker end to end after deploying.
 *
 *   # open the /start URL in a browser, approve, copy the setup code
 *   node test-flow.mjs <token-url> <setup-code>
 *
 * Exchanges the setup code for a device credential, fetches an access token,
 * then makes a real CompanyInfo call to prove the whole chain works.
 */

const [, , tokenUrlRaw, setupCode] = process.argv;

if (!tokenUrlRaw || !setupCode) {
  console.log("usage: node test-flow.mjs <token-url> <setup-code>");
  process.exit(1);
}

const tokenUrl = tokenUrlRaw.replace(/\/+$/, "");

async function call(url, { method = "POST", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, data: parsed };
}

const fail = (msg, detail) => {
  console.error(`\n  FAILED: ${msg}`);
  if (detail !== undefined) console.error(`  ${JSON.stringify(detail)}`);
  process.exit(1);
};

console.log("\n1. Exchanging setup code for a device credential");
const enroll = await call(`${tokenUrl}/enroll`, {
  body: { setup_code: setupCode, label: "test-script" },
});
if (!enroll.ok) fail("enrollment rejected", enroll.data);
const credential = enroll.data.device_credential;
console.log(`   got credential (${credential.length} chars)`);

console.log("\n2. Requesting an access token");
const tok = await call(`${tokenUrl}/token`, {
  headers: { "X-Finos-Credential": credential },
});
if (!tok.ok) fail("token request rejected", tok.data);
console.log(`   realm    ${tok.data.realm_id}`);
console.log(`   api base ${tok.data.api_base}`);
console.log(`   expires  ${new Date(tok.data.expires_at * 1000).toISOString()}`);

console.log("\n3. Calling QuickBooks CompanyInfo");
const { api_base, realm_id, access_token } = tok.data;
const company = await call(
  `${api_base}/v3/company/${realm_id}/companyinfo/${realm_id}`,
  {
    method: "GET",
    headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" },
  }
);
if (!company.ok) fail("QuickBooks call rejected", company.data);
const info = company.data.CompanyInfo;
console.log(`   company  ${info.CompanyName}`);
console.log(`   legal    ${info.LegalName}`);

console.log("\n4. Re-requesting a token (should hit the cache, not refresh)");
const again = await call(`${tokenUrl}/token`, {
  headers: { "X-Finos-Credential": credential },
});
console.log(`   cached:  ${again.data.expires_at === tok.data.expires_at}`);

console.log("\n5. Confirming the setup code is single use");
const replay = await call(`${tokenUrl}/enroll`, { body: { setup_code: setupCode } });
if (replay.ok) fail("setup code was accepted twice");
console.log(`   correctly rejected (${replay.status})`);

console.log("\n6. Confirming a bogus credential is rejected");
const bogus = await call(`${tokenUrl}/token`, {
  headers: { "X-Finos-Credential": "not-a-real-credential" },
});
if (bogus.ok) fail("bogus credential was accepted");
console.log(`   correctly rejected (${bogus.status})`);

console.log("\nAll checks passed.");
console.log(`\nDevice credential for the extension:\n  ${credential}\n`);
