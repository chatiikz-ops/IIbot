import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ContactsService } from '../contacts/contacts.service';
import { ConversationsService } from '../conversations/conversations.service';
import {
  AutomationEventType,
  CampaignStatus,
  CampaignTargetStatus,
  ConversationStatus,
  CrmProvider,
  MessageRole,
} from '../generated/prisma/enums';
import { MessagesService } from '../messages/messages.service';
import { MediaProcessingService } from '../media/media-processing.service';
import { PromptStrategiesService } from '../prompt-strategies/prompt-strategies.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { TelegramNotificationsService } from '../telegram/telegram-notifications.service';
import {
  WhatsAppMessagingService,
  type KnownInboundMessage,
} from '../whatsapp/whatsapp-messaging.service';
import { AutomationDelayService } from './automation-delay.service';
import { campaignWindow } from './campaign-time.util';
import { AutomationEventsService } from './automation-events.service';
import { AutomationSettingsService } from './automation-settings.service';
import { AutomationJobError } from './automation-job.error';

const TERMINAL_CONVERSATION_STATUSES: ConversationStatus[] = [
  ConversationStatus.CLOSED,
  ConversationStatus.REJECTED,
  ConversationStatus.QUALIFIED,
  ConversationStatus.HANDOFF_REQUIRED,
];

const STARTABLE_TARGET_STATUSES: CampaignTargetStatus[] = [
  CampaignTargetStatus.WAITING,
  CampaignTargetStatus.READY,
  CampaignTargetStatus.ERROR,
  CampaignTargetStatus.QUEUED,
];

type AiProcessingResult = {
  run: { id: string };
  message: { id: string; text: string } | null;
  result?: { action?: string; leadDecision?: string };
  lead?: { id: string } | null;
};

@Injectable()
export class ConversationOrchestratorService {
  private readonly logger = new Logger(ConversationOrchestratorService.name);

  constructor(
    private readonly settings: AutomationSettingsService,
    private readonly events: AutomationEventsService,
    private readonly delay: AutomationDelayService,
    private readonly contacts: ContactsService,
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly prompts: PromptStrategiesService,
    private readonly ai: AiService,
    private readonly whatsappClient: WhatsAppClientService,
    private readonly whatsapp: WhatsAppMessagingService,
    private readonly campaigns: CampaignsService,
    media: MediaProcessingService,
    private readonly telegram: TelegramNotificationsService,
  ) {
    this.whatsapp.onKnownInbound((message) => {
      this.logger.log({
        event: 'CONVERSATION_INBOUND_CALLBACK_STARTED',
        messageId: message.messageId,
        conversationId: message.conversationId,
      });
      return this.handleIncomingClientMessage(message).then(() => undefined);
    });
    media.onProcessed((message) =>
      this.handleIncomingClientMessage(message).then(() => undefined),
    );
  }

  async handleIncomingClientMessage(
    input: KnownInboundMessage,
    mockScenario?: string,
  ) {
    await this.events.create({
      type: AutomationEventType.INCOMING_RECEIVED,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      whatsAppMessageId: input.whatsAppMessageId,
    });

    const settings = await this.settings.get();
    if (!settings.enabled) {
      return this.skip(input, 'AUTOMATION_DISABLED');
    }
    if (!settings.autoReplyEnabled) {
      return this.skip(input, 'AUTO_REPLY_DISABLED');
    }

    const eligibility = await this.checkIncomingEligibility(input, settings);
    if (eligibility) return eligibility;

    if (!this.isWithinWorkingHours(settings)) {
      const nextRunAt = campaignWindow(
        new Date(),
        settings.workingHoursStart!,
        settings.workingHoursEnd!,
        settings.timezone,
      ).nextRunAt;
      const delaySeconds = Math.max(
        0,
        Math.ceil((nextRunAt.getTime() - Date.now()) / 1000),
      );
      const scheduled = await this.delay.scheduleConversation(
        input,
        delaySeconds,
        mockScenario,
      );
      await this.events.create({
        type: AutomationEventType.DEFERRED,
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        whatsAppMessageId: input.whatsAppMessageId,
        reason: 'OUTSIDE_WORKING_HOURS',
        metadata: { nextRunAt, scheduled },
      });
      return {
        deferred: true,
        reason: 'OUTSIDE_WORKING_HOURS',
        nextRunAt,
        scheduled,
      };
    }

    const delaySeconds = this.randomDelay(
      settings.responseDelayMinSeconds,
      settings.responseDelayMaxSeconds,
    );
    const scheduled = await this.delay.scheduleConversation(
      input,
      delaySeconds,
      mockScenario,
    );
    if (!scheduled) return this.skip(input, 'ALREADY_SCHEDULED');

    this.logger.log({
      event: 'CONVERSATION_REPLY_SCHEDULED',
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      delaySeconds,
    });

    await this.events.create({
      type: AutomationEventType.AUTO_REPLY_SCHEDULED,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      whatsAppMessageId: input.whatsAppMessageId,
      metadata: { delaySeconds },
    });
    return { scheduled: true, delaySeconds };
  }

  async processLatestClientMessage(
    conversationId: string,
    mockScenario?: string,
  ) {
    const conversation = await this.conversations.findOne(conversationId);
    const message =
      await this.messages.findLatestUnprocessedClient(conversationId);
    if (!message) {
      throw new NotFoundException(
        'Необработанное сообщение клиента не найдено',
      );
    }
    const whatsappMessage = await this.whatsapp.findByMessageId(message.id);
    return this.handleIncomingClientMessage(
      {
        contactId: conversation.contactId,
        conversationId,
        messageId: message.id,
        whatsAppMessageId: whatsappMessage?.id ?? '',
      },
      mockScenario,
    );
  }

  async startConversationForCampaignTarget(
    targetId: string,
    mockScenario?: string,
  ) {
    const settings = await this.settings.get();
    if (!settings.enabled) {
      throw new AutomationJobError(
        'AUTOMATION_TEMPORARILY_DISABLED',
        'RETRYABLE',
        'Автоматизация временно отключена',
      );
    }
    if (!settings.campaignSendingEnabled) {
      throw new AutomationJobError(
        'AUTOMATION_TEMPORARILY_DISABLED',
        'RETRYABLE',
        'Автоматическая отправка кампаний отключена',
      );
    }

    const target = await this.campaigns.findTargetById(targetId);
    if (target.campaign.status !== CampaignStatus.RUNNING) {
      throw new ConflictException('Кампания не запущена');
    }
    if (!STARTABLE_TARGET_STATUSES.includes(target.status)) {
      throw new ConflictException(
        `CampaignTarget нельзя запустить из статуса ${target.status}`,
      );
    }
    this.assertContactEligible(target.contact);
    await this.assertWhatsAppConnected();
    const strategyCode =
      target.strategyCode ?? target.contact.strategyCode ?? null;
    if (!strategyCode) {
      throw new NotFoundException(
        'Для контакта не настроена активная стратегия',
      );
    }
    await this.prompts.getActivePromptByCode(strategyCode);

    await this.campaigns.updateTargetStatus(target.campaignId, target.id, {
      status: CampaignTargetStatus.PROCESSING,
    });

    let conversation = target.conversation;
    if (!conversation) {
      conversation = await this.conversations.create({
        contactId: target.contactId,
        strategyCode,
      });
      await this.campaigns.attachConversation(target.id, conversation.id);
    } else if (conversation.strategyCode !== strategyCode) {
      conversation = await this.conversations.ensureStrategy(
        conversation.id,
        strategyCode,
      );
    }

    let aiMessage = await this.messages.findLatestByRole(
      conversation.id,
      MessageRole.AI,
    );
    let aiRunId: string | undefined;
    if (!aiMessage) {
      try {
        const result = await this.ai.generateFirstMessage(
          conversation.id,
          mockScenario,
        );
        aiMessage = result.message;
        aiRunId = result.run.id;
        await this.events.create({
          type: AutomationEventType.AI_COMPLETED,
          contactId: target.contactId,
          conversationId: conversation.id,
          messageId: aiMessage?.id,
          aiRunId,
          metadata: { flow: 'CAMPAIGN_FIRST_MESSAGE' },
        });
      } catch (error) {
        await this.campaigns.updateTargetStatus(target.campaignId, target.id, {
          status: CampaignTargetStatus.ERROR,
          errorMessage: 'AI generation failed',
        });
        await this.events.create({
          type: AutomationEventType.AI_FAILED,
          contactId: target.contactId,
          conversationId: conversation.id,
          reason: this.errorCode(error),
        });
        throw error;
      }
    }

    if (!aiMessage) {
      await this.campaigns.updateTargetStatus(target.campaignId, target.id, {
        status: CampaignTargetStatus.ERROR,
        errorMessage: 'AI did not create a message',
      });
      throw new ConflictException('OpenAI не создал первое сообщение');
    }

    try {
      const sent = await this.whatsapp.sendAiMessage({
        contactId: target.contactId,
        conversationId: conversation.id,
        messageId: aiMessage.id,
        phone: target.contact.phone,
        text: aiMessage.text,
      });
      await this.campaigns.updateTargetStatus(target.campaignId, target.id, {
        status: CampaignTargetStatus.WAITING_REPLY,
      });
      await this.events.create({
        type: AutomationEventType.WHATSAPP_SENT,
        contactId: target.contactId,
        conversationId: conversation.id,
        messageId: aiMessage.id,
        aiRunId,
        whatsAppMessageId: sent.whatsappMessage.id,
        metadata: { flow: 'CAMPAIGN_FIRST_MESSAGE' },
      });
      return {
        conversationId: conversation.id,
        messageId: aiMessage.id,
        whatsAppMessageId: sent.whatsappMessage.id,
        targetStatus: CampaignTargetStatus.WAITING_REPLY,
        alreadySent: sent.alreadySent,
      };
    } catch (error) {
      await this.campaigns.updateTargetStatus(target.campaignId, target.id, {
        status: CampaignTargetStatus.ERROR,
        errorMessage: 'WhatsApp send failed',
      });
      await this.events.create({
        type: AutomationEventType.WHATSAPP_FAILED,
        contactId: target.contactId,
        conversationId: conversation.id,
        messageId: aiMessage.id,
        aiRunId,
        reason: this.errorCode(error),
      });
      throw error;
    }
  }

  async getStatus() {
    const [settings, whatsapp] = await Promise.all([
      this.settings.get(),
      this.whatsappClient.getStatus(),
    ]);
    return {
      automationEnabled: settings.enabled,
      autoReplyEnabled: settings.autoReplyEnabled,
      campaignSendingEnabled: settings.campaignSendingEnabled,
      whatsAppConnected: whatsapp.connected,
      openAiConfigured: this.ai.configured,
      pendingJobs: await this.delay.pendingCount,
    };
  }

  async processIncomingClientMessage(
    input: KnownInboundMessage,
    mockScenario?: string,
    automationJobId?: string,
  ) {
    const settings = await this.settings.get();
    if (!settings.enabled || !settings.autoReplyEnabled) {
      await this.skip(input, 'AUTOMATION_DISABLED_AFTER_SCHEDULE');
      return;
    }
    try {
      await this.contacts.findOne(input.contactId);
    } catch {
      await this.skip(input, 'CONTACT_NOT_ACTIVE');
      return;
    }
    const existingRun = await this.ai.hasProcessedMessage(
      input.conversationId,
      input.messageId,
    );
    if (existingRun) {
      const existingReply = existingRun.reply
        ? await this.messages.findAiReply(
            input.conversationId,
            existingRun.reply,
          )
        : null;
      if (
        existingRun.status === 'COMPLETED' &&
        existingRun.reply &&
        existingReply?.text === existingRun.reply
      ) {
        await this.sendFollowUp(
          input,
          existingRun.id,
          existingReply,
          automationJobId,
        );
        return;
      }
      await this.skip(input, 'MESSAGE_ALREADY_PROCESSED');
      return;
    }

    await this.events.create({
      type: AutomationEventType.AUTO_REPLY_STARTED,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      whatsAppMessageId: input.whatsAppMessageId,
    });

    let result: AiProcessingResult;
    try {
      result = this.requireAiProcessingResult(
        await this.ai.processClientMessage(
          input.conversationId,
          input.messageId,
          mockScenario,
        ),
      );
      await this.events.create({
        type: AutomationEventType.AI_COMPLETED,
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        aiRunId: result.run.id,
        metadata: {
          action: result.result?.action ?? null,
          leadDecision: result.result?.leadDecision ?? null,
        },
      });
      this.logger.log({
        event: 'AI_FOLLOW_UP_COMPLETED',
        automationJobId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        sourceMessageId: input.messageId,
        aiRunId: result.run.id,
        aiMessageId: result.message?.id ?? null,
        replyCreated: Boolean(result.message),
      });
    } catch (error) {
      await this.events.create({
        type: AutomationEventType.AI_FAILED,
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        reason: this.errorCode(error),
      });
      void this.telegram.notifyAiFailed({
        deduplicationKey: `${input.messageId}:AI_FAILED`,
        text: '❗ Ошибка AI\n\nДиалог временно остановлен. Не удалось получить корректный ответ AI.',
        contactId: input.contactId,
        conversationId: input.conversationId,
      });
      return;
    }

    void this.telegram.notifyLeadOutcome({
      runId: result.run.id,
      contactId: input.contactId,
      conversationId: input.conversationId,
      leadId: result.lead?.id,
      action: result.result?.action,
      leadDecision: result.result?.leadDecision,
    });
    if (result.result?.leadDecision === 'UNCERTAIN') {
      void this.telegram.notifyAiUncertain({
        deduplicationKey: `${result.run.id}:AI_UNCERTAIN`,
        text: '⚠️ AI не уверен\n\nДиалог остановлен и требует проверки менеджера.',
        contactId: input.contactId,
        conversationId: input.conversationId,
      });
    }

    if (result.message) {
      const contact = await this.contacts.findOne(input.contactId);
      try {
        const sent = await this.whatsapp.sendAiMessage({
          contactId: input.contactId,
          conversationId: input.conversationId,
          messageId: result.message.id,
          phone: contact.phone,
          text: result.message.text,
        });
        await this.events.create({
          type: AutomationEventType.WHATSAPP_SENT,
          contactId: input.contactId,
          conversationId: input.conversationId,
          messageId: result.message.id,
          aiRunId: result.run.id,
          whatsAppMessageId: sent.whatsappMessage.id,
          metadata: { alreadySent: sent.alreadySent },
        });
        this.logger.log({
          event: 'WHATSAPP_FOLLOW_UP_SENT',
          automationJobId,
          contactId: input.contactId,
          conversationId: input.conversationId,
          sourceMessageId: input.messageId,
          messageId: result.message.id,
          aiRunId: result.run.id,
          whatsAppMessageId: sent.whatsappMessage.id,
          alreadySent: sent.alreadySent,
        });
      } catch (error) {
        await this.events.create({
          type: AutomationEventType.WHATSAPP_FAILED,
          contactId: input.contactId,
          conversationId: input.conversationId,
          messageId: result.message.id,
          aiRunId: result.run.id,
          reason: this.errorCode(error),
        });
        void this.telegram.notifyWhatsAppFailed({
          deduplicationKey: `${result.message.id}:WHATSAPP_FAILED`,
          text: '❗ Не удалось отправить сообщение\n\nAI-ответ сохранён, но WhatsApp не подтвердил отправку.',
          contactId: input.contactId,
          conversationId: input.conversationId,
        });
        throw new AutomationJobError(
          'WHATSAPP_SEND_OUTCOME_UNKNOWN',
          'TERMINAL',
          'WhatsApp transport did not confirm the send outcome',
        );
      }
    }

    await this.recordDecisionEvent(input, result);
    await this.syncCampaignTarget(input.conversationId, result);
  }

  private async sendFollowUp(
    input: KnownInboundMessage,
    aiRunId: string,
    message: { id: string; text: string },
    automationJobId?: string,
  ) {
    const contact = await this.contacts.findOne(input.contactId);
    try {
      const sent = await this.whatsapp.sendAiMessage({
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: message.id,
        phone: contact.phone,
        text: message.text,
      });
      await this.events.create({
        type: AutomationEventType.WHATSAPP_SENT,
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: message.id,
        aiRunId,
        whatsAppMessageId: sent.whatsappMessage.id,
        metadata: { alreadySent: sent.alreadySent },
      });
      this.logger.log({
        event: 'WHATSAPP_FOLLOW_UP_SENT',
        automationJobId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        sourceMessageId: input.messageId,
        messageId: message.id,
        aiRunId,
        whatsAppMessageId: sent.whatsappMessage.id,
        alreadySent: sent.alreadySent,
      });
    } catch (error) {
      await this.events.create({
        type: AutomationEventType.WHATSAPP_FAILED,
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: message.id,
        aiRunId,
        reason: this.errorCode(error),
      });
      void this.telegram.notifyWhatsAppFailed({
        deduplicationKey: `${message.id}:WHATSAPP_FAILED`,
        text: 'AI reply is saved, but WhatsApp did not confirm delivery.',
        contactId: input.contactId,
        conversationId: input.conversationId,
      });
      throw new AutomationJobError(
        'WHATSAPP_SEND_OUTCOME_UNKNOWN',
        'TERMINAL',
        'WhatsApp transport did not confirm the send outcome',
      );
    }
  }

  private async syncCampaignTarget(
    conversationId: string,
    result: AiProcessingResult,
  ) {
    const target =
      await this.campaigns.findTargetByConversationId(conversationId);
    if (!target) return;
    const status = result.lead?.id
      ? CampaignTargetStatus.LEAD
      : result.result?.action === 'HANDOFF'
        ? CampaignTargetStatus.HANDOFF
        : result.result?.leadDecision === 'REJECTED'
          ? CampaignTargetStatus.REJECTED
          : CampaignTargetStatus.REPLIED;
    await this.campaigns.updateTargetStatus(target.campaignId, target.id, {
      status,
    });
  }

  private async checkIncomingEligibility(
    input: KnownInboundMessage,
    settings: {
      maxAutoRepliesPerConversation: number;
    },
  ) {
    try {
      const contact = await this.contacts.findOne(input.contactId);
      this.assertContactEligible(contact);
      const conversation = await this.conversations.findOne(
        input.conversationId,
      );
      if (TERMINAL_CONVERSATION_STATUSES.includes(conversation.status)) {
        return this.skip(
          input,
          conversation.status === ConversationStatus.HANDOFF_REQUIRED
            ? 'CONVERSATION_HANDOFF_REQUIRED'
            : `CONVERSATION_TERMINAL_${conversation.status}`,
        );
      }
      const message = await this.messages.findOne(input.messageId);
      if (
        message.role !== MessageRole.CLIENT ||
        message.conversationId !== conversation.id
      ) {
        return this.skip(input, 'MESSAGE_NOT_IN_CONVERSATION');
      }
      if (await this.ai.hasProcessedMessage(conversation.id, message.id)) {
        return this.skip(input, 'MESSAGE_ALREADY_PROCESSED');
      }
      await this.assertWhatsAppConnected();
      if (!conversation.strategyCode) {
        throw new NotFoundException(
          'Для контакта не настроена активная стратегия',
        );
      }
      const prompt = await this.prompts.getActivePromptByCode(
        conversation.strategyCode,
      );
      const assistantMessages = await this.messages.countByRole(
        conversation.id,
        MessageRole.AI,
      );
      const limit = Math.min(
        settings.maxAutoRepliesPerConversation,
        prompt.version.maxAssistantMessages,
      );
      if (assistantMessages >= limit) {
        await this.conversations.updateStatus(conversation.id, {
          status: ConversationStatus.HANDOFF_REQUIRED,
        });
        await this.events.create({
          type: AutomationEventType.HANDOFF,
          contactId: contact.id,
          conversationId: conversation.id,
          messageId: message.id,
          reason: 'AUTO_REPLY_LIMIT_REACHED',
          metadata: { limit },
        });
        await this.telegram.notifyLeadOutcome({
          runId: `conversation:${conversation.id}:AUTO_REPLY_LIMIT_REACHED`,
          contactId: contact.id,
          conversationId: conversation.id,
          action: 'HANDOFF',
        });
        return {
          skipped: true,
          reason: 'AUTO_REPLY_LIMIT_REACHED',
        };
      }
      return null;
    } catch (error) {
      return this.skip(input, this.errorCode(error));
    }
  }

  private assertContactEligible(contact: {
    outreachEligible: boolean;
    crmProvider: CrmProvider;
    deletedAt?: Date | null;
  }) {
    if (
      contact.deletedAt ||
      !contact.outreachEligible ||
      contact.crmProvider === CrmProvider.ZAPIS
    ) {
      throw new ForbiddenException('Контакт исключён из обработки');
    }
  }

  private async assertWhatsAppConnected() {
    const status = await this.whatsappClient.getStatus();
    if (!status.connected) {
      throw new AutomationJobError(
        status.lifecycleState === 'INITIALIZING'
          ? 'WHATSAPP_INITIALIZING'
          : 'WHATSAPP_NOT_CONNECTED',
        'RETRYABLE',
        'WhatsApp не подключён',
      );
    }
  }

  private async skip(input: KnownInboundMessage, reason: string) {
    await this.events.create({
      type: AutomationEventType.SKIPPED,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      whatsAppMessageId: input.whatsAppMessageId || undefined,
      reason,
    });
    return { skipped: true, reason };
  }

  private async recordDecisionEvent(
    input: KnownInboundMessage,
    result: {
      run: { id: string };
      result?: { action?: string; leadDecision?: string };
    },
  ) {
    const action = result.result?.action;
    const leadDecision = result.result?.leadDecision;
    let type: AutomationEventType | null = null;
    if (action === 'HANDOFF' || leadDecision === 'UNCERTAIN') {
      type = AutomationEventType.HANDOFF;
    } else if (action === 'QUALIFY' || leadDecision === 'QUALIFIED') {
      type = AutomationEventType.QUALIFIED;
    } else if (leadDecision === 'REJECTED') {
      type = AutomationEventType.REJECTED;
    }
    if (type) {
      await this.events.create({
        type,
        contactId: input.contactId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        aiRunId: result.run.id,
      });
    }
  }

  private isWithinWorkingHours(settings: {
    workingHoursEnabled: boolean;
    workingHoursStart: string | null;
    workingHoursEnd: string | null;
    timezone: string;
  }) {
    if (!settings.workingHoursEnabled) return true;
    if (!settings.workingHoursStart || !settings.workingHoursEnd) return false;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
    const current = `${hour}:${minute}`;
    if (settings.workingHoursStart <= settings.workingHoursEnd) {
      return (
        current >= settings.workingHoursStart &&
        current <= settings.workingHoursEnd
      );
    }
    return (
      current >= settings.workingHoursStart ||
      current <= settings.workingHoursEnd
    );
  }

  private randomDelay(min: number, max: number) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private errorCode(error: unknown) {
    if (error instanceof Error) return error.constructor.name;
    return 'UNKNOWN_ERROR';
  }

  private requireAiProcessingResult(value: unknown): AiProcessingResult {
    if (!value || typeof value !== 'object' || !('run' in value)) {
      throw new Error('INVALID_AI_PROCESSING_RESULT');
    }
    const candidate = value as {
      run?: unknown;
      message?: unknown;
      result?: unknown;
    };
    if (
      !candidate.run ||
      typeof candidate.run !== 'object' ||
      !('id' in candidate.run) ||
      typeof candidate.run.id !== 'string'
    ) {
      throw new Error('INVALID_AI_PROCESSING_RESULT');
    }
    return value as AiProcessingResult;
  }
}
