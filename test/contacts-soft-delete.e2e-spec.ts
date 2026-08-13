/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { AppModule } from '../src/app.module';
import { CampaignSelectionService } from '../src/campaigns/campaign-selection.service';
import { ClassificationService } from '../src/classification/classification.service';
import {
  AiRunStatus,
  AutomationEventType,
  CampaignSourceType,
  CampaignTargetStatus,
  LeadStatus,
  MediaProcessingStatus,
  MediaType,
  MessageRole,
  TelegramNotificationType,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthGuard } from '../src/auth/auth.guard';
import { APP_GUARD } from '@nestjs/core';

describe('Contacts soft delete history (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ids: Record<string, string> = {};
  const phone = `+7702${String(Date.now()).slice(-7)}`;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(APP_GUARD)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.use(
      (
        req: { headers: Record<string, string> },
        _res: unknown,
        next: () => void,
      ) => {
        req.headers['x-test-auth-bypass'] = 'true';
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (ids.contact) {
      await prisma.contact.deleteMany({ where: { id: ids.contact } });
    }
    if (ids.replacement) {
      await prisma.contact.deleteMany({ where: { id: ids.replacement } });
    }
    if (ids.whatsapp) {
      await prisma.whatsAppMessage.deleteMany({ where: { id: ids.whatsapp } });
    }
    if (ids.campaign) {
      await prisma.campaign.deleteMany({ where: { id: ids.campaign } });
    }
    if (ids.automation) {
      await prisma.automationEvent.deleteMany({
        where: { id: ids.automation },
      });
    }
    if (ids.telegram) {
      await prisma.telegramNotification.deleteMany({
        where: { id: ids.telegram },
      });
    }
    if (ids.importJob) {
      await prisma.importJob.deleteMany({ where: { id: ids.importJob } });
    }
    await app.close();
  });

  it('preserves the complete sales history, supports active-phone reuse and restore', async () => {
    const created = await request(app.getHttpServer())
      .post('/contacts')
      .send({
        companyName: 'Soft delete audit',
        phone,
        category: 'Салон красоты',
      })
      .expect(201);
    ids.contact = created.body.id as string;

    const conversation = await prisma.conversation.create({
      data: { contactId: ids.contact, strategyCode: 'AUDIT' },
    });
    ids.conversation = conversation.id;
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.CLIENT,
        text: 'history',
      },
    });
    ids.message = message.id;
    const aiRun = await prisma.aiRun.create({
      data: {
        conversationId: conversation.id,
        model: 'audit-model',
        status: AiRunStatus.COMPLETED,
      },
    });
    ids.aiRun = aiRun.id;
    const lead = await prisma.lead.create({
      data: {
        conversationId: conversation.id,
        contactId: ids.contact,
        status: LeadStatus.QUALIFIED,
        summary: 'history',
        qualificationReason: 'audit',
      },
    });
    ids.lead = lead.id;
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Soft delete audit',
        sourceType: CampaignSourceType.ALL_CONTACTS,
        filters: {},
      },
    });
    ids.campaign = campaign.id;
    const target = await prisma.campaignTarget.create({
      data: {
        campaignId: campaign.id,
        contactId: ids.contact,
        conversationId: conversation.id,
        status: CampaignTargetStatus.WAITING_REPLY,
      },
    });
    ids.target = target.id;
    const whatsapp = await prisma.whatsAppMessage.create({
      data: {
        direction: WhatsAppMessageDirection.INBOUND,
        status: WhatsAppMessageStatus.RECEIVED,
        phone,
        text: 'history',
        contactId: ids.contact,
        conversationId: conversation.id,
        messageId: message.id,
      },
    });
    ids.whatsapp = whatsapp.id;
    const media = await prisma.mediaAttachment.create({
      data: {
        whatsAppMessageId: whatsapp.id,
        messageId: message.id,
        conversationId: conversation.id,
        contactId: ids.contact,
        type: MediaType.IMAGE,
        processingStatus: MediaProcessingStatus.COMPLETED,
        mimeType: 'image/png',
      },
    });
    ids.media = media.id;
    ids.automation = (
      await prisma.automationEvent.create({
        data: {
          type: AutomationEventType.INCOMING_RECEIVED,
          contactId: ids.contact,
          conversationId: conversation.id,
          messageId: message.id,
          aiRunId: aiRun.id,
          whatsAppMessageId: whatsapp.id,
        },
      })
    ).id;
    ids.telegram = (
      await prisma.telegramNotification.create({
        data: {
          type: TelegramNotificationType.NEW_LEAD,
          contactId: ids.contact,
          conversationId: conversation.id,
          leadId: lead.id,
          automationEventId: ids.automation,
        },
      })
    ).id;

    const statsBeforeDelete = await request(app.getHttpServer())
      .get('/classification/stats')
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/contacts/${ids.contact}`)
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/contacts/${ids.contact}`)
      .expect(404);
    const statsAfterDelete = await request(app.getHttpServer())
      .get('/classification/stats')
      .expect(200);
    const totalStats = (values: Record<string, number>) =>
      Object.values(values).reduce((sum, value) => sum + value, 0);
    expect(totalStats(statsAfterDelete.body.crmProvider)).toBe(
      totalStats(statsBeforeDelete.body.crmProvider) - 1,
    );
    await request(app.getHttpServer())
      .get(`/contacts/${ids.contact}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/contacts/${ids.contact}`)
      .send({ notes: 'no' })
      .expect(404);

    const archived = await prisma.contact.findUniqueOrThrow({
      where: { id: ids.contact },
    });
    expect(archived.deletedAt).toBeInstanceOf(Date);
    expect(
      await prisma.conversation.count({ where: { id: ids.conversation } }),
    ).toBe(1);
    expect(await prisma.message.count({ where: { id: ids.message } })).toBe(1);
    expect(await prisma.aiRun.count({ where: { id: ids.aiRun } })).toBe(1);
    expect(await prisma.lead.count({ where: { id: ids.lead } })).toBe(1);
    expect(
      await prisma.campaignTarget.count({ where: { id: ids.target } }),
    ).toBe(1);
    expect(
      await prisma.whatsAppMessage.count({ where: { id: ids.whatsapp } }),
    ).toBe(1);
    expect(
      await prisma.mediaAttachment.count({ where: { id: ids.media } }),
    ).toBe(1);
    expect(
      await prisma.automationEvent.count({ where: { id: ids.automation } }),
    ).toBe(1);
    expect(
      await prisma.telegramNotification.count({ where: { id: ids.telegram } }),
    ).toBe(1);

    const list = await request(app.getHttpServer())
      .get('/contacts?search=Soft%20delete%20audit')
      .expect(200);
    expect(list.body.data).toHaveLength(0);
    await request(app.getHttpServer())
      .post(`/classification/contacts/${ids.contact}`)
      .expect(404);
    await request(app.getHttpServer())
      .post('/conversations')
      .send({ contactId: ids.contact, strategyCode: 'AUDIT' })
      .expect(404);
    const selection = app.get(CampaignSelectionService);
    const selectable = await selection.select({
      sourceType: CampaignSourceType.ALL_CONTACTS,
      filters: {},
    });
    expect(selectable.some((item) => item.id === ids.contact)).toBe(false);
    const classification = app.get(ClassificationService);
    expect(await classification.classifyContactIds([ids.contact])).toEqual(
      expect.objectContaining({ processed: 0 }),
    );
    const deleted = await request(app.getHttpServer())
      .get('/contacts/deleted?search=Soft%20delete%20audit')
      .expect(200);
    expect(
      deleted.body.data.some((item: { id: string }) => item.id === ids.contact),
    ).toBe(true);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        { companyName: 'Imported replacement', phone },
      ]),
      'Contacts',
    );
    const spreadsheet = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    const preview = await request(app.getHttpServer())
      .post('/imports/preview')
      .attach('file', spreadsheet, 'soft-delete-import.xlsx')
      .expect(201);
    ids.importJob = preview.body.importId as string;
    expect(preview.body.summary.duplicateInDatabase).toBe(0);
    await request(app.getHttpServer())
      .post(`/imports/${ids.importJob}/confirm`)
      .expect(201);
    const replacement = await prisma.contact.findFirstOrThrow({
      where: { phone, deletedAt: null },
    });
    ids.replacement = replacement.id;
    await request(app.getHttpServer())
      .post(`/contacts/${ids.contact}/restore`)
      .expect(409);
    await request(app.getHttpServer())
      .delete(`/contacts/${ids.replacement}`)
      .expect(200);
    await prisma.contact.delete({ where: { id: ids.replacement } });
    delete ids.replacement;

    await request(app.getHttpServer())
      .post(`/contacts/${ids.contact}/restore`)
      .expect(201);
    await request(app.getHttpServer())
      .get(`/contacts/${ids.contact}`)
      .expect(200);
    const restored = await prisma.contact.findUniqueOrThrow({
      where: { id: ids.contact },
    });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
    expect(restored.deletionReason).toBeNull();
  });
});
