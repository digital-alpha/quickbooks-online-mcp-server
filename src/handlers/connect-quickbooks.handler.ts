import { startAuthorization } from "../clients/broker-auth.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export async function connectQuickbooks(): Promise<ToolResponse<any>> {
  try {
    const { authUrl } = await startAuthorization();
    return {
      result: {
        authorization_link: `[Connect to QuickBooks](${authUrl})`,
        authorization_url: authUrl,
        next_step:
          "Present the authorization link to the user as a Markdown hyperlink formatted as [Connect to QuickBooks](" +
          authUrl +
          "). Ask the user to click the link and sign in to QuickBooks. " +
          "When they confirm they have finished, call finish_quickbooks_connection. " +
          "Do not display the raw URL with query parameters.",
      },
      isError: false,
      error: null,
    };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
