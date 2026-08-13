import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { allowedOrigins } from '../config/env';

@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.headers.origin;
    // Non-browser clients have no Origin; browser cookie requests always do.
    if (!origin || allowedOrigins().includes(origin)) return true;
    throw new ForbiddenException('Origin is not allowed');
  }
}
