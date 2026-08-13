import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'argon2';
import { randomBytes } from 'crypto';
import { AdminRole, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateAdminUserDto,
  UpdateAdminUserDto,
} from './dto/admin-user.dto';
const select = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  passwordChangedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
@Injectable()
export class AdminUsersService {
  private logger = new Logger(AdminUsersService.name);
  constructor(private prisma: PrismaService) {}
  async list() {
    return this.prisma.adminUser.findMany({
      select,
      orderBy: { createdAt: 'desc' },
    });
  }
  async one(id: string) {
    const user = await this.prisma.adminUser.findUnique({
      where: { id },
      select,
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }
  async create(dto: CreateAdminUserDto) {
    const temporaryPassword = this.password();
    try {
      const user = await this.prisma.adminUser.create({
        data: {
          name: dto.name.trim(),
          email: dto.email.trim().toLowerCase(),
          role: dto.role,
          passwordHash: await hash(temporaryPassword),
          mustChangePassword: true,
        },
        select,
      });
      return { user, temporaryPassword };
    } catch (e) {
      this.handle(e);
    }
  }
  async update(id: string, dto: UpdateAdminUserDto) {
    const current = await this.required(id);
    if (current.role === AdminRole.OWNER && dto.role === AdminRole.MANAGER)
      await this.assertNotLastOwner(current.id);
    try {
      return await this.prisma.adminUser.update({
        where: { id },
        data: {
          ...dto,
          email: dto.email?.trim().toLowerCase(),
          name: dto.name?.trim(),
        },
        select,
      });
    } catch (e) {
      this.handle(e);
    }
  }
  async block(id: string) {
    const user = await this.required(id);
    if (user.role === AdminRole.OWNER) await this.assertNotLastOwner(id);
    const [updated] = await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: { id },
        data: { isActive: false },
        select,
      }),
      this.prisma.adminSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.logger.warn({ event: 'USER_BLOCKED', userId: id });
    return updated;
  }
  async unblock(id: string) {
    await this.required(id);
    return this.prisma.adminUser.update({
      where: { id },
      data: { isActive: true },
      select,
    });
  }
  async reset(id: string) {
    await this.required(id);
    const temporaryPassword = this.password();
    await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: { id },
        data: {
          passwordHash: await hash(temporaryPassword),
          mustChangePassword: true,
          passwordChangedAt: new Date(),
        },
      }),
      this.prisma.adminSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.logger.warn({ event: 'PASSWORD_RESET', userId: id });
    return { temporaryPassword };
  }
  private password() {
    return `Za1!${randomBytes(9).toString('base64url')}`;
  }
  private async required(id: string) {
    const user = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }
  private async assertNotLastOwner(id: string) {
    const count = await this.prisma.adminUser.count({
      where: { role: AdminRole.OWNER, isActive: true, id: { not: id } },
    });
    if (!count)
      throw new ConflictException(
        'Нельзя заблокировать или понизить последнего активного владельца',
      );
  }
  private handle(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      throw new ConflictException('Пользователь с таким email уже существует');
    throw error;
  }
}
