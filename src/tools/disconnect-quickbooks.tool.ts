import { disconnectQuickbooksHandler } from "../handlers/disconnect-quickbooks.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "disconnect_quickbooks";
const toolDescription =
  "Disconnect the current QuickBooks Online account and clear stored local credentials " +
  "and cached authorization tokens. Call this when the user requests to log out, disconnect, " +
  "or switch to another QuickBooks Online company or client account.";
const toolSchema = z.object({});

const toolHandler = async (_args: any) => {
  const response = await disconnectQuickbooksHandler();
  if (response.isError)
    return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(response.result, null, 2) },
    ],
  };
};

export const DisconnectQuickbooksTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
