import { disconnectQuickbooks } from "../clients/broker-auth.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export async function disconnectQuickbooksHandler(): Promise<ToolResponse<any>> {
  try {
    disconnectQuickbooks();
    return {
      result: {
        status: "disconnected",
        message:
          "QuickBooks has been disconnected successfully. Stored credentials and " +
          "cached tokens have been cleared. You can now use connect_quickbooks " +
          "to authorize another account.",
      },
      isError: false,
      error: null,
    };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
