import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { CreateBudgetTool } = await import('../../../src/tools/create-budget.tool');

describe('CreateBudgetTool', () => {
  beforeEach(() => {
    resetAllMocks();
    mockQuickBooksInstance.createBudget = jest.fn() as any;
  });

  it('has correct tool metadata', () => {
    expect(CreateBudgetTool.name).toBe('create_budget');
    expect(CreateBudgetTool.description).toContain('Create a budget in QuickBooks Online');
  });

  it('validates schema correctly with budget inputs', () => {
    const input = {
      name: 'FY2026 Sales Budget',
      budget_type: 'ProfitAndLoss',
      budget_entry_type: 'Monthly',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      budget_detail: [
        {
          budget_date: '2026-01-01',
          amount: 10000,
          account_id: '45',
        },
      ],
    };

    const parseResult = CreateBudgetTool.schema.safeParse(input);
    expect(parseResult.success).toBe(true);
  });

  it('executes handler successfully when tool handler is invoked', async () => {
    const mockCreated = { Id: '201', Name: 'FY2026 Sales Budget' };
    mockQuickBooksInstance.createBudget.mockImplementation((payload: any, cb: any) => cb(null, mockCreated));

    const result = await CreateBudgetTool.handler(
      {
        params: {
          name: 'FY2026 Sales Budget',
          budget_type: 'ProfitAndLoss',
        },
      },
      {} as any
    );

    expect(result.content[0].text).toContain('Budget created successfully');
    expect(result.content[1].text).toContain('FY2026 Sales Budget');
  });

  it('returns error content when budget creation fails', async () => {
    mockQuickBooksInstance.createBudget.mockImplementation((payload: any, cb: any) =>
      cb(new Error('Permission denied'), null)
    );

    const result = await CreateBudgetTool.handler(
      {
        params: { name: 'Unauthorized Budget' },
      },
      {} as any
    );

    expect(result.content[0].text).toContain('Permission denied');
  });
});
