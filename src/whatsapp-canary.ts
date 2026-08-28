import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { normalizePhone } from './common/utils/phone.util';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppClientService } from './whatsapp/whatsapp-client.service';
import { WhatsAppConfigService } from './whatsapp/whatsapp-config.service';

const CONFIRM = '--confirm-single-send';
const TEST_MESSAGE = 'Test connection message. No response is required.';

@Module({
  imports: [PrismaModule],
  providers: [WhatsAppConfigService, WhatsAppClientService],
})
class WhatsAppCanaryModule {}

function parseRecipient() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !args.includes(CONFIRM)) {
    throw new Error(
      'Usage: npm run whatsapp:canary -- --confirm-single-send <single-test-number>',
    );
  }
  const raw = args.find((arg) => arg !== CONFIRM);
  if (!raw || /[,;\s]/.test(raw)) {
    throw new Error('Exactly one test number is required');
  }
  const phone = normalizePhone(raw);
  if (!phone) throw new Error('Invalid test number');
  return phone;
}

async function waitForConnected(client: WhatsAppClientService) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await client.getStatus();
    if (status.connected) return status.generation;
    if (status.state === 'ERROR') throw new Error('WhatsApp runtime error');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('WhatsApp did not become connected within 60 seconds');
}

async function main() {
  const phone = parseRecipient();
  if (
    process.env.WHATSAPP_TRANSPORT &&
    process.env.WHATSAPP_TRANSPORT !== 'whatsapp-webjs'
  ) {
    throw new Error('Canary supports whatsapp-webjs only');
  }
  const recipientHash = createHash('sha256')
    .update(phone)
    .digest('hex')
    .slice(0, 16);
  const app = await NestFactory.createApplicationContext(WhatsAppCanaryModule, {
    logger: ['error', 'warn'],
  });
  try {
    const client = app.get(WhatsAppClientService);
    const generation = await waitForConnected(client);
    const candidate = `${phone.slice(1)}@c.us`;
    const recipient = await client.resolveRecipient(candidate);
    process.stdout.write(
      `${JSON.stringify({ recipientHash, generation, canonicalDomain: recipient.canonicalDomain, resolutionSource: recipient.resolutionSource, registered: recipient.registered })}\n`,
    );
    if (!recipient.registered || !recipient.canonicalChatId) {
      throw new Error('Recipient was not resolved by provider');
    }

    let created = false;
    let ack: number | null = null;
    client.onMessageCreate((message, eventGeneration) => {
      if (eventGeneration === generation && message.fromMe) created = true;
      return Promise.resolve();
    });
    client.onAck((_message, providerAck, eventGeneration) => {
      if (eventGeneration === generation) ack = Number(providerAck);
      return Promise.resolve();
    });
    const result = await client.sendText(
      recipient.canonicalChatId,
      TEST_MESSAGE,
    );
    const providerId = WhatsAppClientService.externalMessageIdentity(result);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && ack === null) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const submitted = providerId.source !== 'FALLBACK_ID' || created;
    process.stdout.write(
      `${JSON.stringify({ recipientHash, generation, submitted, messageCreate: created, providerIdPresent: providerId.source !== 'FALLBACK_ID', ack })}\n`,
    );
    if (!submitted || ack === null || ack < 0) process.exitCode = 2;
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ event: 'WHATSAPP_CANARY_FAILED', errorName: error instanceof Error ? error.name : 'UnknownError', errorCode: error instanceof Error ? error.message : 'Unknown failure' })}\n`,
  );
  process.exitCode = 1;
});
