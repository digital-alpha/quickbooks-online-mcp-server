import { connectQuickbooks } from "../handlers/connect-quickbooks.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "connect_quickbooks";
const toolDescription =
  "Start authorizing QuickBooks Online. Returns a URL for the user to open and " +
  "sign in. Use this when QuickBooks is not connected, or when a QuickBooks " +
  "call fails because the connection is no longer valid. After the user " +
  "confirms they have signed in, call finish_quickbooks_connection. " +
  "Set environment to choose which QuickBooks company this connects: " +
  "'sandbox' (the default) connects a test/developer company with no real " +
  "financial data — use this unless the user clearly wants their real " +
  "books. 'production' connects the user's actual QuickBooks Online " +
  "company with real financial data — only use this when the user " +
  "explicitly asks to connect their real/live/production QuickBooks account.";
const toolSchema = z.object({
  environment: z
    .enum(["sandbox", "production"])
    .optional()
    .describe(
      "Which QuickBooks company to connect: 'sandbox' (default, a test " +
        "company with no real data) or 'production' (the user's real " +
        "QuickBooks Online company). Ask the user which one they mean if " +
        "it isn't clear from context.",
    ),
});

const toolHandler = async ({ params }: any) => {
  const response = await connectQuickbooks(params?.environment);
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
