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
          "QuickBooks has been disconnected for this conversation. Credentials and " +
          "cached tokens for this session have been cleared. Other conversations are " +
          "unaffected. You can use connect_quickbooks to authorize again.",
      },
      isError: false,
      error: null,
    };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
