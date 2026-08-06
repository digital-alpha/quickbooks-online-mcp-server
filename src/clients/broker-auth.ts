import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * QuickBooks auth against the hosted broker, using a device-authorization flow
 * so no credential ever passes through the conversation.
 *
 * Credential resolution order:
 *   1. ~/.finos/qbo-credential.json  (written by the connect tool)
 *   2. FINOS_CREDENTIAL              (set from user_config at install)
 *
 * The file takes precedence so re-authorizing through chat overrides a stale
 * installed value without touching extension settings or requiring a restart.
 */

const BROKER_URL = (process.env.FINOS_BROKER_URL ?? '').replace(/\/+$/, '');

const FINOS_DIR = join(homedir(), '.finos');
const CRED_PATH = join(FINOS_DIR, 'qbo-credential.json');
const PENDING_PATH = join(FINOS_DIR, 'qbo-pending.json');

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

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- local files

function ensureDir(): void {
  mkdirSync(FINOS_DIR, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir();
  // 0600: readable only by this user. Contains a bearer-equivalent credential.
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function readCredential(): string | undefined {
  const stored = readJson<{ device_credential?: string }>(CRED_PATH);
  return stored?.device_credential || process.env.FINOS_CREDENTIAL || undefined;
}

function saveCredential(deviceCredential: string, realmId?: string): void {
  writeJson(CRED_PATH, {
    device_credential: deviceCredential,
    realm_id: realmId,
    saved_at: new Date().toISOString(),
  });
  // A newly saved credential invalidates any token cached for the old one.
  cachedToken = undefined;
}

// ---------------------------------------------------------------- broker calls

function assertConfigured(): void {
  if (!BROKER_URL) {
    throw new Error('FINOS_BROKER_URL is not configured for this extension.');
  }
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
  assertConfigured();

  let response: Response;
  try {
    response = await fetch(`${BROKER_URL}${path}`, {
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
  assertConfigured();

  const url = new URL(`${BROKER_URL}/token`);
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

  // Persisted rather than held in memory so the flow survives a server restart
  // between the two tool calls.
  writeJson(PENDING_PATH, {
    poll_token: result.poll_token,
    expires_at: nowSeconds() + PENDING_TTL_SECONDS,
  });

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
  const pending = readJson<{ poll_token: string; expires_at: number }>(
    PENDING_PATH,
  );

  if (!pending || pending.expires_at < nowSeconds()) {
    return { status: 'expired' };
  }

  const result = await brokerPost<{
    status: 'pending' | 'complete';
    device_credential?: string;
    realm_id?: string;
  }>('/poll', { poll_token: pending.poll_token });

  if (result.status !== 'complete' || !result.device_credential) {
    return { status: 'pending' };
  }

  saveCredential(result.device_credential, result.realm_id);
  try {
    unlinkSync(PENDING_PATH);
  } catch {
    /* already gone */
  }

  return { status: 'connected', realmId: result.realm_id ?? 'unknown' };
}

export function isConnected(): boolean {
  return !!readCredential();
}

/**
 * Disconnects QuickBooks Online by removing local credential files and resetting
 * in-memory cached tokens.
 */
export function disconnectQuickbooks(): void {
  cachedToken = undefined;
  try {
    unlinkSync(CRED_PATH);
  } catch {
    /* file didn't exist or already removed */
  }
  try {
    unlinkSync(PENDING_PATH);
  } catch {
    /* file didn't exist or already removed */
  }
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
