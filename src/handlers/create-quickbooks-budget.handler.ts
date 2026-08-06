import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import QuickBooks from "node-quickbooks";

// Ensure createBudget is monkey-patched onto QuickBooks.prototype for node-quickbooks instances
if (QuickBooks && QuickBooks.prototype && !(QuickBooks.prototype as any).createBudget) {
  (QuickBooks.prototype as any).createBudget = function (this: any, budget: any, callback: any) {
    const baseUrl = this.endpoint || (this.useSandbox ? "https://sandbox-quickbooks.api.intuit.com/v3/company/" : "https://quickbooks.api.intuit.com/v3/company/");
    const realmId = this.realmId;
    const token = this.token;
    const minorversion = this.minorversion || 75;
    const url = `${baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"}${realmId}/budget?minorversion=${minorversion}`;

    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(budget),
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || json.Fault) {
          callback(json.Fault || json, null);
        } else {
          callback(null, json.Budget || json);
        }
      })
      .catch((err) => callback(err, null));
  };
}

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

    if (typeof (quickbooks as any).createBudget === "function") {
      return new Promise((resolve) => {
        (quickbooks as any).createBudget(payload, (err: any, created: any) => {
          if (err) {
            resolve({ result: null, isError: true, error: formatError(err) });
          } else {
            resolve({ result: created, isError: false, error: null });
          }
        });
      });
    }

    const { accessToken, realmId, isSandbox } = await QuickbooksClient.getAuthCredentials();
    const baseUrl = isSandbox ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
    const url = `${baseUrl}/v3/company/${realmId}/budget?minorversion=75`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseData = await res.json();
    if (!res.ok || responseData.Fault) {
      return {
        result: null,
        isError: true,
        error: formatError(responseData.Fault || responseData),
      };
    }

    return {
      result: responseData.Budget || responseData,
      isError: false,
      error: null,
    };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
