/**
 * QuickBooks auth against the hosted broker, using a device-authorization flow
 * so no credential ever passes through the conversation.
 *
 * Credential storage:
 *   All authorization states and tokens are held in a runtime Map keyed by
 *   `chat_id` (resolved from AsyncLocalStorage). Each conversation gets its own
 *   isolated session bucket — a fresh chat_id has no credential, and must run
 *   the connect tool before any data calls succeed.
 *
 *   Sessions are evicted after a configurable TTL (default 2 hours) to prevent
 *   unbounded memory growth, since the MCP client never signals "chat closed."
 *
 * Credentials are never persisted to local files on disk.
 */

import { requireChatId } from '../helpers/chat-context.js';

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

// ---------------------------------------------------------------- per-session state

interface SessionState {
  deviceCredential?: string;
  realmId?: string;
  pendingAuth?: { pollToken: string; expiresAt: number };
  cachedToken?: BrokerToken;
  inFlight?: Promise<BrokerToken>;
  lastAccessed: number; // epoch seconds, for eviction
}

const sessions = new Map<string, SessionState>();

const nowSeconds = () => Math.floor(Date.now() / 1000);

function getSession(chatId: string): SessionState {
  let session = sessions.get(chatId);
  if (!session) {
    session = { lastAccessed: nowSeconds() };
    sessions.set(chatId, session);
  }
  session.lastAccessed = nowSeconds();
  return session;
}

// ---------------------------------------------------------------- TTL eviction

const SESSION_TTL_SECONDS = Number(process.env.FINOS_SESSION_TTL_SECONDS ?? 7200); // 2h
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sweep = setInterval(() => {
  const cutoff = nowSeconds() - SESSION_TTL_SECONDS;
  for (const [chatId, session] of sessions) {
    if (session.lastAccessed < cutoff) sessions.delete(chatId);
  }
}, SWEEP_INTERVAL_MS);

sweep.unref(); // must not hold the process open

// ---------------------------------------------------------------- session runtime memory

function readCredential(): string | undefined {
  const session = getSession(requireChatId());
  return session.deviceCredential;
}

function saveCredential(deviceCredential: string, realmId?: string): void {
  const session = getSession(requireChatId());
  session.deviceCredential = deviceCredential;
  session.realmId = realmId;
  // A newly saved credential invalidates any token cached for the old one.
  session.cachedToken = undefined;
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

  // Stored in the session bucket for this chat.
  const session = getSession(requireChatId());
  session.pendingAuth = {
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
  const session = getSession(requireChatId());

  if (!session.pendingAuth || session.pendingAuth.expiresAt < nowSeconds()) {
    return { status: 'expired' };
  }

  const result = await brokerPost<{
    status: 'pending' | 'complete';
    device_credential?: string;
    realm_id?: string;
  }>('/poll', { poll_token: session.pendingAuth.pollToken });

  if (result.status !== 'complete' || !result.device_credential) {
    return { status: 'pending' };
  }

  saveCredential(result.device_credential, result.realm_id);
  session.pendingAuth = undefined;

  return { status: 'connected', realmId: result.realm_id ?? 'unknown' };
}

export function isConnected(): boolean {
  return !!readCredential();
}

/**
 * Disconnects QuickBooks Online by clearing this conversation's session bucket.
 * Other conversations' connections are unaffected.
 */
export function disconnectQuickbooks(): void {
  const chatId = requireChatId();
  sessions.delete(chatId);
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
 * an hour rather than once per tool call. Concurrent callers within the same
 * chat share one fetch via the per-session `inFlight` promise; callers from
 * different chats each resolve their own session independently.
 */
export async function getBrokerAuth(): Promise<QboAuth> {
  const session = getSession(requireChatId());

  if (!isFresh(session.cachedToken)) {
    session.inFlight ??= fetchToken()
      .then((token) => {
        session.cachedToken = token;
        return token;
      })
      .finally(() => {
        session.inFlight = undefined;
      });
    await session.inFlight;
  }

  const token = session.cachedToken!;
  return {
    accessToken: token.access_token,
    realmId: token.realm_id,
    isSandbox: token.api_base.includes('sandbox'),
  };
}

/** Drops the cached token for this chat. Call if QuickBooks rejects it mid-session. */
export function invalidateBrokerAuth(): void {
  const session = getSession(requireChatId());
  session.cachedToken = undefined;
}

// ---------------------------------------------------------------- test helpers

/**
 * Exposed for test teardown only. Clears all sessions.
 * @internal
 */
export function _resetAllSessions(): void {
  sessions.clear();
}
