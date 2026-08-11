import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { runWithChatId } from '../../../src/helpers/chat-context.js';
import { connectQuickbooks } from '../../../src/handlers/connect-quickbooks.handler.js';
import { _resetAllSessions } from '../../../src/clients/broker-auth.js';

describe('connectQuickbooks handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      FINOS_BROKER_URL: 'https://mock-broker.example.com',
    };
    _resetAllSessions();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetAllSessions();
  });

  it('starts authorization with the default (sandbox) environment when none is given', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        auth_url: 'https://mock-broker.example.com/oauth/start',
        poll_token: 'poll-connect-default',
      }),
    } as Response);
    global.fetch = fetchMock;

    const result = await runWithChatId('chat-connect-default', () => connectQuickbooks());

    expect(result.isError).toBe(false);
    expect(result.result.authorization_url).toBe(
      'https://mock-broker.example.com/oauth/start',
    );
    expect(result.result.authorization_link).toContain('[Connect to QuickBooks]');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mock-broker.example.com/authorize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ environment: 'sandbox' }),
      }),
    );
  });

  it('passes an explicit environment through to startAuthorization', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        auth_url: 'https://mock-broker.example.com/oauth/start',
        poll_token: 'poll-connect-prod',
      }),
    } as Response);
    global.fetch = fetchMock;

    const result = await runWithChatId('chat-connect-prod', () =>
      connectQuickbooks('production'),
    );

    expect(result.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mock-broker.example.com/authorize',
      expect.objectContaining({
        body: JSON.stringify({ environment: 'production' }),
      }),
    );
  });

  it('returns an error result when startAuthorization fails', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockRejectedValueOnce(new Error('network down'));
    global.fetch = fetchMock;

    const result = await runWithChatId('chat-connect-fail', () => connectQuickbooks());

    expect(result.isError).toBe(true);
    expect(result.result).toBeNull();
    expect(result.error).toContain('Could not reach the QuickBooks service');
  });
});
