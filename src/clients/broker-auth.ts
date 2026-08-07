/**
 * QuickBooks auth against the hosted broker, using a device-authorization flow
 * so no credential ever passes through the conversation.
 *
 * Credential resolution order:
 *   1. In-memory runtime credential (written by the connect tool for this session)
 *   2. FINOS_CREDENTIAL              (set from user_config at install)
 *
 * Credentials and authorization states are kept in runtime memory for the session scope
 * and are not persisted to local files on disk.
 */

const BROKER_URL = (process.env.FINOS_BROKER_URL ?? '').replace(/\/+$/, '');

/** Refresh early so a call never races the expiry. */
const EXPIRY_SKEW_SECONDS = 120;

/** A pending authorization is abandoned after this long. */
const PENDING_TTL_SECONDS = 900;

interface BrokerToken {
  access_token: string;
  realm_id: string;
  api_base: string;
  expires_at: number;
}

export interface QboAuth {
  accessToken: string;
  realmId: string;
  isSandbox: boolean;
}

export class NotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConnectedError';
  }
}

let cachedToken: BrokerToken | undefined;
let inFlight: Promise<BrokerToken> | undefined;
let inMemoryDeviceCredential: string | undefined;
let inMemoryRealmId: string | undefined;
let pendingAuth: { pollToken: string; expiresAt: number } | undefined;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- session runtime memory

function readCredential(): string | undefined {
  return inMemoryDeviceCredential;
}

function saveCredential(deviceCredential: string, realmId?: string): void {
  inMemoryDeviceCredential = deviceCredential;
  inMemoryRealmId = realmId;
  // A newly saved credential invalidates any token cached for the old one.
  cachedToken = undefined;
}

// ---------------------------------------------------------------- broker calls

function getBrokerUrl(): string {
  const url = (process.env.FINOS_BROKER_URL ?? '').replace(/\/+$/, '');
  if (!url) {
    throw new Error('FINOS_BROKER_URL is not configured for this extension.');
  }
  return url;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    throw new NotConnectedError(
      'This QuickBooks connection is no longer valid. Run the connect tool to ' +
        'authorize again.',
    );
  }
  if (!response.ok) {
    // Body deliberately not echoed: it can carry token material.
    throw new Error(`QuickBooks service returned ${response.status}.`);
  }
  return (await response.json()) as T;
}

/** Used by /authorize and /poll, which take JSON request bodies. */
async function brokerPost<T>(path: string, body?: unknown): Promise<T> {
  const brokerUrl = getBrokerUrl();

  let response: Response;
  try {
    response = await fetch(`${brokerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? '{}' : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the QuickBooks service: ${detail}`);
  }

  return handleResponse<T>(response);
}

/**
 * Used by /token only. The credential travels as a query parameter rather than
 * a header.
 *
 * Consequence to be aware of on the Lambda side: the credential is part of the
 * request path, so it must never be logged. Function URLs do not log paths by
 * default, but `print(event)` in the handler, or any CDN or load balancer added
 * in front, would capture it in plaintext.
 */
async function brokerGetToken<T>(credential: string): Promise<T> {
  const brokerUrl = getBrokerUrl();

  const url = new URL(`${brokerUrl}/token`);
  url.searchParams.set('credential', credential);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the QuickBooks service: ${detail}`);
  }

  return handleResponse<T>(response);
}

// ---------------------------------------------------------------- device flow

export interface AuthorizationStart {
  authUrl: string;
}

/**
 * Begins an authorization. The broker generates both the OAuth state and the
 * poll token, so neither is client-controlled and the flow cannot be fixated by
 * a caller supplying a value of their own.
 */
export async function startAuthorization(): Promise<AuthorizationStart> {
  const result = await brokerPost<{ auth_url: string; poll_token: string }>(
    '/authorize',
  );

  // Stored in runtime memory for the session scope.
  pendingAuth = {
    pollToken: result.poll_token,
    expiresAt: nowSeconds() + PENDING_TTL_SECONDS,
  };

  return { authUrl: result.auth_url };
}

export type AuthorizationResult =
  | { status: 'connected'; realmId: string }
  | { status: 'pending' }
  | { status: 'expired' };

/**
 * Checks whether the browser half of the flow has completed. On success the
 * broker hands over the device credential exactly once and discards its copy.
 */
export async function completeAuthorization(): Promise<AuthorizationResult> {
  if (!pendingAuth || pendingAuth.expiresAt < nowSeconds()) {
    return { status: 'expired' };
  }

  const result = await brokerPost<{
    status: 'pending' | 'complete';
    device_credential?: string;
    realm_id?: string;
  }>('/poll', { poll_token: pendingAuth.pollToken });

  if (result.status !== 'complete' || !result.device_credential) {
    return { status: 'pending' };
  }

  saveCredential(result.device_credential, result.realm_id);
  pendingAuth = undefined;

  return { status: 'connected', realmId: result.realm_id ?? 'unknown' };
}

export function isConnected(): boolean {
  return !!readCredential();
}

/**
 * Disconnects QuickBooks Online by resetting in-memory credentials and cached tokens
 * for this session.
 */
export function disconnectQuickbooks(): void {
  cachedToken = undefined;
  inMemoryDeviceCredential = undefined;
  inMemoryRealmId = undefined;
  pendingAuth = undefined;
}

// ---------------------------------------------------------------- token access

const isFresh = (token: BrokerToken | undefined): token is BrokerToken =>
  !!token && token.expires_at > nowSeconds() + EXPIRY_SKEW_SECONDS;

async function fetchToken(): Promise<BrokerToken> {
  const credential = readCredential();
  if (!credential) {
    throw new NotConnectedError(
      'QuickBooks is not connected yet. Run the connect tool to authorize.',
    );
  }

  const token = await brokerGetToken<BrokerToken>(credential);

  if (!token.access_token || !token.realm_id) {
    throw new Error('QuickBooks service returned an incomplete response.');
  }
  return token;
}

/**
 * Returns a valid access token, reusing the cached one where possible.
 *
 * The server is a long-lived process, so this reaches the broker roughly once
 * an hour rather than once per tool call. Concurrent callers share one fetch.
 */
export async function getBrokerAuth(): Promise<QboAuth> {
  if (!isFresh(cachedToken)) {
    inFlight ??= fetchToken()
      .then((token) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        inFlight = undefined;
      });
    await inFlight;
  }

  const token = cachedToken!;
  return {
    accessToken: token.access_token,
    realmId: token.realm_id,
    isSandbox: token.api_base.includes('sandbox'),
  };
}

/** Drops the cached token. Call if QuickBooks rejects it mid-session. */
export function invalidateBrokerAuth(): void {
  cachedToken = undefined;
}
