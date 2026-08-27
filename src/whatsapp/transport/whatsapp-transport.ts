import type { Message as WebMessage } from 'whatsapp-web.js';

export const WHATSAPP_TRANSPORT = Symbol('WHATSAPP_TRANSPORT');
export function selectWhatsAppTransport<T, U>(
  transport: string,
  webjs: T,
  wppconnect: U,
): T | U {
  return transport === 'wppconnect' ? wppconnect : webjs;
}
export type WhatsAppTransportName = 'whatsapp-webjs' | 'wppconnect';
export type TransportMessage = WebMessage;
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
