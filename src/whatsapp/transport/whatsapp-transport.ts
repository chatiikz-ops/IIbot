import type { Message as WebMessage } from 'whatsapp-web.js';

export const WHATSAPP_TRANSPORT = Symbol('WHATSAPP_TRANSPORT');
export function createWhatsAppTransportProviders<T, U>(
  transport: string | undefined,
  webjsProvider: T,
  wppconnectProvider: U,
) {
  const selected =
    transport?.trim() === 'wppconnect' ? wppconnectProvider : webjsProvider;
  return [selected, { provide: WHATSAPP_TRANSPORT, useExisting: selected }];
}
export function selectWhatsAppTransport<T, U>(
  transport: string,
  webjs: T,
  wppconnect: U,
): T | U {
  return transport === 'wppconnect' ? wppconnect : webjs;
}
export type WhatsAppTransportName = 'whatsapp-webjs' | 'wppconnect';
export type TransportMessage = WebMessage;
export type WhatsAppRecipientDomain = 'c.us' | 'lid' | 'unknown';
export type ResolvedWhatsAppRecipient = {
  candidateChatId: string;
  canonicalChatId: string | null;
  canonicalDomain: WhatsAppRecipientDomain;
  registered: boolean;
  resolutionSource: 'getNumberId' | 'provider' | 'fallback';
};
export type WhatsAppTransportState =
  | 'DISABLED'
  | 'IDLE'
  | 'STARTING'
  | 'QR_REQUIRED'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'DISCONNECTING'
  | 'LOGGING_OUT'
  | 'ERROR';

export interface WhatsAppTransport {
  initialize(): Promise<unknown>;
  reconnect(): Promise<unknown>;
  destroy(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
  logout(): Promise<unknown>;
  getStatus(): Promise<{
    enabled: boolean;
    state: WhatsAppTransportState;
    connected: boolean;
    generation: number;
    [key: string]: unknown;
  }>;
  getQr(): unknown;
  sendText(
    chatId: string,
    text: string,
  ): Promise<TransportMessage | null | undefined>;
  resolveRecipient(chatId: string): Promise<ResolvedWhatsAppRecipient>;
  isRegisteredUser(chatId: string): Promise<boolean>;
  resolveLidIdentity(lid: string): Promise<{
    lid: string;
    chatId: string;
    source: string;
  } | null>;
  onMessage(handler: (message: TransportMessage) => Promise<void>): void;
  onMessageCreate?(
    handler: (message: TransportMessage, generation: number) => Promise<void>,
  ): void;
  onAck(
    handler: (
      message: TransportMessage,
      ack: number,
      generation: number,
    ) => Promise<void>,
  ): void;
  getGeneration?(): number;
}
