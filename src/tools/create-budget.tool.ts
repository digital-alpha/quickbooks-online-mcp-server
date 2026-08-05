import { createQuickbooksBudget } from "../handlers/create-quickbooks-budget.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "create_budget";
const toolDescription =
  "Create a budget in QuickBooks Online with optional BudgetDetail line items " +
  "(AccountRef/account_id, Amount/amount, BudgetDate/budget_date, ClassRef/class_id, CustomerRef/customer_id, DepartmentRef/department_id, LocationRef/location_id).";

const budgetDetailSchema = z.object({
  budget_date: z.string().optional().describe("Budget line date in YYYY-MM-DD format"),
  BudgetDate: z.string().optional().describe("Budget line date in YYYY-MM-DD format"),
  amount: z.number().optional().describe("Budget amount for this period/account"),
  Amount: z.number().optional().describe("Budget amount for this period/account"),
  account_id: z.string().optional().describe("Account ID for this line item"),
  account_name: z.string().optional().describe("Account name for this line item"),
  AccountRef: z.object({ value: z.string(), name: z.string().optional() }).optional(),
  customer_id: z.string().optional().describe("Customer ID for this line item"),
  CustomerRef: z.object({ value: z.string(), name: z.string().optional() }).optional(),
  class_id: z.string().optional().describe("Class ID for this line item"),
  ClassRef: z.object({ value: z.string(), name: z.string().optional() }).optional(),
  department_id: z.string().optional().describe("Department ID for this line item"),
  DepartmentRef: z.object({ value: z.string(), name: z.string().optional() }).optional(),
  location_id: z.string().optional().describe("Location ID for this line item"),
  LocationRef: z.object({ value: z.string(), name: z.string().optional() }).optional(),
}).passthrough();

const toolSchema = z.object({
  name: z.string().optional().describe("Budget name"),
  Name: z.string().optional().describe("Budget name"),
  budget_type: z.string().optional().describe("Budget type (e.g. ProfitAndLoss, BalanceSheet)"),
  BudgetType: z.string().optional().describe("Budget type (e.g. ProfitAndLoss, BalanceSheet)"),
  budget_entry_type: z.string().optional().describe("Budget entry type (e.g. Monthly, Quarterly, Annual)"),
  BudgetEntryType: z.string().optional().describe("Budget entry type (e.g. Monthly, Quarterly, Annual)"),
  start_date: z.string().optional().describe("Start date in YYYY-MM-DD format"),
  StartDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
  end_date: z.string().optional().describe("End date in YYYY-MM-DD format"),
  EndDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
  active: z.boolean().optional().describe("Active status"),
  Active: z.boolean().optional().describe("Active status"),
  budget_detail: z.array(budgetDetailSchema).optional().describe("Array of budget detail line items"),
  BudgetDetail: z.array(budgetDetailSchema).optional().describe("Array of budget detail line items"),
}).passthrough();

const toolHandler = async ({ params }: any) => {
  const response = await createQuickbooksBudget(params || {});
  if (response.isError) {
    return { content: [{ type: "text" as const, text: `Error creating budget: ${response.error}` }] };
  }
  return {
    content: [
      { type: "text" as const, text: `Budget created successfully:` },
      { type: "text" as const, text: JSON.stringify(response.result, null, 2) },
    ],
  };
};

export const CreateBudgetTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
