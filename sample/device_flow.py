"""
Device-authorization routes for the QuickBooks broker.

Adds three pieces to the existing Lambda:
  POST /authorize  -> mint state + poll token, return the Intuit consent URL
  GET  /callback   -> (modified) fill in the pending record instead of showing a code
  POST /poll       -> hand the device credential over once, then discard it

Both the OAuth state and the poll token are generated here, never by the client.
A client-supplied identifier would allow session fixation: an attacker could
pre-generate a value, get a colleague to complete authorization against it, then
redeem it for access to that colleague's company.

Parameter layout, matching the existing store:
  /finos/qbo/client_id                        SecureString
  /finos/qbo/client_secret                    SecureString
  /finos/qbo/tenants/<realm>/access_token     SecureString
  /finos/qbo/tenants/<realm>/refresh_token    SecureString
  /finos/qbo/tenants/<realm>/metadata         String
  /finos/qbo/creds/<sha256>                   String   {realm_id, created_at}
  /finos/qbo/states/<sha256>                  String   {poll_hash, expires_at}
  /finos/qbo/pending/<sha256>                 String   {status, ...}
"""

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.parse
import urllib.request

import boto3
from botocore.exceptions import ClientError

PREFIX = os.environ.get("SSM_PREFIX", "/finos/qbo")
REDIRECT_URI = os.environ["REDIRECT_URI"]
QBO_ENV = os.environ.get("QBO_ENV", "sandbox")

AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
SCOPE = "com.intuit.quickbooks.accounting"

STATE_TTL = 900
PENDING_TTL = 900

ssm = boto3.client("ssm")
_app_creds = {}


def sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def now():
    return int(time.time())


# ---------------------------------------------------------------- parameters


def put(name, value, secure=False):
    ssm.put_parameter(
        Name=f"{PREFIX}/{name}",
        Value=json.dumps(value) if not isinstance(value, str) else value,
        Type="SecureString" if secure else "String",
        Overwrite=True,  # omitting this raises ParameterAlreadyExists on rotation
    )


def get(name, secure=False):
    try:
        resp = ssm.get_parameter(Name=f"{PREFIX}/{name}", WithDecryption=secure)
        return resp["Parameter"]["Value"]
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ParameterNotFound":
            return None
        raise


def get_json(name):
    raw = get(name)
    return json.loads(raw) if raw else None


def delete(name):
    try:
        ssm.delete_parameter(Name=f"{PREFIX}/{name}")
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ParameterNotFound":
            return False
        raise


def app_credentials():
    if not _app_creds:
        resp = ssm.get_parameters(
            Names=[f"{PREFIX}/client_id", f"{PREFIX}/client_secret"],
            WithDecryption=True,
        )
        for p in resp["Parameters"]:
            _app_creds[p["Name"].rsplit("/", 1)[-1]] = p["Value"]
    return _app_creds["client_id"], _app_creds["client_secret"]


# ---------------------------------------------------------------- helpers


def json_response(payload, status=200):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(payload),
    }


def html_page(title, body, status=200):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "text/html; charset=utf-8"},
        "body": (
            "<!doctype html><meta charset=utf-8>"
            "<meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>{title}</title><style>"
            "body{font-family:system-ui,sans-serif;max-width:32rem;margin:5rem auto;"
            "padding:0 1.5rem;line-height:1.6;text-align:center;color:#1a1a1a}"
            "</style>"
            f"<h2>{title}</h2><p>{body}</p>"
        ),
    }


def exchange_code(code):
    client_id, client_secret = app_credentials()
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    body = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


# ---------------------------------------------------------------- routes


def handle_authorize(event):
    """Mint a state and poll token, return the Intuit consent URL."""
    client_id, _ = app_credentials()

    state = secrets.token_urlsafe(24)
    poll_token = secrets.token_urlsafe(32)

    put(
        f"states/{sha256(state)}",
        {"poll_hash": sha256(poll_token), "expires_at": now() + STATE_TTL},
    )
    put(
        f"pending/{sha256(poll_token)}",
        {"status": "pending", "expires_at": now() + PENDING_TTL},
    )

    params = {
        "client_id": client_id,
        "response_type": "code",
        "scope": SCOPE,
        "redirect_uri": REDIRECT_URI,
        "state": state,
    }
    return json_response(
        {
            "auth_url": f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}",
            "poll_token": poll_token,
        }
    )


def handle_callback(event):
    """Complete the exchange and attach the result to the pending record."""
    qs = event.get("queryStringParameters") or {}
    code, state, realm_id = qs.get("code"), qs.get("state"), qs.get("realmId")

    if qs.get("error"):
        return html_page("Authorization declined", "You can close this tab.", 400)
    if not (code and state and realm_id):
        return html_page("Invalid request", "Missing parameters.", 400)

    state_key = f"states/{sha256(state)}"
    state_record = get_json(state_key)
    delete(state_key)  # single use, regardless of outcome

    if not state_record or state_record["expires_at"] < now():
        return html_page(
            "Link expired",
            "This authorization link was already used or has expired. "
            "Please start again from Claude.",
            400,
        )

    tokens = exchange_code(code)

    # Refresh token first. If the second write fails, the store holds a live
    # refresh token and a stale access token, which self-heals on next use.
    # The reverse order would persist a dead refresh token.
    put(f"tenants/{realm_id}/refresh_token", tokens["refresh_token"], secure=True)
    put(f"tenants/{realm_id}/access_token", tokens["access_token"], secure=True)
    put(
        f"tenants/{realm_id}/metadata",
        {
            "realm_id": realm_id,
            "environment": QBO_ENV,
            "access_expires": now() + int(tokens.get("expires_in", 3600)),
            "updated_at": now(),
        },
    )

    # Issue the device credential now; the poll route hands it over once.
    device_credential = secrets.token_urlsafe(32)
    put(
        f"creds/{sha256(device_credential)}",
        {"realm_id": realm_id, "created_at": now()},
    )
    put(
        f"pending/{state_record['poll_hash']}",
        {
            "status": "complete",
            "device_credential": device_credential,
            "realm_id": realm_id,
            "expires_at": now() + PENDING_TTL,
        },
    )

    print(json.dumps({"event": "authorized", "realm_id": realm_id}))

    return html_page(
        "QuickBooks connected",
        "You can close this tab and return to Claude.",
    )


def handle_token(event):
    """Mint a QuickBooks access token for a device credential.

    The credential arrives as a query parameter rather than a header, per review
    decision. Do not add `print(event)` to this handler: the credential is part
    of the request path and would be written to CloudWatch in plaintext.
    """
    credential = (event.get("queryStringParameters") or {}).get("credential")
    if not credential:
        return json_response({"error": "credential_required"}, 401)

    record = get_json(f"creds/{sha256(credential)}")
    if not record:
        return json_response({"error": "unauthorized"}, 401)

    # Carry the existing token-minting body across from the current Lambda here,
    # keyed on record["realm_id"]. Reserved concurrency of 1 on this function is
    # what prevents two invocations rotating the refresh token at once; GET is
    # retryable by proxies, so that setting must stay in place.
    raise NotImplementedError("port the existing /token implementation here")


def handle_poll(event):
    """Hand the device credential over exactly once, then discard our copy."""
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return json_response({"error": "invalid_json"}, 400)

    poll_token = body.get("poll_token")
    if not poll_token:
        return json_response({"error": "poll_token_required"}, 400)

    key = f"pending/{sha256(poll_token)}"
    record = get_json(key)

    if not record or record["expires_at"] < now():
        return json_response({"status": "expired"})

    if record["status"] != "complete":
        return json_response({"status": "pending"})

    # Delete before returning: the credential leaves the store on first read.
    delete(key)
    print(json.dumps({"event": "credential_issued", "realm_id": record["realm_id"]}))

    return json_response(
        {
            "status": "complete",
            "device_credential": record["device_credential"],
            "realm_id": record["realm_id"],
        }
    )


def sweep_expired():
    """Opportunistic cleanup. Parameter Store has no TTL of its own."""
    deleted = 0
    paginator = ssm.get_paginator("get_parameters_by_path")
    for folder in ("states", "pending"):
        for page in paginator.paginate(Path=f"{PREFIX}/{folder}/", Recursive=False):
            batch = []
            for param in page["Parameters"]:
                try:
                    if json.loads(param["Value"])["expires_at"] < now():
                        batch.append(param["Name"])
                except (json.JSONDecodeError, KeyError):
                    continue
            # delete_parameters accepts at most 10 names per call
            for i in range(0, len(batch), 10):
                ssm.delete_parameters(Names=batch[i : i + 10])
                deleted += len(batch[i : i + 10])
    if deleted:
        print(json.dumps({"event": "swept", "deleted": deleted}))


def handler(event, context):
    path = (event.get("requestContext", {}).get("http", {}).get("path") or "/").rstrip("/")

    try:
        if path.endswith("/authorize"):
            return handle_authorize(event)
        if path.endswith("/callback"):
            return handle_callback(event)
        if path.endswith("/poll"):
            return handle_poll(event)
        if path.endswith("/token"):
            return handle_token(event)
        return json_response({"error": "not_found"}, 404)
    except ClientError as exc:
        print(json.dumps({"event": "aws_error", "code": exc.response["Error"]["Code"]}))
        return json_response({"error": "internal"}, 500)
