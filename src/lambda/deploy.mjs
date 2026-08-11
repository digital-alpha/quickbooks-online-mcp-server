#!/usr/bin/env node
/**
 * Provision the FinOS QuickBooks token broker with the AWS SDK v3.
 *
 * Idempotent: re-run after editing a handler and it updates code in place.
 *
 *   node deploy.mjs          create or update everything
 *   node deploy.mjs --urls   print the endpoint URLs and exit
 *
 * Run once first, with values from your Intuit app's Keys & credentials page.
 * Seed the sandbox pair before ever deploying dual-environment code — the
 * existing tenants default to "sandbox" and will fail to mint tokens if this
 * path is missing:
 *
 *   aws ssm put-parameter --region us-east-1 \
 *     --name /finos/qbo/sandbox/client_id --type SecureString --value '...'
 *   aws ssm put-parameter --region us-east-1 \
 *     --name /finos/qbo/sandbox/client_secret --type SecureString --value '...'
 *
 * Seed the production pair once Intuit issues production credentials —
 * until then, connecting a company with environment "production" fails
 * loudly rather than silently using sandbox:
 *
 *   aws ssm put-parameter --region us-east-1 \
 *     --name /finos/qbo/production/client_id --type SecureString --value '...'
 *   aws ssm put-parameter --region us-east-1 \
 *     --name /finos/qbo/production/client_secret --type SecureString --value '...'
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  LambdaClient,
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  AddPermissionCommand,
} from "@aws-sdk/client-lambda";
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const REGION = "us-east-1";
// TABLE_NAME removed — Phase 2 uses SSM Parameter Store exclusively.
const SSM_PREFIX = "/finos/qbo";
const ROLE_NAME = "finos-qbo-broker-role";
// Python 3.12 is the latest stable runtime on AWS Lambda.
// The handler string "index.handler" means: file `index.py`, function `handler`.
const RUNTIME = "python3.12";

const FUNCTIONS = {
  "finos-qbo-auth": { file: "auth_lambda.py", timeout: 15 },
  "finos-qbo-token": { file: "token_lambda.py", timeout: 15 },
};

const cfg = { region: REGION };
const lambda = new LambdaClient(cfg);
const iam = new IAMClient(cfg);
// DynamoDBClient removed — Phase 2 uses SSM Parameter Store exclusively.
const sts = new STSClient(cfg);

const log = (msg) => console.log(`  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ zip

function crc32(buf) {
  if (!crc32.table) {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    crc32.table = t;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Build a single-entry ZIP with the STORE method.
 *
 * Node has no built-in zip writer and the handlers need no dependencies, so
 * hand-rolling the ~60 bytes of headers is cheaper than pulling in archiver.
 */
function makeZip(entryName, content) {
  const name = Buffer.from(entryName, "utf8");
  const data = Buffer.from(content, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // method 0 = stored
  local.writeUInt16LE(0x21, 12); // any valid DOS date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10); // method 0 = stored
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  // Multiply rather than shift: `0o100644 << 16` overflows JS's signed
  // 32-bit shift and comes out negative, which writeUInt32LE rejects.
  central.writeUInt32LE(0o100644 * 0x10000, 38); // unix perms
  central.writeUInt32LE(0, 42); // local header offset

  const localPart = Buffer.concat([local, name, data]);
  const centralPart = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

// The zip entry must be named "index.py" so that the Python runtime can
// locate the module matching the "index.handler" handler string.
const packageHandler = (file) =>
  makeZip("index.py", readFileSync(new URL(file, import.meta.url), "utf8"));

// ------------------------------------------------------------------ DynamoDB

// ensureTable() removed — Phase 2 uses SSM Parameter Store exclusively.
// No DynamoDB table is required.

// ------------------------------------------------------------------ IAM

async function ensureRole(accountId) {
  let created = false;
  let arn;

  try {
    const res = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    arn = res.Role.Arn;
    log(`role ${ROLE_NAME} exists`);
  } catch (err) {
    if (err.name !== "NoSuchEntity" && err.name !== "NoSuchEntityException") throw err;
    log(`creating role ${ROLE_NAME}`);
    const res = await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        Description: "FinOS QuickBooks token broker execution role",
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      })
    );
    arn = res.Role.Arn;
    created = true;
  }

  await iam.send(
    new AttachRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    })
  );

  // Least privilege: SSM Parameter Store for all tenant data.
  // DynamoDB is no longer used in Phase 2.
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: "finos-qbo-broker-data",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ssm:GetParameter",
              "ssm:GetParameters",
              "ssm:GetParametersByPath",
              "ssm:PutParameter",
              "ssm:DeleteParameter",
              "ssm:DeleteParameters",
            ],
            Resource: `arn:aws:ssm:${REGION}:${accountId}:parameter${SSM_PREFIX}/*`,
          },
        ],
      }),
    })
  );
  log("inline data policy attached");

  if (created) {
    // IAM is eventually consistent; Lambda rejects a role it cannot see yet.
    log("waiting 10s for IAM propagation");
    await sleep(10_000);
  }

  return arn;
}

// ------------------------------------------------------------------ Lambda

async function waitUpdated(name) {
  for (let i = 0; i < 30; i++) {
    const res = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    const state = res.Configuration.State;
    const lastUpdateStatus = res.Configuration.LastUpdateStatus;
    if ((state === "Active" || !state) && lastUpdateStatus !== "InProgress") return;
    await sleep(1000);
  }
}

async function ensureFunction(name, spec, roleArn, env) {
  const zip = packageHandler(spec.file);

  let exists = true;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: name }));
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    exists = false;
  }

  if (exists) {
    log(`updating ${name}`);
    await lambda.send(
      new UpdateFunctionCodeCommand({ FunctionName: name, ZipFile: zip })
    );
    await waitUpdated(name);
    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: name,
        Runtime: RUNTIME,
        Handler: "index.handler",
        Role: roleArn,
        Timeout: spec.timeout,
        Environment: { Variables: env },
      })
    );
  } else {
    log(`creating ${name}`);
    let ok = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await lambda.send(
          new CreateFunctionCommand({
            FunctionName: name,
            Runtime: RUNTIME,
            Role: roleArn,
            Handler: "index.handler",
            Code: { ZipFile: zip },
            Timeout: spec.timeout,
            MemorySize: 256,
            Environment: { Variables: env },
          })
        );
        ok = true;
        break;
      } catch (err) {
        if (err.name === "InvalidParameterValueException") {
          log(`role not ready, retrying (${attempt + 1}/6)`);
          await sleep(5000);
          continue;
        }
        throw err;
      }
    }
    if (!ok) throw new Error(`could not create ${name}`);
  }

  await waitUpdated(name);
}

/**
 * Create a public Function URL.
 *
 * Two separate things are required and the second is easy to miss: the URL
 * config, plus a resource-based policy permitting anonymous invoke. The console
 * adds that policy silently; the API does not, and without it every request
 * returns 403.
 */
async function ensureFunctionUrl(name) {
  let url;
  try {
    const res = await lambda.send(
      new GetFunctionUrlConfigCommand({ FunctionName: name })
    );
    url = res.FunctionUrl;
    log(`${name} url exists`);
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    const res = await lambda.send(
      new CreateFunctionUrlConfigCommand({ FunctionName: name, AuthType: "NONE" })
    );
    url = res.FunctionUrl;
    log(`${name} url created`);
  }

  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: name,
        StatementId: "AllowPublicFunctionUrl",
        Action: "lambda:InvokeFunctionUrl",
        Principal: "*",
        FunctionUrlAuthType: "NONE",
      })
    );
    log(`${name} public url invoke permission added`);
  } catch (err) {
    if (err.name !== "ResourceConflictException") throw err;
  }

  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: name,
        StatementId: "AllowPublicInvoke",
        Action: "lambda:InvokeFunction",
        Principal: "*",
      })
    );
    log(`${name} public function invoke permission added`);
  } catch (err) {
    if (err.name !== "ResourceConflictException") throw err;
  }

  return url.replace(/\/+$/, "");
}

// ------------------------------------------------------------------ main

function printUrls(authUrl, tokenUrl) {
  console.log("\n" + "=".repeat(68));
  console.log("Register this as the Redirect URI in the Intuit portal:");
  console.log(`  ${authUrl}/callback`);
  console.log("\nSend teammates here to connect:");
  console.log(`  ${authUrl}/start`);
  console.log("\nBroker base URL for the MCP server (FINOS_BROKER_URL):");
  console.log(`  ${tokenUrl}`);
  console.log("=".repeat(68) + "\n");
}

async function main() {
  if (process.argv.includes("--urls")) {
    const a = await lambda.send(
      new GetFunctionUrlConfigCommand({ FunctionName: "finos-qbo-auth" })
    );
    const t = await lambda.send(
      new GetFunctionUrlConfigCommand({ FunctionName: "finos-qbo-token" })
    );
    printUrls(
      a.FunctionUrl.replace(/\/+$/, ""),
      t.FunctionUrl.replace(/\/+$/, "")
    );
    return;
  }

  const { Account } = await sts.send(new GetCallerIdentityCommand({}));
  console.log(`\nDeploying to ${REGION} (account ${Account})\n`);

  // DynamoDB table no longer needed — Phase 2 uses SSM Parameter Store.
  const roleArn = await ensureRole(Account);

  const baseEnv = {
    SSM_PREFIX,
  };

  // REDIRECT_URI is chicken-and-egg: it must be the auth function's own URL,
  // which exists only after the function does. Create with a placeholder, then
  // patch in the real value.
  await ensureFunction("finos-qbo-auth", FUNCTIONS["finos-qbo-auth"], roleArn, {
    ...baseEnv,
    REDIRECT_URI: "pending",
  });
  const authUrl = await ensureFunctionUrl("finos-qbo-auth");

  await lambda.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: "finos-qbo-auth",
      Environment: {
        Variables: {
          ...baseEnv,
          REDIRECT_URI: `${authUrl}/callback`,
        },
      },
    })
  );
  await waitUpdated("finos-qbo-auth");
  log(`REDIRECT_URI set to ${authUrl}/callback`);

  await ensureFunction(
    "finos-qbo-token",
    FUNCTIONS["finos-qbo-token"],
    roleArn,
    { ...baseEnv, REDIRECT_URI: `${authUrl}/callback` }
  );
  const tokenUrl = await ensureFunctionUrl("finos-qbo-token");

  printUrls(authUrl, tokenUrl);
}

main().catch((err) => {
  console.error(`\nAWS error: ${err.name}: ${err.message}`);
  process.exit(1);
});
