import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { createQuickbooksBudget } = await import('../../../src/handlers/create-quickbooks-budget.handler.js');

describe('createQuickbooksBudget Handler', () => {
  beforeEach(() => {
    resetAllMocks();
    mockQuickBooksInstance.createBudget = jest.fn() as any;
  });

  it('should create a budget using snake_case input fields', async () => {
    const mockCreatedBudget = {
      Id: '101',
      Name: 'FY2026 Marketing',
      BudgetType: 'ProfitAndLoss',
      BudgetEntryType: 'Monthly',
      StartDate: '2026-01-01',
      EndDate: '2026-12-31',
      Active: true,
      BudgetDetail: [
        {
          BudgetDate: '2026-01-01',
          Amount: 5000,
          AccountRef: { value: '80', name: 'Advertising' },
        },
      ],
    };

    mockQuickBooksInstance.createBudget.mockImplementation((payload: any, cb: any) => {
      expect(payload.Name).toBe('FY2026 Marketing');
      expect(payload.BudgetType).toBe('ProfitAndLoss');
      expect(payload.BudgetEntryType).toBe('Monthly');
      expect(payload.StartDate).toBe('2026-01-01');
      expect(payload.EndDate).toBe('2026-12-31');
      expect(payload.Active).toBe(true);
      expect(payload.BudgetDetail[0]).toEqual({
        budget_date: '2026-01-01',
        amount: 5000,
        account_id: '80',
        account_name: 'Advertising',
        BudgetDate: '2026-01-01',
        Amount: 5000,
        AccountRef: { value: '80', name: 'Advertising' },
      });
      cb(null, mockCreatedBudget);
    });

    const result = await createQuickbooksBudget({
      name: 'FY2026 Marketing',
      budget_type: 'ProfitAndLoss',
      budget_entry_type: 'Monthly',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      active: true,
      budget_detail: [
        {
          budget_date: '2026-01-01',
          amount: 5000,
          account_id: '80',
          account_name: 'Advertising',
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.result).toEqual(mockCreatedBudget);
  });

  it('should create a budget using PascalCase input fields', async () => {
    const mockCreatedBudget = { Id: '102', Name: 'Q3 Operations' };
    mockQuickBooksInstance.createBudget.mockImplementation((payload: any, cb: any) => {
      expect(payload.Name).toBe('Q3 Operations');
      cb(null, mockCreatedBudget);
    });

    const result = await createQuickbooksBudget({
      Name: 'Q3 Operations',
      BudgetType: 'ProfitAndLoss',
    });

    expect(result.isError).toBe(false);
    expect(result.result).toEqual(mockCreatedBudget);
  });

  it('should fall back to HTTP fetch when createBudget is not defined on instance', async () => {
    const mockCreatedBudget = { Id: '103', Name: 'Fetch Fallback Test' };

    delete (mockQuickBooksInstance as any).createBudget;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (jest.fn() as any).mockResolvedValue({
      ok: true,
      json: async () => ({ Budget: mockCreatedBudget }),
    });

    const result = await createQuickbooksBudget({
      name: 'Fetch Fallback Test',
    });

    expect(result.isError).toBe(false);
    expect(result.result).toEqual(mockCreatedBudget);

    globalThis.fetch = originalFetch;
  });

  it('should handle API errors properly', async () => {
    mockQuickBooksInstance.createBudget.mockImplementation((_payload: any, cb: any) => {
      cb(new Error('Budget creation failed'), null);
    });

    const result = await createQuickbooksBudget({
      name: 'Invalid Budget',
    });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('Budget creation failed');
  });
});
