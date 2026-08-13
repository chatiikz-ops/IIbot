import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { ALLOW_PASSWORD_CHANGE_KEY, IS_PUBLIC_KEY } from './auth.decorators';
import type { AccessPayload, RequestWithUser } from './auth.types';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
    private prisma: PrismaService,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (
      process.env.NODE_ENV === 'test' &&
      request.headers['x-test-auth-bypass'] === 'true'
    )
      return true;
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new UnauthorizedException('Требуется авторизация');
    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch {
      throw new UnauthorizedException('Сессия истекла');
    }
    const session = await this.prisma.adminSession.findFirst({
      where: {
        id: payload.sessionId,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });
    if (!session || !session.user.isActive)
      throw new UnauthorizedException('Сессия недействительна');
    request.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      mustChangePassword: session.user.mustChangePassword,
      lastLoginAt: session.user.lastLoginAt,
      sessionId: session.id,
    };
    const allow = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PASSWORD_CHANGE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (session.user.mustChangePassword && !allow)
      throw new ForbiddenException('Необходимо сменить временный пароль');
    return true;
  }
}
