import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from 'argon2';
import { randomBytes } from 'crypto';
import type { AdminUser } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AccessPayload, AuthUser } from './auth.types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private publicUser(user: AdminUser, sessionId: string): AuthUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      sessionId,
    };
  }

  private access(user: AdminUser, sessionId: string) {
    const payload: AccessPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sessionId,
    };
    return this.jwt.signAsync(payload);
  }

  private rawRefresh(sessionId: string) {
    return `${sessionId}.${randomBytes(48).toString('base64url')}`;
  }

  async login(
    email: string,
    password: string,
    userAgent?: string,
    ipAddress?: string,
  ) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.adminUser.findUnique({
      where: { email: normalized },
    });
    if (
      !user ||
      !user.isActive ||
      !(await verify(user.passwordHash, password).catch(() => false))
    ) {
      this.logger.warn({ event: 'LOGIN_FAILED', ipAddress });
      throw new UnauthorizedException('Неверный email или пароль');
    }
    const expiresAt = new Date(Date.now() + this.refreshDays() * 86_400_000);
    const pending = await this.prisma.adminSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'pending',
        userAgent,
        ipAddress,
        expiresAt,
      },
    });
    const refreshToken = this.rawRefresh(pending.id);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.adminSession.update({
        where: { id: pending.id },
        data: { refreshTokenHash: await hash(refreshToken) },
      }),
      this.prisma.adminUser.update({
        where: { id: user.id },
        data: { lastLoginAt: now },
      }),
    ]);
    this.logger.log({
      event: 'LOGIN_SUCCESS',
      userId: user.id,
      sessionId: pending.id,
    });
    return {
      accessToken: await this.access(user, pending.id),
      refreshToken,
      user: this.publicUser({ ...user, lastLoginAt: now }, pending.id),
    };
  }

  async refresh(raw?: string) {
    const sessionId = raw?.split('.')[0];
    if (!raw || !sessionId) this.invalidSession();

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        // Serializes refreshes for this session across every backend instance.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`;
        const session = await tx.adminSession.findUnique({
          where: { id: sessionId },
          include: { user: true },
        });
        const now = new Date();
        if (
          !session ||
          session.revokedAt ||
          session.expiresAt <= now ||
          !session.user.isActive
        ) {
          return { kind: 'invalid' as const };
        }

        const current = await verify(session.refreshTokenHash, raw).catch(
          () => false,
        );
        if (!current) {
          const previous =
            Boolean(session.previousTokenHash) &&
            (await verify(session.previousTokenHash!, raw).catch(() => false));
          if (!previous) return { kind: 'invalid' as const };

          if (
            session.previousTokenValidUntil &&
            session.previousTokenValidUntil > now
          ) {
            // A concurrent browser request lost the rotation race. It receives
            // 401 so the winning Set-Cookie remains authoritative, but the
            // legitimate session is not destroyed.
            return { kind: 'concurrent' as const };
          }

          await tx.adminSession.update({
            where: { id: session.id },
            data: { revokedAt: now },
          });
          return {
            kind: 'replay' as const,
            userId: session.userId,
            sessionId: session.id,
          };
        }

        const next = this.rawRefresh(session.id);
        await tx.adminSession.update({
          where: { id: session.id },
          data: {
            previousTokenHash: session.refreshTokenHash,
            previousTokenValidUntil: new Date(
              now.getTime() +
                Number(process.env.AUTH_REFRESH_GRACE_SECONDS || 10) * 1000,
            ),
            refreshTokenHash: await hash(next),
            rotationVersion: { increment: 1 },
            lastUsedAt: now,
          },
        });
        return { kind: 'rotated' as const, next, user: session.user };
      },
      { timeout: 15_000 },
    );

    if (outcome.kind === 'replay') {
      this.logger.warn({
        event: 'REFRESH_REPLAY',
        userId: outcome.userId,
        sessionId: outcome.sessionId,
      });
      this.invalidSession();
    }
    if (outcome.kind !== 'rotated') this.invalidSession();
    return {
      accessToken: await this.access(outcome.user, sessionId),
      refreshToken: outcome.next,
      user: this.publicUser(outcome.user, sessionId),
    };
  }

  async logout(sessionId: string) {
    await this.prisma.adminSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.log({ event: 'LOGOUT', sessionId });
  }

  async logoutAll(userId: string) {
    await this.prisma.adminSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(
    userId: string,
    sessionId: string,
    current: string,
    next: string,
  ) {
    const user = await this.prisma.adminUser.findUnique({
      where: { id: userId },
    });
    if (
      !user ||
      !(await verify(user.passwordHash, current).catch(() => false))
    ) {
      throw new UnauthorizedException('Текущий пароль указан неверно');
    }
    if (current === next) {
      throw new ConflictException('Новый пароль должен отличаться от текущего');
    }
    await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: { id: userId },
        data: {
          passwordHash: await hash(next),
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        },
      }),
      this.prisma.adminSession.updateMany({
        where: { userId, id: { not: sessionId }, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.logger.log({ event: 'PASSWORD_CHANGED', userId });
  }

  private invalidSession(): never {
    throw new UnauthorizedException('Сессия истекла');
  }

  private refreshDays() {
    return Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
  }
}
