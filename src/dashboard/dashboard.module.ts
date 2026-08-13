import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardController } from './dashboard.controller';

@Module({ imports: [PrismaModule], controllers: [DashboardController] })
export class DashboardModule {}
