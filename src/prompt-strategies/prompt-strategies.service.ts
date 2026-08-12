import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PromptStrategyStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePromptStrategyDto } from './dto/create-prompt-strategy.dto';
import type { CreatePromptVersionDto } from './dto/create-prompt-version.dto';
import type { PromptStrategiesQueryDto } from './dto/prompt-strategies-query.dto';
import { SYSTEM_STRATEGY_CODES } from './prompt-strategies.constants';
import { validateAndExtractPromptVariables } from './utils/prompt-variables.util';

const VERSION_SUMMARY_SELECT = {
  id: true,
  version: true,
  changeNote: true,
  maxAssistantMessages: true,
  createdAt: true,
} satisfies Prisma.PromptVersionSelect;

@Injectable()
export class PromptStrategiesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreatePromptStrategyDto) {
    try {
      return await this.prisma.promptStrategy.create({ data });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Стратегия с таким code уже существует');
      }
      throw error;
    }
  }

  async findAll(query: PromptStrategiesQueryDto) {
    const where: Prisma.PromptStrategyWhereInput = {
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.promptStrategy.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          _count: { select: { versions: true } },
          activeVersion: { select: VERSION_SUMMARY_SELECT },
        },
      }),
      this.prisma.promptStrategy.count({ where }),
    ]);
    return {
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async findOne(id: string) {
    const strategy = await this.prisma.promptStrategy.findUnique({
      where: { id },
      include: {
        activeVersion: { select: VERSION_SUMMARY_SELECT },
        versions: {
          select: VERSION_SUMMARY_SELECT,
          orderBy: { version: 'desc' },
        },
      },
    });
    if (!strategy) throw new NotFoundException('Стратегия промпта не найдена');
    return strategy;
  }

  async findByCode(code: string) {
    const strategy = await this.prisma.promptStrategy.findUnique({
      where: { code },
      include: {
        activeVersion: { select: VERSION_SUMMARY_SELECT },
        versions: {
          select: VERSION_SUMMARY_SELECT,
          orderBy: { version: 'desc' },
        },
      },
    });
    if (!strategy) throw new NotFoundException('Стратегия промпта не найдена');
    return strategy;
  }

  async createVersion(id: string, data: CreatePromptVersionDto) {
    await this.getStrategy(id);
    validateAndExtractPromptVariables(this.promptTexts(data));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const latest = await tx.promptVersion.aggregate({
              where: { strategyId: id },
              _max: { version: true },
            });
            return tx.promptVersion.create({
              data: {
                strategyId: id,
                version: (latest._max.version ?? 0) + 1,
                systemInstruction: data.systemInstruction,
                objective: data.objective,
                firstMessage: data.firstMessage,
                communicationRules: data.communicationRules,
                qualificationQuestions: data.qualificationQuestions,
                sellingPoints: data.sellingPoints,
                competitorContext: data.competitorContext,
                handoffRules: data.handoffRules,
                stopRules: data.stopRules,
                forbiddenActions: data.forbiddenActions,
                closingRules: data.closingRules,
                maxAssistantMessages: data.maxAssistantMessages,
                metadata: data.metadata
                  ? (data.metadata as Prisma.InputJsonValue)
                  : undefined,
                changeNote: data.changeNote,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P2002')
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException('Не удалось назначить номер версии');
  }

  async findVersion(id: string, version: number) {
    await this.getStrategy(id);
    const promptVersion = await this.prisma.promptVersion.findUnique({
      where: { strategyId_version: { strategyId: id, version } },
    });
    if (!promptVersion)
      throw new NotFoundException('Версия промпта не найдена');
    return promptVersion;
  }

  async activateVersion(id: string, version: number) {
    const promptVersion = await this.prisma.promptVersion.findUnique({
      where: { strategyId_version: { strategyId: id, version } },
      select: { id: true, strategyId: true, version: true },
    });
    if (!promptVersion || promptVersion.strategyId !== id) {
      throw new NotFoundException('Версия промпта не найдена');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.promptStrategy.update({
        where: { id },
        data: {
          activeVersionId: promptVersion.id,
          status: PromptStrategyStatus.ACTIVE,
        },
      });
      return tx.promptStrategy.findUniqueOrThrow({
        where: { id },
        include: { activeVersion: { select: VERSION_SUMMARY_SELECT } },
      });
    });
  }

  async archive(id: string) {
    await this.getStrategy(id);
    return this.prisma.promptStrategy.update({
      where: { id },
      data: { status: PromptStrategyStatus.ARCHIVED, activeVersionId: null },
    });
  }

  async restore(id: string) {
    const strategy = await this.getStrategy(id);
    if (strategy.status !== PromptStrategyStatus.ARCHIVED) {
      throw new BadRequestException('Стратегия не находится в архиве');
    }
    return this.prisma.promptStrategy.update({
      where: { id },
      data: { status: PromptStrategyStatus.DRAFT, activeVersionId: null },
    });
  }

  async remove(id: string) {
    const strategy = await this.getStrategy(id);
    if (
      strategy.status === PromptStrategyStatus.ACTIVE ||
      strategy.activeVersionId
    ) {
      throw new ConflictException('Активную стратегию удалить нельзя');
    }
    return this.prisma.promptStrategy.delete({ where: { id } });
  }

  async seed() {
    const existing = await this.prisma.promptStrategy.findMany({
      where: { code: { in: [...SYSTEM_STRATEGY_CODES] } },
      select: { code: true },
    });
    const existingCodes = new Set(existing.map(({ code }) => code));
    const created = SYSTEM_STRATEGY_CODES.filter(
      (code) => !existingCodes.has(code),
    );
    const skipped = SYSTEM_STRATEGY_CODES.filter((code) =>
      existingCodes.has(code),
    );

    if (created.length > 0) {
      await this.prisma.promptStrategy.createMany({
        data: created.map((code) => ({
          code,
          name: code.replaceAll('_', ' '),
          description: 'Системная стратегия. Промпт не настроен.',
        })),
        skipDuplicates: true,
      });
    }
    return { created, skipped };
  }

  async getActivePromptByCode(code: string) {
    if (code === 'SKIP_EXISTING_CLIENT') {
      throw new BadRequestException(
        'Стратегия SKIP_EXISTING_CLIENT не предназначена для AI-общения',
      );
    }
    const strategy = await this.prisma.promptStrategy.findFirst({
      where: { code, status: PromptStrategyStatus.ACTIVE },
      include: { activeVersion: true },
    });
    if (!strategy?.activeVersion) {
      throw new NotFoundException('Для стратегии не настроен активный промпт');
    }
    return {
      code: strategy.code,
      name: strategy.name,
      version: strategy.activeVersion,
      usedVariables: validateAndExtractPromptVariables(
        this.promptTexts(strategy.activeVersion),
      ),
    };
  }

  private promptTexts(data: {
    systemInstruction: string;
    objective: string;
    firstMessage: string;
    communicationRules: string;
    qualificationQuestions: unknown;
    sellingPoints: unknown;
    competitorContext?: string | null;
    handoffRules: string;
    stopRules: string;
    forbiddenActions: unknown;
    closingRules: string;
  }): string[] {
    return [
      data.systemInstruction,
      data.objective,
      data.firstMessage,
      data.communicationRules,
      ...this.stringArray(data.qualificationQuestions),
      ...this.stringArray(data.sellingPoints),
      ...(data.competitorContext ? [data.competitorContext] : []),
      data.handoffRules,
      data.stopRules,
      ...this.stringArray(data.forbiddenActions),
      data.closingRules,
    ];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private async getStrategy(id: string) {
    const strategy = await this.prisma.promptStrategy.findUnique({
      where: { id },
    });
    if (!strategy) throw new NotFoundException('Стратегия промпта не найдена');
    return strategy;
  }
}
