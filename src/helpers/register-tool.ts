import { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";
import { runWithChatId } from "./chat-context.js";

/**
 * Defines CRUD categories for tools
 */
export const CRUD_CATEGORY = {
  WRITE:  "WRITE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
  READ:   "READ",
} as const;

export type CrudCategory = typeof CRUD_CATEGORY[keyof typeof CRUD_CATEGORY];

/** 
 * Maps each CRUD category to its corresponding environment variable for disabling tools.
 */
export const DISABLE_ENV = {
  [CRUD_CATEGORY.WRITE]:  "QUICKBOOKS_DISABLE_WRITE",
  [CRUD_CATEGORY.UPDATE]: "QUICKBOOKS_DISABLE_UPDATE",
  [CRUD_CATEGORY.DELETE]: "QUICKBOOKS_DISABLE_DELETE",
} as const;

/** 
 * Maps every non-READ verb prefix to its category. Handles both underscore
 * and legacy hyphen separator variants (e.g. create-bill, update-vendor).
 * Insertion order is preserved in V8; all prefixes are distinct so order
 * does not affect correctness.
 */
export const PREFIX_CATEGORY_MAP: Record<string, CrudCategory> = {
  "create_": CRUD_CATEGORY.WRITE,
  "create-": CRUD_CATEGORY.WRITE,
  "update_": CRUD_CATEGORY.UPDATE,
  "update-": CRUD_CATEGORY.UPDATE,
  "delete_": CRUD_CATEGORY.DELETE,
  "delete-": CRUD_CATEGORY.DELETE,
};

/** 
 * Determines the CRUD category of a tool based on its name prefix.
 * Defaults to READ if no prefix matches.
 */
export function getCrudCategory(toolName: string): CrudCategory {
  for (const [prefix, category] of Object.entries(PREFIX_CATEGORY_MAP)) {
    if (toolName.startsWith(prefix)) return category;
  }
  return CRUD_CATEGORY.READ;
}

/** 
 * Checks if a tool is disabled based on its CRUD category and corresponding environment variable.
 * READ tools are never disabled.
 */
export function isToolDisabled(toolName: string): boolean {
  const category = getCrudCategory(toolName);
  if (category === CRUD_CATEGORY.READ) return false;
  return process.env[DISABLE_ENV[category]] === "true";
}

const CHAT_ID_DESCRIPTION =
  'Stable identifier for the current conversation. On your first QuickBooks ' +
  'tool call in a conversation, generate a random UUID and use it here. For ' +
  'every later QuickBooks call in the same conversation, reuse that exact ' +
  'same value — read it back from your earlier tool call rather than ' +
  'generating a new one. Never reuse a value from a different conversation.';

/** 
 * Registers a tool with the MCP server if it is not disabled.
 * Tools are categorized by their name prefix (e.g. create_, update_, delete_).
 * The corresponding environment variable (e.g. QUICKBOOKS_DISABLE_WRITE) determines if the tool is registered.
 *
 * Every registered tool receives an additional `chat_id` parameter (sibling of `params`)
 * that the model must supply. The handler runs inside a chat context so broker-auth
 * can resolve per-conversation session state via AsyncLocalStorage.
 */
export function RegisterTool<T extends z.ZodType<any, any>>(
  server: McpServer,
  toolDefinition: ToolDefinition<T>
) {
  if (isToolDisabled(toolDefinition.name)) return;

  const schema: z.ZodRawShape = {
    params: toolDefinition.schema,
    chat_id: z.string().min(1).describe(CHAT_ID_DESCRIPTION),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(toolDefinition.name, toolDefinition.description, schema, ((args: any, extra: any) =>
    runWithChatId(args.chat_id as string, () =>
      (toolDefinition.handler as CallableFunction)(args, extra),
    )) as ToolCallback<z.ZodRawShape>,
  );
}