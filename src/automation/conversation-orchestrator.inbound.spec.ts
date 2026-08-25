/// <reference types="jest" />
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

import { BadGatewayException } from '@nestjs/common';
import { ConversationOrchestratorService } from './conversation-orchestrator.service';

jest.mock('../generated/prisma/client', () => ({ Prisma: {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('ConversationOrchestrator inbound replies', () => {
  const input = {
    contactId: 'contact-1',
    conversationId: 'conversation-1',
    messageId: 'client-message-1',
    whatsAppMessageId: 'wa-inbound-1',
  };
  const baseSettings = {
    enabled: true,
    autoReplyEnabled: true,
    campaignSendingEnabled: true,
    maxAutoRepliesPerConversation: 5,
    responseDelayMinSeconds: 0,
    responseDelayMaxSeconds: 0,
    workingHoursEnabled: false,
    workingHoursStart: null,
    workingHoursEnd: null,
    timezone: 'Asia/Almaty',
  };
  const settings: any = { get: jest.fn(() => Promise.resolve(baseSettings)) };
  const events: any = { create: jest.fn(() => Promise.resolve({})) };
  const delay: any = {
    scheduleConversation: jest.fn(() => Promise.resolve(true)),
  };
  const contacts: any = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: input.contactId,
        phone: '+77086810693',
        deletedAt: null,
        outreachEligible: true,
        crmProvider: 'UNKNOWN',
      }),
    ),
  };
  const conversations: any = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: input.conversationId,
        contactId: input.contactId,
        status: 'WAITING_CLIENT',
        strategyCode: 'BARBERSHOP_GENERAL',
      }),
    ),
    create: jest.fn(),
    ensureStrategy: jest.fn(),
    updateStatus: jest.fn(),
  };
  const messages: any = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: input.messageId,
        conversationId: input.conversationId,
        role: 'CLIENT',
      }),
    ),
    findUnprocessedClients: jest.fn(() =>
      Promise.resolve([
        {
          id: input.messageId,
          conversationId: input.conversationId,
          role: 'CLIENT',
          text: 'Сообщение клиента',
          aiRunId: null,
          createdAt: new Date('2026-08-13T13:00:00Z'),
        },
      ]),
    ),
    countByRole: jest.fn(() => Promise.resolve(1)),
    findLatestByRole: jest.fn(),
    findAiReply: jest.fn(),
  };
  const prompts: any = {
    getActivePromptByCode: jest.fn(() =>
      Promise.resolve({ version: { maxAssistantMessages: 5 } }),
    ),
  };
  const ai: any = {
    hasProcessedMessage: jest.fn(() => Promise.resolve(false)),
    processClientMessage: jest.fn(() =>
      Promise.resolve({
        run: { id: 'ai-run-1' },
        message: { id: 'ai-message-2', text: 'Отлично, продолжим.' },
        result: { action: 'CONTINUE' },
      }),
    ),
    generateFirstMessage: jest.fn(),
  };
  const whatsappClient: any = {
    getStatus: jest.fn(() =>
      Promise.resolve({ connected: true, lifecycleState: 'READY' }),
    ),
  };
  const whatsapp: any = {
    onKnownInbound: jest.fn(),
    sendAiMessage: jest.fn(() =>
      Promise.resolve({
        whatsappMessage: { id: 'wa-outbound-2' },
        alreadySent: false,
      }),
    ),
  };
  const campaigns: any = {
    markTargetReplied: jest.fn(() => Promise.resolve(null)),
    findTargetByConversationId: jest.fn(() => Promise.resolve(null)),
    findTargetById: jest.fn(),
    updateTargetStatus: jest.fn(() => Promise.resolve({})),
    attachConversation: jest.fn(),
  };
  const media: any = { onProcessed: jest.fn() };
  const telegram: any = {
    notifyLeadOutcome: jest.fn(),
    notifyAiFailed: jest.fn(),
    notifyWhatsAppFailed: jest.fn(),
    notifyHandoff: jest.fn(),
    notifyAiUncertain: jest.fn(),
    notifyNewLead: jest.fn(),
    notifyQualifiedLead: jest.fn(),
  };
  const service = new ConversationOrchestratorService(
    settings as never,
    events as never,
    delay as never,
    contacts as never,
    conversations as never,
    messages as never,
    prompts as never,
    ai as never,
    whatsappClient as never,
    whatsapp as never,
    campaigns as never,
    media as never,
    telegram as never,
  );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T13:00:00Z'));
    jest.clearAllMocks();
    settings.get.mockResolvedValue(baseSettings);
    delay.scheduleConversation.mockResolvedValue(true);
    campaigns.findTargetByConversationId.mockResolvedValue(null);
    ai.hasProcessedMessage.mockResolvedValue(false);
    messages.findLatestByRole.mockResolvedValue(null);
    messages.findAiReply.mockResolvedValue(null);
    messages.findUnprocessedClients.mockResolvedValue([
      {
        id: input.messageId,
        conversationId: input.conversationId,
        role: 'CLIENT',
        text: 'Сообщение клиента',
        aiRunId: null,
        createdAt: new Date('2026-08-13T13:00:00Z'),
      },
    ]);
    whatsapp.sendAiMessage.mockResolvedValue({
      whatsappMessage: { id: 'wa-outbound-2' },
      alreadySent: false,
    });
  });

  afterEach(() => jest.useRealTimers());

  it('schedules automation for an eligible incoming reply', async () => {
    await service.handleIncomingClientMessage(input);

    expect(delay.scheduleConversation).toHaveBeenCalledWith(
      input,
      0,
      undefined,
    );
  });

  it('marks CampaignTarget ERROR when first-message AI returns INVALID_OUTPUT', async () => {
    campaigns.findTargetById.mockResolvedValue({
      id: 'target-1',
      campaignId: 'campaign-1',
      contactId: input.contactId,
      status: 'QUEUED',
      strategyCode: 'BARBERSHOP_GENERAL',
      campaign: { status: 'RUNNING' },
      contact: {
        id: input.contactId,
        phone: '+77086810693',
        deletedAt: null,
        outreachEligible: true,
        strategyCode: 'BARBERSHOP_GENERAL',
      },
      conversation: {
        id: input.conversationId,
        strategyCode: 'BARBERSHOP_GENERAL',
      },
    });
    ai.generateFirstMessage.mockRejectedValue(
      new BadGatewayException('invalid structured output', {
        cause: Object.assign(new Error('invalid output'), {
          code: 'INVALID_OUTPUT',
          retryable: false,
        }),
      }),
    );

    await expect(
      service.startConversationForCampaignTarget('target-1'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(campaigns.updateTargetStatus).toHaveBeenNthCalledWith(
      1,
      'campaign-1',
      'target-1',
      { status: 'PROCESSING' },
    );
    expect(campaigns.updateTargetStatus).toHaveBeenNthCalledWith(
      2,
      'campaign-1',
      'target-1',
      { status: 'ERROR', errorMessage: 'AI generation failed' },
    );
  });

  it('registers the inbound callback and schedules exactly one reply job', async () => {
    let callback: ((message: typeof input) => Promise<void>) | undefined;
    whatsapp.onKnownInbound.mockImplementationOnce((handler) => {
      callback = handler as (message: typeof input) => Promise<void>;
    });
    new ConversationOrchestratorService(
      settings as never,
      events as never,
      delay as never,
      contacts as never,
      conversations as never,
      messages as never,
      prompts as never,
      ai as never,
      whatsappClient as never,
      whatsapp as never,
      campaigns as never,
      media as never,
      telegram as never,
    );

    expect(whatsapp.onKnownInbound).toHaveBeenCalledTimes(1);
    expect(callback).toBeDefined();
    await callback!(input);
    expect(delay.scheduleConversation).toHaveBeenCalledTimes(1);
  });

  it('records the exact handoff skip reason without enqueueing', async () => {
    conversations.findOne.mockResolvedValueOnce({
      id: input.conversationId,
      contactId: input.contactId,
      status: 'HANDOFF_REQUIRED',
      strategyCode: 'BARBERSHOP_GENERAL',
    });

    await service.handleIncomingClientMessage(input);

    expect(delay.scheduleConversation).not.toHaveBeenCalled();
    expect(events.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SKIPPED',
        messageId: input.messageId,
        reason: 'CONVERSATION_HANDOFF_REQUIRED',
      }),
    );
  });

  it.each(['QUALIFIED', 'REJECTED', 'CLOSED'])(
    'does not run AI for terminal conversation %s',
    async (status) => {
      conversations.findOne.mockResolvedValueOnce({
        id: input.conversationId,
        contactId: input.contactId,
        status,
        strategyCode: 'BARBERSHOP_GENERAL',
      });

      await service.handleIncomingClientMessage(input);

      expect(campaigns.markTargetReplied).toHaveBeenCalledWith(
        input.conversationId,
      );
      expect(delay.scheduleConversation).not.toHaveBeenCalled();
      expect(ai.processClientMessage).not.toHaveBeenCalled();
    },
  );

  it('preserves the Campaign strategy on an existing conversation', async () => {
    campaigns.findTargetById.mockResolvedValue({
      id: 'target-1',
      campaignId: 'campaign-1',
      status: 'WAITING',
      strategyCode: 'BARBERSHOP_GENERAL',
      campaign: { status: 'RUNNING' },
      contactId: input.contactId,
      contact: {
        phone: '+77086810693',
        strategyCode: 'BARBERSHOP_GENERAL',
        deletedAt: null,
        outreachEligible: true,
        crmProvider: 'UNKNOWN',
      },
      conversation: {
        id: input.conversationId,
        strategyCode: 'MANUAL_WHATSAPP',
      },
    });
    conversations.ensureStrategy.mockResolvedValue({
      id: input.conversationId,
      strategyCode: 'BARBERSHOP_GENERAL',
    });
    messages.findLatestByRole.mockResolvedValue({
      id: 'ai-message-1',
      text: 'Первое сообщение',
    });

    await service.startConversationForCampaignTarget('target-1');

    expect(conversations.ensureStrategy).toHaveBeenCalledWith(
      input.conversationId,
      'BARBERSHOP_GENERAL',
    );
  });

  it('uses follow-up processing rather than generating another first message', async () => {
    await service.processIncomingClientMessage(input);

    expect(ai.processClientMessage).toHaveBeenCalledWith(
      input.conversationId,
      input.messageId,
      undefined,
      [input.messageId],
    );
    expect(ai.generateFirstMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendAiMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: input.conversationId }),
    );
  });

  it('retries a saved AI follow-up without calling AI again', async () => {
    ai.hasProcessedMessage.mockResolvedValue({
      id: 'ai-run-1',
      status: 'COMPLETED',
      reply: 'Saved reply',
    });
    messages.findAiReply.mockResolvedValue({
      id: 'ai-message-2',
      text: 'Saved reply',
    });

    await service.processIncomingClientMessage(input);

    expect(ai.processClientMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendAiMessage).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendAiMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'ai-message-2',
        text: 'Saved reply',
      }),
    );
  });

  it('does not automatically retry an ambiguous WhatsApp send', async () => {
    whatsapp.sendAiMessage.mockRejectedValueOnce(new Error('provider down'));

    await expect(
      service.processIncomingClientMessage(input),
    ).rejects.toMatchObject({
      code: 'WHATSAPP_SEND_OUTCOME_UNKNOWN',
      kind: 'TERMINAL',
    });

    expect(ai.processClientMessage).toHaveBeenCalledTimes(1);
  });

  it('persists qualification outcome before a WhatsApp transport failure', async () => {
    ai.processClientMessage.mockResolvedValueOnce({
      run: { id: 'ai-run-qualified' },
      message: { id: 'ai-message-qualified', text: 'Спасибо' },
      result: { action: 'QUALIFY', leadDecision: 'QUALIFIED' },
      lead: { id: 'lead-1' },
    });
    campaigns.findTargetByConversationId.mockResolvedValueOnce({
      id: 'target-1',
      campaignId: 'campaign-1',
    });
    whatsapp.sendAiMessage.mockRejectedValueOnce(new Error('transport'));

    await expect(
      service.processIncomingClientMessage(input),
    ).rejects.toMatchObject({ code: 'WHATSAPP_SEND_OUTCOME_UNKNOWN' });

    expect(campaigns.updateTargetStatus).toHaveBeenCalledWith(
      'campaign-1',
      'target-1',
      { status: 'LEAD' },
    );
    expect(
      campaigns.updateTargetStatus.mock.invocationCallOrder[0],
    ).toBeLessThan(whatsapp.sendAiMessage.mock.invocationCallOrder[0]);
  });

  it('defers outside working hours by creating a real next-window job', async () => {
    settings.get.mockResolvedValue({
      ...baseSettings,
      workingHoursEnabled: true,
      workingHoursStart: '00:00',
      workingHoursEnd: '00:01',
    });

    const result = await service.handleIncomingClientMessage(input);

    expect(result).toMatchObject({
      deferred: true,
      reason: 'OUTSIDE_WORKING_HOURS',
      scheduled: true,
    });
    expect(delay.scheduleConversation).toHaveBeenCalledTimes(1);
    expect(delay.scheduleConversation.mock.calls[0]?.[1]).toBeGreaterThan(0);
  });

  it('deduplicates repeated deferred events so the reply is processed once', async () => {
    settings.get.mockResolvedValue({
      ...baseSettings,
      workingHoursEnabled: true,
      workingHoursStart: '00:00',
      workingHoursEnd: '00:01',
    });
    delay.scheduleConversation
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const first = await service.handleIncomingClientMessage(input);
    const duplicate = await service.handleIncomingClientMessage(input);

    expect(first).toMatchObject({ scheduled: true });
    expect(duplicate).toMatchObject({ scheduled: false });
    expect(delay.scheduleConversation).toHaveBeenCalledTimes(2);
  });
});
