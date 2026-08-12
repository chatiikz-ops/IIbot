import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CampaignTargetStatus } from '../../generated/prisma/enums';

export class UpdateCampaignTargetStatusDto {
  @IsEnum(CampaignTargetStatus)
  status!: CampaignTargetStatus;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}
