import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { runWithChatId } from '../../../src/helpers/chat-context.js';
import {
  isConnected,
  startAuthorization,
  completeAuthorization,
  disconnectQuickbooks,
  getBrokerAuth,
  invalidateBrokerAuth,
  NotConnectedError,
  _resetAllSessions,
} from '../../../src/clients/broker-auth.js';

describe('broker-auth chat-scoped session handling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      FINOS_BROKER_URL: 'https://mock-broker.example.com',
    };
    delete process.env.FINOS_CREDENTIAL;
    _resetAllSessions();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetAllSessions();
  });

  // ---- basic per-chat state -----------------------------------------------

  it('starts unconnected for a fresh chat_id', () => {
    runWithChatId('chat-A', () => {
      expect(isConnected()).toBe(false);
    });
  });

  it('throws NotConnectedError when calling getBrokerAuth without authorization', async () => {
    await runWithChatId('chat-A', async () => {
      await expect(getBrokerAuth()).rejects.toThrow(NotConnectedError);
    });
  });

  it('starts authorization and manages pending state per chat', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        auth_url: 'https://mock-broker.example.com/oauth/start',
        poll_token: 'test-poll-token',
      }),
    } as Response);
    global.fetch = fetchMock;

    const startResult = await runWithChatId('chat-A', () => startAuthorization());
    expect(startResult.authUrl).toBe('https://mock-broker.example.com/oauth/start');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mock-broker.example.com/authorize',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('completes authorization and saves credential per chat', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'test-poll-token-123',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'device-cred-abc',
          realm_id: '987654321',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'bearer-token-xyz',
          realm_id: '987654321',
          api_base: 'https://quickbooks.api.intuit.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      } as Response);

    global.fetch = fetchMock;

    await runWithChatId('chat-A', async () => {
      await startAuthorization();
      const completeResult = await completeAuthorization();

      expect(completeResult).toEqual({
        status: 'connected',
        realmId: '987654321',
      });
      expect(isConnected()).toBe(true);

      const auth = await getBrokerAuth();
      expect(auth.accessToken).toBe('bearer-token-xyz');
      expect(auth.realmId).toBe('987654321');
      expect(auth.isSandbox).toBe(false);
    });
  });

  it('disconnects and clears only this chat\'s session', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'test-poll-token',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'device-cred-abc',
          realm_id: '12345',
        }),
      } as Response);

    global.fetch = fetchMock;

    await runWithChatId('chat-A', async () => {
      await startAuthorization();
      await completeAuthorization();
      expect(isConnected()).toBe(true);

      disconnectQuickbooks();

      expect(isConnected()).toBe(false);
      await expect(getBrokerAuth()).rejects.toThrow(NotConnectedError);
    });
  });

  // ---- cross-chat isolation -----------------------------------------------

  it('chat B is not connected after chat A connects', async () => {
    // Connect chat A
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-A',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-A',
          realm_id: 'realm-A',
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-A', async () => {
      await startAuthorization();
      await completeAuthorization();
      expect(isConnected()).toBe(true);
    });

    // Chat B must be disconnected
    runWithChatId('chat-B', () => {
      expect(isConnected()).toBe(false);
    });
  });

  it('chat B cannot access chat A\'s access token (token-cache isolation)', async () => {
    // Connect chat A and fetch a token
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-A',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-A',
          realm_id: 'realm-A',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'token-for-A-only',
          realm_id: 'realm-A',
          api_base: 'https://quickbooks.api.intuit.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-A', async () => {
      await startAuthorization();
      await completeAuthorization();
      const auth = await getBrokerAuth();
      expect(auth.accessToken).toBe('token-for-A-only');
    });

    // Chat B must NOT receive chat A's token
    await runWithChatId('chat-B', async () => {
      await expect(getBrokerAuth()).rejects.toThrow(NotConnectedError);
    });
  });

  it('chat A pending auth is not visible to chat B', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-A',
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-A', async () => {
      await startAuthorization();
    });

    // Chat B has no pending auth → completeAuthorization returns expired
    const result = await runWithChatId('chat-B', () => completeAuthorization());
    expect(result.status).toBe('expired');
  });

  it('disconnecting chat A leaves chat B intact', async () => {
    // Connect both chats
    const fetchMock = jest
      .fn<typeof fetch>()
      // Chat A authorize
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-A',
        }),
      } as Response)
      // Chat A poll complete
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-A',
          realm_id: 'realm-A',
        }),
      } as Response)
      // Chat B authorize
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-B',
        }),
      } as Response)
      // Chat B poll complete
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-B',
          realm_id: 'realm-B',
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-A', async () => {
      await startAuthorization();
      await completeAuthorization();
    });

    await runWithChatId('chat-B', async () => {
      await startAuthorization();
      await completeAuthorization();
    });

    // Disconnect chat A
    runWithChatId('chat-A', () => {
      disconnectQuickbooks();
      expect(isConnected()).toBe(false);
    });

    // Chat B must still be connected
    runWithChatId('chat-B', () => {
      expect(isConnected()).toBe(true);
    });
  });

  it('invalidateBrokerAuth clears only the calling chat\'s cached token', async () => {
    // Connect chat A and cache a token
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-A',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-A',
          realm_id: 'realm-A',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'token-A-first',
          realm_id: 'realm-A',
          api_base: 'https://quickbooks.api.intuit.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      } as Response)
      // After invalidation, next getBrokerAuth fetches again
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'token-A-refreshed',
          realm_id: 'realm-A',
          api_base: 'https://quickbooks.api.intuit.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-A', async () => {
      await startAuthorization();
      await completeAuthorization();
      const auth1 = await getBrokerAuth();
      expect(auth1.accessToken).toBe('token-A-first');

      invalidateBrokerAuth();

      const auth2 = await getBrokerAuth();
      expect(auth2.accessToken).toBe('token-A-refreshed');
    });
  });

  // ---- requireChatId guard ------------------------------------------------

  it('requireChatId throws when no chat context is bound', () => {
    // Calling broker-auth functions outside runWithChatId should throw
    expect(() => isConnected()).toThrow('No chat_id is bound');
  });

  // ---- broker-call error handling -----------------------------------------

  it('throws when FINOS_BROKER_URL is not configured', async () => {
    // Deleted rather than set to '', so the `??` fallback in getBrokerUrl()
    // is exercised too (an already-empty string skips the nullish branch).
    delete process.env.FINOS_BROKER_URL;

    await runWithChatId('chat-no-url', async () => {
      await expect(startAuthorization()).rejects.toThrow(
        'FINOS_BROKER_URL is not configured for this extension.',
      );
    });
  });

  it('throws NotConnectedError when the broker returns 401', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-401', async () => {
      await expect(startAuthorization()).rejects.toThrow(NotConnectedError);
    });
  });

  it('throws a generic error when the broker returns a non-401 error status', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-500', async () => {
      await expect(startAuthorization()).rejects.toThrow(
        'QuickBooks service returned 500.',
      );
    });
  });

  it('wraps a network failure from a broker POST call', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockRejectedValueOnce(new Error('ECONNRESET'));
    global.fetch = fetchMock;

    await runWithChatId('chat-net-post', async () => {
      await expect(startAuthorization()).rejects.toThrow(
        'Could not reach the QuickBooks service: ECONNRESET',
      );
    });
  });

  it('wraps a network failure from the broker GET /token call', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-neterr',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-neterr',
          realm_id: 'realm-neterr',
        }),
      } as Response)
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));
    global.fetch = fetchMock;

    await runWithChatId('chat-net-token', async () => {
      await startAuthorization();
      await completeAuthorization();
      await expect(getBrokerAuth()).rejects.toThrow(
        'Could not reach the QuickBooks service: ETIMEDOUT',
      );
    });
  });

  it('wraps a non-Error network failure from a broker POST call', async () => {
    // fetch/AbortSignal can reject with a non-Error value (e.g. a DOMException-like
    // object or a bare string); the `instanceof Error` check has an else branch for it.
    const fetchMock = jest.fn<typeof fetch>().mockRejectedValueOnce('boom');
    global.fetch = fetchMock;

    await runWithChatId('chat-net-post-nonerror', async () => {
      await expect(startAuthorization()).rejects.toThrow(
        'Could not reach the QuickBooks service: boom',
      );
    });
  });

  it('wraps a non-Error network failure from the broker GET /token call', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-neterr-nonerror',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-neterr-nonerror',
          realm_id: 'realm-neterr-nonerror',
        }),
      } as Response)
      .mockRejectedValueOnce('kaboom');
    global.fetch = fetchMock;

    await runWithChatId('chat-net-token-nonerror', async () => {
      await startAuthorization();
      await completeAuthorization();
      await expect(getBrokerAuth()).rejects.toThrow(
        'Could not reach the QuickBooks service: kaboom',
      );
    });
  });

  it('returns pending when the poll completes without a device credential', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-no-cred',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'complete' }), // device_credential omitted
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-no-cred', async () => {
      await startAuthorization();
      const result = await completeAuthorization();
      expect(result).toEqual({ status: 'pending' });
    });
  });

  it('falls back to "unknown" as the realmId when the poll response omits it', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-no-realm',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-no-realm',
          // realm_id deliberately omitted
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-no-realm', async () => {
      await startAuthorization();
      const result = await completeAuthorization();
      expect(result).toEqual({ status: 'connected', realmId: 'unknown' });
    });
  });

  it('reuses a cached token on a second call without refetching', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-cache-reuse',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-cache-reuse',
          realm_id: 'realm-cache-reuse',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'token-cached',
          realm_id: 'realm-cache-reuse',
          api_base: 'https://quickbooks.api.intuit.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-cache-reuse', async () => {
      await startAuthorization();
      await completeAuthorization();
      const first = await getBrokerAuth();
      const second = await getBrokerAuth();
      expect(second).toEqual(first);
      expect(second.accessToken).toBe('token-cached');
    });

    // Only 3 broker calls total (authorize, poll, token) — the second
    // getBrokerAuth() call must reuse the cached token, not refetch.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns pending status when the poll has not completed yet', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-pending',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'pending' }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-pending', async () => {
      await startAuthorization();
      const result = await completeAuthorization();
      expect(result).toEqual({ status: 'pending' });
    });
  });

  it('throws when the broker returns an incomplete token payload', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          auth_url: 'https://mock-broker.example.com/oauth/start',
          poll_token: 'poll-incomplete',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'cred-incomplete',
          realm_id: 'realm-incomplete',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // access_token and realm_id both deliberately omitted
          api_base: 'https://quickbooks.api.intuit.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      } as Response);
    global.fetch = fetchMock;

    await runWithChatId('chat-incomplete', async () => {
      await startAuthorization();
      await completeAuthorization();
      await expect(getBrokerAuth()).rejects.toThrow(
        'QuickBooks service returned an incomplete response.',
      );
    });
  });

  // ---- TTL eviction sweep --------------------------------------------------

  it('evicts a session whose lastAccessed is older than the TTL when the sweep fires', async () => {
    jest.useFakeTimers();
    try {
      process.env = {
        ...originalEnv,
        FINOS_BROKER_URL: 'https://mock-broker.example.com',
        FINOS_SESSION_TTL_SECONDS: '1',
      };

      jest.resetModules();
      const chatContextModule = await import('../../../src/helpers/chat-context.js');
      const brokerAuthModule = await import('../../../src/clients/broker-auth.js');

      const fetchMock = jest
        .fn<typeof fetch>()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            auth_url: 'https://mock-broker.example.com/oauth/start',
            poll_token: 'poll-ttl',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            status: 'complete',
            device_credential: 'cred-ttl',
            realm_id: 'realm-ttl',
          }),
        } as Response);
      global.fetch = fetchMock;

      await chatContextModule.runWithChatId('chat-ttl', async () => {
        await brokerAuthModule.startAuthorization();
        await brokerAuthModule.completeAuthorization();
        expect(brokerAuthModule.isConnected()).toBe(true);
      });

      // Fire the 5-minute sweep interval; the 1s TTL configured above means
      // the session recorded above is long stale by the time it runs.
      jest.advanceTimersByTime(5 * 60 * 1000);

      chatContextModule.runWithChatId('chat-ttl', () => {
        expect(brokerAuthModule.isConnected()).toBe(false);
      });

      brokerAuthModule._resetAllSessions();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a session whose lastAccessed is within the TTL when the sweep fires', async () => {
    jest.useFakeTimers();
    try {
      process.env = {
        ...originalEnv,
        FINOS_BROKER_URL: 'https://mock-broker.example.com',
        // Default (2h) TTL — far longer than the single sweep interval below.
      };

      jest.resetModules();
      const chatContextModule = await import('../../../src/helpers/chat-context.js');
      const brokerAuthModule = await import('../../../src/clients/broker-auth.js');

      const fetchMock = jest
        .fn<typeof fetch>()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            auth_url: 'https://mock-broker.example.com/oauth/start',
            poll_token: 'poll-fresh',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            status: 'complete',
            device_credential: 'cred-fresh',
            realm_id: 'realm-fresh',
          }),
        } as Response);
      global.fetch = fetchMock;

      await chatContextModule.runWithChatId('chat-fresh', async () => {
        await brokerAuthModule.startAuthorization();
        await brokerAuthModule.completeAuthorization();
      });

      // One sweep interval elapses; the default 2h TTL means this session is
      // nowhere near stale, so the sweep's delete branch must not fire for it.
      jest.advanceTimersByTime(5 * 60 * 1000);

      chatContextModule.runWithChatId('chat-fresh', () => {
        expect(brokerAuthModule.isConnected()).toBe(true);
      });

      brokerAuthModule._resetAllSessions();
    } finally {
      jest.useRealTimers();
    }
  });
});
