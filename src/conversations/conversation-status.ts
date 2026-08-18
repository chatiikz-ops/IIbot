import { ConversationStatus } from '../generated/prisma/enums';

export const TERMINAL_CONVERSATION_STATUSES = new Set<ConversationStatus>([
  ConversationStatus.HANDOFF_REQUIRED,
  ConversationStatus.QUALIFIED,
  ConversationStatus.REJECTED,
  ConversationStatus.CLOSED,
]);

export function isTerminalConversationStatus(status: ConversationStatus) {
  return TERMINAL_CONVERSATION_STATUSES.has(status);
}
