"""
Lambda A: finos-qbo-auth  (Phase 2: Parameter Store Multi-Tenant)

  GET /start     Redirect the user to Intuit's consent screen.
  GET /callback  Exchange the auth code, store tokens in Parameter Store,
                 and display a 15-minute single-use Setup Code.

SSM Parameter Store layout:
  /finos/qbo/sandbox/client_id      — Intuit app client ID (sandbox)
  /finos/qbo/sandbox/client_secret  — Intuit app client secret (sandbox)
  /finos/qbo/production/client_id     — Intuit app client ID (production)
  /finos/qbo/production/client_secret — Intuit app client secret (production)
  /finos/qbo/states/<state>         — CSRF state token (expires in 10 min)
  /finos/qbo/tenants/<realmId>/*    — refresh_token, access_token, metadata
  /finos/qbo/codes/<sha256>         — setup code → tenant mapping (15 min)

Environment is resolved per tenant (stored in each tenant's metadata),
not globally — see resolve_environment_config() below.
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
REDIRECT_URI = os.environ.get("REDIRECT_URI", "")

AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
SCOPE = "com.intuit.quickbooks.accounting"

SETUP_CODE_TTL_SECONDS = 900   # 15 minutes
STATE_TTL_SECONDS = 600         # 10 minutes
HTTP_TIMEOUT_SECONDS = 10

# State tokens are base64url — only allow those characters (plus length cap)
_SAFE_STATE_RE = re.compile(r"^[A-Za-z0-9\-_]{1,128}$")

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


def escape_html(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


# ---------------------------------------------------------------------------
# Security response headers applied to every response
# ---------------------------------------------------------------------------

_SECURITY_HEADERS = {
    # Tight CSP: no external resources; inline style/script only (needed for
    # the compact single-file HTML pages this Lambda returns).
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}

# ---------------------------------------------------------------------------
# SSM client (module-level; re-used across warm invocations)
# ---------------------------------------------------------------------------

_ssm = boto3.client("ssm")
_env_config_cache: dict = {}

VALID_ENVIRONMENTS = ("sandbox", "production")
API_BASE_BY_ENV = {
    "sandbox": "https://sandbox-quickbooks.api.intuit.com",
    "production": "https://quickbooks.api.intuit.com",
}


# ---------------------------------------------------------------------------
# Per-environment app credentials
# ---------------------------------------------------------------------------


def resolve_environment_config(environment: str) -> dict:
    """
    Return {'client_id': ..., 'client_secret': ..., 'api_base': ...} for the
    given environment — the single switch every caller resolves through.

    Raises on an unrecognized explicit value rather than coercing it to
    "sandbox". Defaulting an absent value to "sandbox" is the caller's job,
    at the point the value is read — not this function's.
    """
    if environment not in VALID_ENVIRONMENTS:
        raise RuntimeError(f"Unknown environment '{environment}'")

    if environment in _env_config_cache:
        return _env_config_cache[environment]

    resp = _ssm.get_parameters(
        Names=[
            f"{SSM_PREFIX}/{environment}/client_id",
            f"{SSM_PREFIX}/{environment}/client_secret",
        ],
        WithDecryption=True,
    )
    found = {
        p["Name"].rsplit("/", 1)[-1]: p["Value"]
        for p in resp.get("Parameters", [])
    }
    if not found.get("client_id") or not found.get("client_secret"):
        raise RuntimeError(
            f"Missing client_id / client_secret in SSM for environment '{environment}'"
        )

    config = {
        "client_id": found["client_id"],
        "client_secret": found["client_secret"],
        "api_base": API_BASE_BY_ENV[environment],
    }
    _env_config_cache[environment] = config
    return config


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
# HTML page helper
# ---------------------------------------------------------------------------


def page(title: str, body_html: str, status: int = 200) -> dict:
    """
    Return a Lambda HTTP response containing a minimal, self-contained HTML page.
    All security headers are applied automatically.
    """
    safe_title = escape_html(title)
    html = (
        "<!doctype html>"
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{safe_title}</title>"
        "<style>"
        "*, *::before, *::after { box-sizing: border-box; }"
        "body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto;"
        "       padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }"
        ".code-wrap { display: flex; align-items: center; gap: .75rem; margin: 1rem 0; }"
        "code { flex: 1; display: block; background: #f4f4f2; padding: .9rem 1rem;"
        "       border-radius: 8px; font-size: 1.05rem; word-break: break-all;"
        "       text-align: center; border: 1px solid #e0e0dc; }"
        "#copy-btn { white-space: nowrap; padding: .55rem 1.1rem; border: none;"
        "            border-radius: 8px; background: #2563eb; color: #fff;"
        "            font-size: .9rem; cursor: pointer; transition: background .2s; }"
        "#copy-btn:hover { background: #1d4ed8; }"
        "small { color: #666; }"
        "</style>"
        f"<h2>{safe_title}</h2>"
        f"{body_html}"
        "<script>"
        "function copyCode() {"
        "  var code = document.getElementById('setup-code').textContent.trim();"
        "  if (!navigator.clipboard) { fallbackCopy(code); return; }"
        "  navigator.clipboard.writeText(code).then(function () {"
        "    showCopied();"
        "  }).catch(function () { fallbackCopy(code); });"
        "}"
        "function fallbackCopy(text) {"
        "  var ta = document.createElement('textarea');"
        "  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';"
        "  document.body.appendChild(ta); ta.focus(); ta.select();"
        "  try { document.execCommand('copy'); } catch(e) {}"
        "  document.body.removeChild(ta); showCopied();"
        "}"
        "function showCopied() {"
        "  var b = document.getElementById('copy-btn');"
        "  b.textContent = 'Copied \u2713'; b.style.background = '#16a34a';"
        "  setTimeout(function () { b.textContent = 'Copy'; b.style.background = ''; }, 2000);"
        "}"
        "</script>"
    )
    return {
        "statusCode": status,
        "headers": {"Content-Type": "text/html; charset=utf-8", **_SECURITY_HEADERS},
        "body": html,
    }


# ---------------------------------------------------------------------------
# Intuit token exchange (urllib only — no third-party deps needed in Lambda)
# ---------------------------------------------------------------------------


def post_form(url: str, form: dict, client_id: str, client_secret: str) -> dict:
    """
    POST application/x-www-form-urlencoded to Intuit and return the JSON body.
    Raises RuntimeError("intuit_rejected:<status_code>") on non-2xx responses.
    """
    credential_b64 = b64encode(f"{client_id}:{client_secret}".encode()).decode()
    payload = urllib.parse.urlencode(form).encode("ascii")

    req = urllib.request.Request(
        url,
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
        raise RuntimeError(f"intuit_rejected:{err.code}") from err


# ---------------------------------------------------------------------------
# Route: GET /callback
# ---------------------------------------------------------------------------


def handle_callback(event: dict) -> dict:
    qs = event.get("queryStringParameters") or {}
    code = qs.get("code", "")
    state = qs.get("state", "")
    realm_id = qs.get("realmId", "")
    error_param = qs.get("error", "")

    if error_param:
        return page(
            "Authorization declined",
            "<p>You declined the authorization. You can close this tab.</p>",
            400,
        )

    if not code or not state or not realm_id:
        return page("Invalid request", "<p>Missing required parameters. Please start again.</p>", 400)

    # Reject state values containing characters outside base64url to prevent
    # any path-traversal attempt via the SSM parameter name.
    if not _SAFE_STATE_RE.match(state):
        return page("Invalid request", "<p>Invalid state parameter.</p>", 400)

    # Verify and consume the CSRF state token (single-use)
    state_key = f"{SSM_PREFIX}/states/{sha256_hex(state)}"
    state_val = ssm_get(state_key)

    if not state_val:
        return page(
            "Link expired",
            "<p>This authorization link was already used or has expired. Please start again from Claude.</p>",
            400,
        )

    poll_hash = None
    # Default applied here, at the read boundary — the state record was
    # written by whichever endpoint started this flow; absent means it
    # predates dual-environment support.
    environment = "sandbox"
    try:
        state_data = json.loads(state_val)
        if state_data.get("expires_at", 0) < int(time.time()):
            ssm_delete(state_key)
            return page(
                "Link expired",
                "<p>This authorization link has expired. Please start again from Claude.</p>",
                400,
            )
        poll_hash = state_data.get("poll_hash")
        environment = state_data.get("environment", "sandbox")
    except (json.JSONDecodeError, TypeError):
        pass

    # Delete state immediately to make it single-use
    ssm_delete(state_key)

    # Exchange the authorization code for tokens with Intuit. TOKEN_URL is the
    # same endpoint for both environments — only the credential pair differs.
    env_config = resolve_environment_config(environment)
    tokens = post_form(
        TOKEN_URL,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        env_config["client_id"],
        env_config["client_secret"],
    )

    # Persist tenant tokens to SSM (refresh token first for resilience)
    tenant_prefix = f"{SSM_PREFIX}/tenants/{realm_id}"
    now_ts = int(time.time())
    expires_in = int(tokens.get("expires_in", 3600))

    ssm_put(f"{tenant_prefix}/refresh_token", tokens["refresh_token"])
    ssm_put(f"{tenant_prefix}/access_token", tokens["access_token"])
    ssm_put(
        f"{tenant_prefix}/metadata",
        json.dumps({
            "realm_id": realm_id,
            "access_expires": now_ts + expires_in,
            "updated_at": now_ts,
            "environment": environment,
        }),
        "String",
    )

    # Issue the device credential now; the poll route hands it over once.
    device_credential = secrets.token_urlsafe(32)
    ssm_put(
        f"{SSM_PREFIX}/creds/{sha256_hex(device_credential)}",
        json.dumps({"tenant_id": realm_id, "created_at": now_ts}),
        "String",
    )

    if poll_hash:
        ssm_put(
            f"{SSM_PREFIX}/pending/{poll_hash}",
            json.dumps({
                "status": "complete",
                "device_credential": device_credential,
                "realm_id": realm_id,
                "expires_at": now_ts + SETUP_CODE_TTL_SECONDS,
            }),
            "String",
        )

    log_event("authorized", realm_id=realm_id)

    return page(
        "QuickBooks connected",
        "<p>You can close this tab and return to Claude.</p>",
    )


# ---------------------------------------------------------------------------
# [TRANSITION] Route: GET /start  —  Remove once all clients are on v1.1.0
# v1.0.0's manifest points users at /start to begin the setup-code flow.
# The device-flow (/authorize on the token Lambda) supersedes this in v1.1.0.
# ---------------------------------------------------------------------------


def handle_start() -> dict:
    # [TRANSITION] Legacy route, scheduled for removal — deliberately not
    # extended with an environment choice. Always sandbox.
    env_config = resolve_environment_config("sandbox")

    state = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + STATE_TTL_SECONDS

    ssm_put(
        f"{SSM_PREFIX}/states/{state}",
        json.dumps({"expires_at": expires_at}),
        "String",
    )

    query = urllib.parse.urlencode({
        "client_id": env_config["client_id"],
        "response_type": "code",
        "scope": SCOPE,
        "redirect_uri": REDIRECT_URI,
        "state": state,
    })
    return {
        "statusCode": 302,
        "headers": {"Location": f"{AUTHORIZE_URL}?{query}", **_SECURITY_HEADERS},
        "body": "",
    }


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------


def handler(event: dict, context) -> dict:  # noqa: ANN001
    raw_path = ((event.get("requestContext") or {}).get("http") or {}).get("path", "/")
    path = raw_path.rstrip("/")

    try:
        # [TRANSITION] Remove /start once all clients are on v1.1.0
        if path.endswith("/start"):
            return handle_start()
        if path.endswith("/callback") or path == "":
            return handle_callback(event)
        return page("Not found", "<p>Unknown path.</p>", 404)

    except RuntimeError as err:
        msg = str(err)
        if msg.startswith("intuit_rejected:"):
            status_str = msg.split(":", 1)[1] if ":" in msg else "0"
            log_event("intuit_error", status=status_str)
            return page("QuickBooks rejected the request", "<p>Please try again.</p>", 502)
        log_event("error", message=msg)
        return page("Something went wrong", "<p>Please try again.</p>", 500)

    except Exception as err:  # noqa: BLE001
        log_event("error", name=type(err).__name__, message=str(err))
        return page("Something went wrong", "<p>Please try again.</p>", 500)

