import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AllowPasswordChange, Public } from './auth.decorators';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';
import type { RequestWithUser } from './auth.types';
import { OriginGuard } from './origin.guard';
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  private cookieName() {
    return process.env.AUTH_COOKIE_NAME || 'zapis_admin_refresh';
  }
  private setCookie(res: Response, value: string) {
    res.cookie(this.cookieName(), value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.AUTH_COOKIE_SECURE === 'true',
      path: '/auth',
      maxAge: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30) * 86400000,
    });
  }
  private clear(res: Response) {
    res.clearCookie(this.cookieName(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.AUTH_COOKIE_SECURE === 'true',
      path: '/auth',
    });
  }
  @Public()
  @Throttle({ default: { limit: 7, ttl: 900000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(
      dto.email,
      dto.password,
      req.headers['user-agent'],
      req.ip,
    );
    this.setCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }
  @Public()
  @Throttle({ default: { limit: 30, ttl: 900000 } })
  @Post('refresh')
  @UseGuards(OriginGuard)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const result = await this.auth.refresh(cookies?.[this.cookieName()]);
    this.setCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }
  @AllowPasswordChange() @Get('me') me(@Req() req: RequestWithUser) {
    return req.user;
  }
  @AllowPasswordChange() @UseGuards(OriginGuard) @Post('logout') async logout(
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.user.sessionId);
    this.clear(res);
    return { success: true };
  }
  @UseGuards(OriginGuard) @Post('logout-all') async logoutAll(
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(req.user.id);
    this.clear(res);
    return { success: true };
  }
  @AllowPasswordChange() @Post('change-password') async change(
    @Req() req: RequestWithUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(
      req.user.id,
      req.user.sessionId,
      dto.currentPassword,
      dto.newPassword,
    );
    return { success: true };
  }
}
