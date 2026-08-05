#!/usr/bin/env node
/**
 * Tear down the FinOS QuickBooks token broker from AWS.
 *
 *   node destroy.mjs          Delete both Lambda functions, their URLs,
 *                             and the execution IAM role.
 *
 *   node destroy.mjs --purge  Also wipe all SSM parameters under /finos/qbo/
 *                             WARNING: this revokes every enrolled tenant and
 *                             every issued device credential — use with care.
 *
 * This script is idempotent: re-running after a partial teardown is safe.
 */

import {
  LambdaClient,
  DeleteFunctionCommand,
  GetFunctionUrlConfigCommand,
  DeleteFunctionUrlConfigCommand,
} from "@aws-sdk/client-lambda";
import {
  IAMClient,
  DetachRolePolicyCommand,
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import {
  SSMClient,
  GetParametersByPathCommand,
  DeleteParametersCommand,
} from "@aws-sdk/client-ssm";

const REGION = "us-east-1";
const ROLE_NAME = "finos-qbo-broker-role";
const SSM_PREFIX = "/finos/qbo";
const FUNCTION_NAMES = ["finos-qbo-auth", "finos-qbo-token"];

const cfg = { region: REGION };
const lambda = new LambdaClient(cfg);
const iam = new IAMClient(cfg);
const ssm = new SSMClient(cfg);

const log = (msg) => console.log(`  ${msg}`);
const warn = (msg) => console.warn(`  [WARN] ${msg}`);

// ------------------------------------------------------------------ Lambda

async function deleteFunctionUrl(name) {
  try {
    await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: name }));
    await lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: name }));
    log(`${name} function URL deleted`);
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    log(`${name} function URL not found (skipping)`);
  }
}

async function deleteFunction(name) {
  try {
    // Function URLs must be deleted before the function itself
    await deleteFunctionUrl(name);
    await lambda.send(new DeleteFunctionCommand({ FunctionName: name }));
    log(`${name} Lambda deleted`);
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    log(`${name} Lambda not found (skipping)`);
  }
}

// ------------------------------------------------------------------ IAM

async function deleteRole() {
  try {
    await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  } catch (err) {
    if (err.name === "NoSuchEntity" || err.name === "NoSuchEntityException") {
      log(`role ${ROLE_NAME} not found (skipping)`);
      return;
    }
    throw err;
  }

  // Detach all managed (AWS-managed) policies before deleting the role
  const attached = await iam.send(
    new ListAttachedRolePoliciesCommand({ RoleName: ROLE_NAME })
  );
  for (const policy of attached.AttachedPolicies ?? []) {
    await iam.send(
      new DetachRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyArn: policy.PolicyArn,
      })
    );
    log(`detached managed policy: ${policy.PolicyName}`);
  }

  // Delete all inline policies before deleting the role
  const inline = await iam.send(
    new ListRolePoliciesCommand({ RoleName: ROLE_NAME })
  );
  for (const policyName of inline.PolicyNames ?? []) {
    await iam.send(
      new DeleteRolePolicyCommand({ RoleName: ROLE_NAME, PolicyName: policyName })
    );
    log(`deleted inline policy: ${policyName}`);
  }

  await iam.send(new DeleteRoleCommand({ RoleName: ROLE_NAME }));
  log(`role ${ROLE_NAME} deleted`);
}

// ------------------------------------------------------------------ SSM

async function purgeSsmParameters() {
  warn(`Purging ALL SSM parameters under ${SSM_PREFIX}`);
  warn("This revokes every enrolled tenant and every device credential!");

  let nextToken;
  let total = 0;

  do {
    const resp = await ssm.send(
      new GetParametersByPathCommand({
        Path: SSM_PREFIX,
        Recursive: true,
        WithDecryption: false, // we only need the names, not values
        ...(nextToken ? { NextToken: nextToken } : {}),
      })
    );

    const names = (resp.Parameters ?? []).map((p) => p.Name);
    if (names.length > 0) {
      // DeleteParameters accepts at most 10 names per call
      for (let i = 0; i < names.length; i += 10) {
        const batch = names.slice(i, i + 10);
        await ssm.send(new DeleteParametersCommand({ Names: batch }));
        total += batch.length;
      }
    }

    nextToken = resp.NextToken;
  } while (nextToken);

  log(`deleted ${total} SSM parameter(s)`);
}

// ------------------------------------------------------------------ main

async function main() {
  const purge = process.argv.includes("--purge");

  console.log(`\nTearing down FinOS QBO broker in ${REGION}\n`);

  for (const name of FUNCTION_NAMES) {
    await deleteFunction(name);
  }

  await deleteRole();

  if (purge) {
    await purgeSsmParameters();
  } else {
    log(
      "SSM parameters preserved (tenant data + credentials still in place)."
    );
    log("Run with --purge to delete all tenant data and revoke all credentials.");
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(`\nAWS error: ${err.name}: ${err.message}`);
  process.exit(1);
});
