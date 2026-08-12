import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class CreateCampaignTargetDto {
  @IsUUID()
  contactId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_]+$/)
  strategyCode?: string;
}
