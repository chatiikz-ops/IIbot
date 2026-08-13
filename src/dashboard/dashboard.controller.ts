import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CampaignStatus,
  ContactStatus,
  ConversationStatus,
  LeadStatus,
  WhatsAppConnectionStatus,
} from '../generated/prisma/enums';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async summary() {
    const activeContact = { deletedAt: null } as const;
    const [contacts, conversations, leads, campaigns, automation, whatsapp] =
      await Promise.all([
        this.prisma.contact.groupBy({
          by: ['status', 'outreachEligible'],
          where: activeContact,
          _count: true,
        }),
        this.prisma.conversation.groupBy({ by: ['status'], _count: true }),
        this.prisma.lead.groupBy({ by: ['status'], _count: true }),
        this.prisma.campaign.groupBy({ by: ['status'], _count: true }),
        this.prisma.automationSettings.findUnique({
          where: { singletonKey: 'global' },
        }),
        this.prisma.whatsAppSession.findFirst({
          orderBy: { updatedAt: 'desc' },
          select: { status: true },
        }),
      ]);
    const contactStatus = (status: ContactStatus) =>
      contacts
        .filter((x) => x.status === status)
        .reduce((n, x) => n + x._count, 0);
    const conversationStatus = (status: ConversationStatus) =>
      conversations.find((x) => x.status === status)?._count ?? 0;
    const leadStatus = (status: LeadStatus) =>
      leads.find((x) => x.status === status)?._count ?? 0;
    const campaignStatus = (status: CampaignStatus) =>
      campaigns.find((x) => x.status === status)?._count ?? 0;
    const totalContacts = contacts.reduce((n, x) => n + x._count, 0);
    const eligible = contacts
      .filter((x) => x.outreachEligible)
      .reduce((n, x) => n + x._count, 0);
    return {
      contacts: {
        total: totalContacts,
        new: contactStatus(ContactStatus.NEW),
        inProgress: contactStatus(ContactStatus.IN_PROGRESS),
        qualified: contactStatus(ContactStatus.QUALIFIED),
        rejected: contactStatus(ContactStatus.REJECTED),
        eligible,
        excluded: totalContacts - eligible,
      },
      conversations: {
        active: conversationStatus(ConversationStatus.ACTIVE),
        waitingClient: conversationStatus(ConversationStatus.WAITING_CLIENT),
        handoff: conversationStatus(ConversationStatus.HANDOFF_REQUIRED),
        qualified: conversationStatus(ConversationStatus.QUALIFIED),
      },
      leads: {
        total: leads.reduce((n, x) => n + x._count, 0),
        new: leadStatus(LeadStatus.NEW),
        qualified: leadStatus(LeadStatus.QUALIFIED),
        transferred: leadStatus(LeadStatus.TRANSFERRED),
      },
      campaigns: {
        running: campaignStatus(CampaignStatus.RUNNING),
        paused: campaignStatus(CampaignStatus.PAUSED),
        completed: campaignStatus(CampaignStatus.COMPLETED),
      },
      automation: {
        enabled: automation?.enabled ?? false,
        autoReplyEnabled: automation?.autoReplyEnabled ?? false,
        campaignSendingEnabled: automation?.campaignSendingEnabled ?? false,
      },
      whatsapp: {
        connected: whatsapp?.status === WhatsAppConnectionStatus.CONNECTED,
        status: whatsapp?.status ?? WhatsAppConnectionStatus.DISABLED,
      },
    };
  }
}
