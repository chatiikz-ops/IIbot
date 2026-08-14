import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { CampaignSelectionService } from './campaign-selection.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [PrismaModule, WhatsAppModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignSelectionService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
