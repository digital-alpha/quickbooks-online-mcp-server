import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { runWithChatId } from '../../../src/helpers/chat-context.js';
import { _resetAllSessions } from '../../../src/clients/broker-auth.js';
import { ConnectQuickbooksTool } from '../../../src/tools/connect-quickbooks.tool.js';

describe('ConnectQuickbooksTool', () => {
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

  it('has correct tool metadata and describes both environment values', () => {
    expect(ConnectQuickbooksTool.name).toBe('connect_quickbooks');
    expect(ConnectQuickbooksTool.description).toContain('sandbox');
    expect(ConnectQuickbooksTool.description).toContain('production');
  });

  it('accepts an empty params object (environment optional)', () => {
    const parseResult = ConnectQuickbooksTool.schema.safeParse({});
    expect(parseResult.success).toBe(true);
  });

  it('accepts an explicit "sandbox" environment', () => {
    const parseResult = ConnectQuickbooksTool.schema.safeParse({ environment: 'sandbox' });
    expect(parseResult.success).toBe(true);
  });

  it('accepts an explicit "production" environment', () => {
    const parseResult = ConnectQuickbooksTool.schema.safeParse({ environment: 'production' });
    expect(parseResult.success).toBe(true);
  });

  it('rejects an unrecognized environment value', () => {
    const parseResult = ConnectQuickbooksTool.schema.safeParse({ environment: 'staging' });
    expect(parseResult.success).toBe(false);
  });

  it('executes the handler successfully and returns the authorization link as content', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        auth_url: 'https://mock-broker.example.com/oauth/start',
        poll_token: 'poll-tool-success',
      }),
    } as Response);
    global.fetch = fetchMock;

    const result = await runWithChatId('chat-tool-connect', () =>
      ConnectQuickbooksTool.handler(
        { params: { environment: 'production' } } as any,
        {} as any,
      ),
    );

    expect(result.content[0].text).toContain('authorization_url');
    expect(result.content[0].text).toContain('https://mock-broker.example.com/oauth/start');
  });

  it('returns error content when the handler fails', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockRejectedValueOnce(new Error('broker down'));
    global.fetch = fetchMock;

    const result = await runWithChatId('chat-tool-connect-fail', () =>
      ConnectQuickbooksTool.handler({ params: {} } as any, {} as any),
    );

    expect(result.content[0].text).toContain('Error:');
  });
});
