import { AsyncLocalStorage } from 'node:async_hooks';

interface ChatContext {
  chatId: string;
}

const storage = new AsyncLocalStorage<ChatContext>();

/** Runs `fn` with `chatId` bound for the duration of the async call tree. */
export function runWithChatId<T>(chatId: string, fn: () => T): T {
  return storage.run({ chatId }, fn);
}

/**
 * The chat_id for the tool call currently executing.
 * Throws rather than silently falling back to a shared default: a missing
 * chat_id must never resolve to another chat's credential bucket.
 */
export function requireChatId(): string {
  const store = storage.getStore();
  if (!store?.chatId) {
    throw new Error(
      'No chat_id is bound for this call. Every QuickBooks tool requires a ' +
      'chat_id argument identifying the conversation.',
    );
  }
  return store.chatId;
}
