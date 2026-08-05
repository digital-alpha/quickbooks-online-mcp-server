import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import QuickBooks from "node-quickbooks";

export interface BudgetDetailInput {
  BudgetDate?: string;
  budget_date?: string;
  Amount?: number;
  amount?: number;
  AccountRef?: { value: string; name?: string };
  account_id?: string;
  account_name?: string;
  CustomerRef?: { value: string; name?: string };
  customer_id?: string;
  ClassRef?: { value: string; name?: string };
  class_id?: string;
  DepartmentRef?: { value: string; name?: string };
  department_id?: string;
  LocationRef?: { value: string; name?: string };
  location_id?: string;
  [key: string]: any;
}

export interface CreateBudgetInput {
  Name?: string;
  name?: string;
  BudgetType?: string;
  budget_type?: string;
  BudgetEntryType?: string;
  budget_entry_type?: string;
  StartDate?: string;
  start_date?: string;
  EndDate?: string;
  end_date?: string;
  Active?: boolean;
  active?: boolean;
  BudgetDetail?: BudgetDetailInput[];
  budget_detail?: BudgetDetailInput[];
  [key: string]: any;
}

export async function createQuickbooksBudget(data: CreateBudgetInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    const payload: any = {
      Name: data.Name || data.name,
      BudgetType: data.BudgetType || data.budget_type || "ProfitAndLoss",
    };

    if (data.BudgetEntryType || data.budget_entry_type) {
      payload.BudgetEntryType = data.BudgetEntryType || data.budget_entry_type;
    }
    if (data.StartDate || data.start_date) {
      payload.StartDate = data.StartDate || data.start_date;
    }
    if (data.EndDate || data.end_date) {
      payload.EndDate = data.EndDate || data.end_date;
    }
    if (data.Active !== undefined || data.active !== undefined) {
      payload.Active = data.Active !== undefined ? data.Active : data.active;
    }

    const rawDetails = data.BudgetDetail || data.budget_detail;
    if (Array.isArray(rawDetails)) {
      payload.BudgetDetail = rawDetails.map((detail: BudgetDetailInput) => {
        const line: any = {
          BudgetDate: detail.BudgetDate || detail.budget_date,
          Amount: detail.Amount !== undefined ? detail.Amount : detail.amount,
        };

        if (detail.AccountRef) {
          line.AccountRef = detail.AccountRef;
        } else if (detail.account_id) {
          line.AccountRef = { value: detail.account_id, name: detail.account_name };
        }

        if (detail.CustomerRef) {
          line.CustomerRef = detail.CustomerRef;
        } else if (detail.customer_id) {
          line.CustomerRef = { value: detail.customer_id };
        }

        if (detail.ClassRef) {
          line.ClassRef = detail.ClassRef;
        } else if (detail.class_id) {
          line.ClassRef = { value: detail.class_id };
        }

        if (detail.DepartmentRef) {
          line.DepartmentRef = detail.DepartmentRef;
        } else if (detail.department_id) {
          line.DepartmentRef = { value: detail.department_id };
        }

        if (detail.LocationRef) {
          line.LocationRef = detail.LocationRef;
        } else if (detail.location_id) {
          line.LocationRef = { value: detail.location_id };
        }

        return { ...detail, ...line };
      });
    }

    return new Promise((resolve) => {
      const createFn = (quickbooks as any).createBudget
        ? (quickbooks as any).createBudget.bind(quickbooks)
        : (budgetPayload: any, cb: any) => (QuickBooks as any).create(quickbooks, "budget", budgetPayload, cb);

      createFn(payload, (err: any, created: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          resolve({ result: created, isError: false, error: null });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
