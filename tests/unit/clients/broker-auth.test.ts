import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  isConnected,
  startAuthorization,
  completeAuthorization,
  disconnectQuickbooks,
  getBrokerAuth,
  invalidateBrokerAuth,
  NotConnectedError,
} from '../../../src/clients/broker-auth.js';

describe('broker-auth in-memory session handling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      FINOS_BROKER_URL: 'https://mock-broker.example.com',
    };
    delete process.env.FINOS_CREDENTIAL;
    disconnectQuickbooks();
  });

  afterEach(() => {
    process.env = originalEnv;
    disconnectQuickbooks();
  });

  it('starts unconnected in runtime memory', () => {
    expect(isConnected()).toBe(false);
  });

  it('throws NotConnectedError when calling getBrokerAuth without authorization', async () => {
    await expect(getBrokerAuth()).rejects.toThrow(NotConnectedError);
  });

  it('starts authorization and manages pending state in memory', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        auth_url: 'https://mock-broker.example.com/oauth/start',
        poll_token: 'test-poll-token',
      }),
    } as Response);
    global.fetch = fetchMock;

    const startResult = await startAuthorization();
    expect(startResult.authUrl).toBe('https://mock-broker.example.com/oauth/start');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mock-broker.example.com/authorize',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('completes authorization and saves credential in runtime memory', async () => {
    // 1. Start auth
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
      // 2. Poll complete
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'complete',
          device_credential: 'device-cred-abc',
          realm_id: '987654321',
        }),
      } as Response)
      // 3. Token exchange
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

  it('disconnects and clears runtime memory completely', async () => {
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

    await startAuthorization();
    await completeAuthorization();
    expect(isConnected()).toBe(true);

    disconnectQuickbooks();

    expect(isConnected()).toBe(false);
    await expect(getBrokerAuth()).rejects.toThrow(NotConnectedError);
  });
});
