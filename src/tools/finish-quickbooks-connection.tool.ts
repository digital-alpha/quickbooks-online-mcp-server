import { finishQuickbooksConnection } from "../handlers/finish-quickbooks-connection.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "finish_quickbooks_connection";
const toolDescription =
  "Complete a QuickBooks authorization that was started with connect_quickbooks. " +
  "Call this once the user confirms they have signed in. Returns 'pending' if " +
  "they have not finished yet, in which case wait for them and call again.";
const toolSchema = z.object({});

const toolHandler = async (_args: any) => {
  const response = await finishQuickbooksConnection();
  if (response.isError)
    return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(response.result, null, 2) },
    ],
  };
};

export const FinishQuickbooksConnectionTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
