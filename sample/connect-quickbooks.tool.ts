import { connectQuickbooks } from "../handlers/connect-quickbooks.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "connect_quickbooks";
const toolDescription =
  "Start authorizing QuickBooks Online. Returns a URL for the user to open and " +
  "sign in. Use this when QuickBooks is not connected, or when a QuickBooks " +
  "call fails because the connection is no longer valid. After the user " +
  "confirms they have signed in, call finish_quickbooks_connection.";
const toolSchema = z.object({});

const toolHandler = async (_args: any) => {
  const response = await connectQuickbooks();
  if (response.isError)
    return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(response.result, null, 2) },
    ],
  };
};

export const ConnectQuickbooksTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
