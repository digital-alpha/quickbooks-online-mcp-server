"""
Lambda B: finos-qbo-token

Routes:
  POST /authorize                             Start device-authorization flow (v1.1.0+).
  POST /poll      {"poll_token": "..."}       Poll for device credential (v1.1.0+).
  GET  /token     ?credential=...            Short-lived QBO access token (v1.1.0+).
  POST /token     X-Finos-Credential header  Short-lived QBO access token (v1.0.0 compat).
  POST /enroll    {"setup_code": "..."}       [TRANSITION] Swap setup code for device cred.
                                              Remove once all clients are on v1.1.0.

The MCP server only ever holds a device credential.  The client secret and
the tenant refresh token never leave AWS.

SSM Parameter Store layout:
  /finos/qbo/client_id                        — Intuit app client ID
  /finos/qbo/client_secret                    — Intuit app client secret
  /finos/qbo/codes/<sha256>                   — setup code → tenant mapping
  /finos/qbo/creds/<sha256>                   — device credential → tenant mapping
  /finos/qbo/states/<sha256>                  — OAuth state → poll_hash mapping
  /finos/qbo/pending/<sha256>                 — pending device-auth status
  /finos/qbo/tenants/<realmId>/refresh_token  — long-lived refresh token
  /finos/qbo/tenants/<realmId>/access_token   — cached short-lived access token
  /finos/qbo/tenants/<realmId>/metadata       — realm_id, access_expires, updated_at
"""

import hashlib
import json
import logging
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from base64 import b64encode

import boto3
from botocore.exceptions import ClientError

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SSM_PREFIX = os.environ.get("SSM_PREFIX", "/finos/qbo")
QBO_ENV = os.environ.get("QBO_ENV", "sandbox")

TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
API_BASE = (
    "https://quickbooks.api.intuit.com"
    if QBO_ENV == "production"
    else "https://sandbox-quickbooks.api.intuit.com"
)

# Refresh the access token this many seconds before it actually expires
# to prevent in-flight calls from racing the expiry window.
EXPIRY_SKEW_SECONDS = 120
HTTP_TIMEOUT_SECONDS = 10

# Input constraints
MAX_SETUP_CODE_LEN = 200
MAX_CREDENTIAL_LEN = 256
MAX_LABEL_LEN = 64

# Only allow printable word chars, spaces, and hyphens in the label
_LABEL_CLEAN_RE = re.compile(r"[^\w\s\-]")

# ---------------------------------------------------------------------------
# Structured logging (never log tokens or secrets)
# ---------------------------------------------------------------------------

_logger = logging.getLogger()
_logger.setLevel(logging.INFO)


def log_event(event_name: str, **kwargs) -> None:
    _logger.info(json.dumps({"event": event_name, **kwargs}))


# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def now() -> int:
    return int(time.time())


# ---------------------------------------------------------------------------
# Security response headers applied to every response
# ---------------------------------------------------------------------------

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def json_response(payload: dict, status: int = 200) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            **_SECURITY_HEADERS,
        },
        "body": json.dumps(payload),
    }


# ---------------------------------------------------------------------------
# SSM client (module-level; re-used across warm invocations)
# ---------------------------------------------------------------------------

_ssm = boto3.client("ssm")
_param_cache: dict | None = None


# ---------------------------------------------------------------------------
# App credentials
# ---------------------------------------------------------------------------


def get_app_credentials() -> dict:
    """
    Return {'client_id': ..., 'client_secret': ...}.

    Priority:
      1. Environment variables (CLIENT_ID / QUICKBOOKS_CLIENT_ID, etc.)
      2. SSM Parameter Store (cached after first fetch per warm container)
    """
    global _param_cache

    env_id = os.environ.get("CLIENT_ID") or os.environ.get("QUICKBOOKS_CLIENT_ID")
    env_secret = (
        os.environ.get("CLIENT_SECRET") or os.environ.get("QUICKBOOKS_CLIENT_SECRET")
    )
    if env_id and env_secret:
        return {"client_id": env_id, "client_secret": env_secret}

    if _param_cache:
        return _param_cache

    resp = _ssm.get_parameters(
        Names=[f"{SSM_PREFIX}/client_id", f"{SSM_PREFIX}/client_secret"],
        WithDecryption=True,
    )
    found = {
        p["Name"].rsplit("/", 1)[-1]: p["Value"]
        for p in resp.get("Parameters", [])
    }
    if not found.get("client_id") or not found.get("client_secret"):
        raise RuntimeError("Missing client_id / client_secret in env vars or SSM")

    _param_cache = found
    return _param_cache


# ---------------------------------------------------------------------------
# SSM helpers
# ---------------------------------------------------------------------------


def ssm_put(name: str, value: str, param_type: str = "SecureString") -> None:
    _ssm.put_parameter(Name=name, Value=value, Type=param_type, Overwrite=True)


def ssm_get(name: str) -> str | None:
    try:
        resp = _ssm.get_parameter(Name=name, WithDecryption=True)
        return resp["Parameter"]["Value"]
    except ClientError as err:
        if err.response["Error"]["Code"] == "ParameterNotFound":
            return None
        raise


def ssm_delete(name: str) -> bool:
    try:
        _ssm.delete_parameter(Name=name)
        return True
    except ClientError as err:
        if err.response["Error"]["Code"] == "ParameterNotFound":
            return False
        raise


# ---------------------------------------------------------------------------
# Intuit token refresh (urllib only — no third-party deps needed in Lambda)
# ---------------------------------------------------------------------------


def refresh_with_intuit(refresh_token: str) -> dict:
    """
    Exchange a refresh token for a new access+refresh token pair.
    Raises RuntimeError("refresh_rejected:<status_code>") on non-2xx responses.
    """
    creds = get_app_credentials()
    credential_b64 = b64encode(
        f"{creds['client_id']}:{creds['client_secret']}".encode()
    ).decode()
    payload = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }).encode("ascii")

    req = urllib.request.Request(
        TOKEN_URL,
        data=payload,
        headers={
            "Authorization": f"Basic {credential_b64}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"refresh_rejected:{err.code}") from err


# ---------------------------------------------------------------------------
# Route: POST /authorize
# ---------------------------------------------------------------------------


def handle_authorize(event: dict) -> dict:
    """Mint a state and poll token, return the Intuit consent URL."""
    creds = get_app_credentials()

    state = secrets.token_urlsafe(24)
    poll_token = secrets.token_urlsafe(32)

    ssm_put(
        f"{SSM_PREFIX}/states/{sha256_hex(state)}",
        json.dumps({"poll_hash": sha256_hex(poll_token), "expires_at": now() + 900}),
        "String",
    )
    ssm_put(
        f"{SSM_PREFIX}/pending/{sha256_hex(poll_token)}",
        json.dumps({"status": "pending", "expires_at": now() + 900}),
        "String",
    )

    params = {
        "client_id": creds["client_id"],
        "response_type": "code",
        "scope": "com.intuit.quickbooks.accounting",
        "redirect_uri": os.environ.get("REDIRECT_URI", ""),
        "state": state,
    }
    return json_response(
        {
            "auth_url": f"https://appcenter.intuit.com/connect/oauth2?{urllib.parse.urlencode(params)}",
            "poll_token": poll_token,
        }
    )


# ---------------------------------------------------------------------------
# Route: POST /poll
# ---------------------------------------------------------------------------


def handle_poll(event: dict) -> dict:
    """Hand the device credential over exactly once, then discard our copy."""
    try:
        body = json.loads(event.get("body") or "{}")
    except (json.JSONDecodeError, TypeError):
        return json_response({"error": "invalid_json"}, 400)

    poll_token = str(body.get("poll_token", ""))
    if not poll_token:
        return json_response({"error": "poll_token_required"}, 400)

    key = f"{SSM_PREFIX}/pending/{sha256_hex(poll_token)}"
    val = ssm_get(key)
    if not val:
        return json_response({"status": "expired"})

    try:
        record = json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return json_response({"status": "expired"})

    if record.get("expires_at", 0) < now():
        ssm_delete(key)
        return json_response({"status": "expired"})

    if record.get("status") != "complete":
        return json_response({"status": "pending"})

    # Delete before returning: the credential leaves the store on first read.
    ssm_delete(key)
    log_event("credential_issued", realm_id=record.get("realm_id", ""))

    return json_response(
        {
            "status": "complete",
            "device_credential": record["device_credential"],
            "realm_id": record["realm_id"],
        }
    )


def sweep_expired() -> None:
    """Opportunistic cleanup. Parameter Store has no TTL of its own."""
    deleted = 0
    paginator = _ssm.get_paginator("get_parameters_by_path")
    for folder in ("states", "pending"):
        try:
            for page_res in paginator.paginate(Path=f"{SSM_PREFIX}/{folder}/", Recursive=False):
                batch = []
                for param in page_res.get("Parameters", []):
                    try:
                        if json.loads(param["Value"]).get("expires_at", 0) < now():
                            batch.append(param["Name"])
                    except (json.JSONDecodeError, KeyError, TypeError):
                        continue
                for i in range(0, len(batch), 10):
                    _ssm.delete_parameters(Names=batch[i : i + 10])
                    deleted += len(batch[i : i + 10])
        except ClientError:
            continue
    if deleted:
        log_event("swept", deleted=deleted)


# ---------------------------------------------------------------------------
# Route: POST /token  (helpers)
# ---------------------------------------------------------------------------


def mint_access_token(tenant_id: str) -> dict:
    """
    Return a valid QBO access token for tenant_id, refreshing it if needed.

    Returns either:
      {"payload": {"access_token": ..., "realm_id": ..., "api_base": ..., "expires_at": ...}}
    or:
      {"error": "<reason>"}
    """
    tenant_prefix = f"{SSM_PREFIX}/tenants/{tenant_id}"

    metadata_val = ssm_get(f"{tenant_prefix}/metadata")
    refresh_token_val = ssm_get(f"{tenant_prefix}/refresh_token")
    access_token_val = ssm_get(f"{tenant_prefix}/access_token")

    if not refresh_token_val or not metadata_val:
        return {"error": "tenant_not_enrolled"}

    try:
        metadata = json.loads(metadata_val)
    except (json.JSONDecodeError, TypeError):
        return {"error": "tenant_not_enrolled"}

    # Return the cached access token if it is still valid within the skew margin
    access_expires = int(metadata.get("access_expires", 0))
    if access_expires > now() + EXPIRY_SKEW_SECONDS and access_token_val:
        return {
            "payload": {
                "access_token": access_token_val,
                "realm_id": metadata["realm_id"],
                "api_base": API_BASE,
                "expires_at": access_expires,
            }
        }

    # Access token is stale — refresh it with Intuit
    try:
        fresh = refresh_with_intuit(refresh_token_val)
    except RuntimeError as err:
        status_str = str(err).split(":", 1)[1] if ":" in str(err) else "unknown"
        log_event("refresh_failed", status=status_str)
        return {"error": "refresh_rejected"}

    new_expires = now() + int(fresh.get("expires_in", 3600))

    # Persist the rotated tokens back to SSM.
    # Intuit always issues a new refresh token on every successful refresh.
    ssm_put(f"{tenant_prefix}/refresh_token", fresh["refresh_token"])
    ssm_put(f"{tenant_prefix}/access_token", fresh["access_token"])
    ssm_put(
        f"{tenant_prefix}/metadata",
        json.dumps({
            "realm_id": metadata["realm_id"],
            "access_expires": new_expires,
            "updated_at": now(),
        }),
        "String",
    )

    return {
        "payload": {
            "access_token": fresh["access_token"],
            "realm_id": metadata["realm_id"],
            "api_base": API_BASE,
            "expires_at": new_expires,
        }
    }


def handle_token(event: dict) -> dict:
    """
    Validate the device credential and return a short-lived QBO access token.
    The credential is passed as a query parameter or X-Finos-Credential header.
    """
    # Opportunistic cleanup (~1 in 20 requests)
    if secrets.randbelow(20) == 0:
        try:
            sweep_expired()
        except Exception as err:
            log_event("sweep_error", message=str(err))

    qs = event.get("queryStringParameters") or {}
    credential = qs.get("credential")

    if not credential:
        headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        credential = headers.get("x-finos-credential", "")

    if not credential:
        return json_response({"error": "credential_required"}, 401)

    # Reject oversized input before SSM lookup
    if len(credential) > MAX_CREDENTIAL_LEN:
        return json_response({"error": "unauthorized"}, 401)

    # The credential is stored only as its SHA-256 hash — look up by hash
    cred_hash = sha256_hex(credential)
    cred_val = ssm_get(f"{SSM_PREFIX}/creds/{cred_hash}")

    if not cred_val:
        # Return the same status/body regardless of whether the hash exists to
        # avoid leaking information about which credentials are registered.
        return json_response({"error": "unauthorized"}, 401)

    try:
        cred_data = json.loads(cred_val)
    except (json.JSONDecodeError, TypeError):
        return json_response({"error": "unauthorized"}, 401)

    result = mint_access_token(cred_data["tenant_id"])

    if "error" in result:
        error = result["error"]
        status = 502 if error == "refresh_rejected" else 409
        return json_response({"error": error}, status)

    log_event("token_issued", label=cred_data.get("label", ""))
    return json_response(result["payload"])


# ---------------------------------------------------------------------------
# [TRANSITION] Route: POST /enroll  —  Remove once all clients are on v1.1.0
# v1.0.0 clients call /enroll to swap a setup code for a device credential.
# The device-flow (/authorize + /poll) supersedes this path in v1.1.0.
# ---------------------------------------------------------------------------


def handle_enroll(event: dict) -> dict:
    """
    Swap a single-use setup code for a long-lived device credential.
    The setup code is deleted immediately to prevent replay.
    """
    try:
        body = json.loads(event.get("body") or "{}")
    except (json.JSONDecodeError, TypeError):
        return json_response({"error": "invalid_json"}, 400)

    setup_code = str(body.get("setup_code", ""))
    if not setup_code:
        return json_response({"error": "setup_code_required"}, 400)

    # Reject oversized input before it can be used as SSM key material
    if len(setup_code) > MAX_SETUP_CODE_LEN:
        return json_response({"error": "invalid_or_expired_code"}, 401)

    # Sanitize label — strip anything that isn't word chars, spaces, or hyphens
    raw_label = str(body.get("label", "unnamed"))[:MAX_LABEL_LEN]
    label = _LABEL_CLEAN_RE.sub("", raw_label).strip() or "unnamed"

    code_hash = sha256_hex(setup_code)

    # Look up the setup code (stored as SHA-256 hash to keep the table safe)
    code_val = ssm_get(f"{SSM_PREFIX}/codes/{code_hash}")
    if not code_val:
        return json_response({"error": "invalid_or_expired_code"}, 401)

    try:
        code_data = json.loads(code_val)
    except (json.JSONDecodeError, TypeError):
        return json_response({"error": "invalid_or_expired_code"}, 401)

    if code_data.get("expires_at", 0) < now():
        ssm_delete(f"{SSM_PREFIX}/codes/{code_hash}")
        return json_response({"error": "invalid_or_expired_code"}, 401)

    # Delete the setup code immediately to enforce single-use semantics
    ssm_delete(f"{SSM_PREFIX}/codes/{code_hash}")

    # Generate a 256-bit device credential (URL-safe base64)
    device_credential = secrets.token_urlsafe(32)
    cred_hash = sha256_hex(device_credential)

    ssm_put(
        f"{SSM_PREFIX}/creds/{cred_hash}",
        json.dumps({
            "tenant_id": code_data["tenant_id"],
            "label": label,
            "created_at": now(),
        }),
        "String",
    )

    log_event("device_enrolled", label=label)
    return json_response({"device_credential": device_credential})


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------


def handler(event: dict, context) -> dict:  # noqa: ANN001
    raw_path = ((event.get("requestContext") or {}).get("http") or {}).get("path", "/")
    path = raw_path.rstrip("/")

    try:
        if path.endswith("/authorize"):
            return handle_authorize(event)
        if path.endswith("/poll"):
            return handle_poll(event)
        if path.endswith("/token"):
            return handle_token(event)
        # [TRANSITION] Remove /enroll once all clients are on v1.1.0
        if path.endswith("/enroll"):
            return handle_enroll(event)
        return json_response({"error": "not_found"}, 404)

    except Exception as err:  # noqa: BLE001
        log_event("error", name=type(err).__name__, message=str(err))
        return json_response({"error": "internal"}, 500)
