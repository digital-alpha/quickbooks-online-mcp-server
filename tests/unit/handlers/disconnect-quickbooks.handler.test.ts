import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { runWithChatId } from '../../../src/helpers/chat-context.js';
import { disconnectQuickbooksHandler } from '../../../src/handlers/disconnect-quickbooks.handler.js';
import { disconnectQuickbooks, isConnected } from '../../../src/clients/broker-auth.js';

describe('disconnectQuickbooksHandler', () => {
  it('should disconnect successfully and return status disconnected', async () => {
    const result = await runWithChatId('test-chat', () => disconnectQuickbooksHandler());
    expect(result.isError).toBe(false);
    expect(result.result?.status).toBe('disconnected');
    runWithChatId('test-chat', () => {
      expect(isConnected()).toBe(false);
    });
  });
});
