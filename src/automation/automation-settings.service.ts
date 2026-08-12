import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateAutomationSettingsDto } from './dto/update-automation-settings.dto';

const SINGLETON_KEY = 'global';

@Injectable()
export class AutomationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  get() {
    return this.prisma.automationSettings.upsert({
      where: { singletonKey: SINGLETON_KEY },
      create: { singletonKey: SINGLETON_KEY },
      update: {},
    });
  }

  async update(data: UpdateAutomationSettingsDto) {
    const current = await this.get();
    const merged = { ...current, ...data };
    if (merged.responseDelayMinSeconds > merged.responseDelayMaxSeconds) {
      throw new BadRequestException(
        'Минимальная задержка не может быть больше максимальной',
      );
    }
    if (
      merged.workingHoursEnabled &&
      (!merged.workingHoursStart || !merged.workingHoursEnd)
    ) {
      throw new BadRequestException(
        'Для рабочего времени нужны workingHoursStart и workingHoursEnd',
      );
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: merged.timezone }).format();
    } catch {
      throw new BadRequestException('Некорректный timezone');
    }
    return this.prisma.automationSettings.update({
      where: { singletonKey: SINGLETON_KEY },
      data,
    });
  }
}
