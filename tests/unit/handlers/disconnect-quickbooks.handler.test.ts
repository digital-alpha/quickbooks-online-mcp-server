import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { disconnectQuickbooksHandler } from '../../../src/handlers/disconnect-quickbooks.handler.js';
import { disconnectQuickbooks, isConnected } from '../../../src/clients/broker-auth.js';

describe('disconnectQuickbooksHandler', () => {
  it('should disconnect successfully and return status disconnected', async () => {
    const result = await disconnectQuickbooksHandler();
    expect(result.isError).toBe(false);
    expect(result.result?.status).toBe('disconnected');
    expect(isConnected()).toBe(false);
  });
});
