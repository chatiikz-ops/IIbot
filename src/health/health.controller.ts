import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const whatsapp = await this.prisma.whatsAppSession.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { status: true },
      });
      return {
        status: 'ready',
        timestamp: new Date().toISOString(),
        database: 'up',
        openaiConfigured:
          process.env.OPENAI_MOCK_MODE === 'true' ||
          Boolean(process.env.OPENAI_API_KEY),
        whatsappStatus:
          whatsapp?.status ??
          (process.env.WHATSAPP_ENABLED === 'true'
            ? 'DISCONNECTED'
            : 'DISABLED'),
        telegramConfigured:
          process.env.TELEGRAM_ENABLED !== 'true' ||
          Boolean(process.env.TELEGRAM_BOT_TOKEN),
        automationWorker:
          process.env.AUTOMATION_WORKER_ENABLED !== 'false'
            ? 'enabled'
            : 'disabled',
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        database: 'down',
      });
    }
  }
}
