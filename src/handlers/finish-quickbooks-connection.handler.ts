import { completeAuthorization } from "../clients/broker-auth.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export async function finishQuickbooksConnection(): Promise<ToolResponse<any>> {
  try {
    const result = await completeAuthorization();

    if (result.status === "connected") {
      return {
        result: {
          status: "connected",
          realm_id: result.realmId,
          message: "QuickBooks is connected. No restart is needed.",
        },
        isError: false,
        error: null,
      };
    }

    if (result.status === "pending") {
      return {
        result: {
          status: "pending",
          message:
            "Authorization has not completed yet. If the user is still signing " +
            "in, wait for them to confirm and then call this tool again.",
        },
        isError: false,
        error: null,
      };
    }

    return {
      result: {
        status: "expired",
        message:
          "No authorization is in progress, or it expired. Call " +
          "connect_quickbooks to start a new one.",
      },
      isError: false,
      error: null,
    };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
