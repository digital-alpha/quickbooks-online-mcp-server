import { startAuthorization } from "../clients/broker-auth.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export async function connectQuickbooks(): Promise<ToolResponse<any>> {
  try {
    const { authUrl } = await startAuthorization();
    return {
      result: {
        authorization_url: authUrl,
        next_step:
          "Ask the user to open the authorization URL and sign in to QuickBooks. " +
          "When they confirm they have finished, call finish_quickbooks_connection. " +
          "Do not ask them to copy or paste anything.",
      },
      isError: false,
      error: null,
    };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
