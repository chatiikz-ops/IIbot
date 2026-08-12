import { IsEnum, IsUUID, ValidateIf } from 'class-validator';
import { CampaignSourceType } from '../../generated/prisma/enums';

export class CampaignSourceDto {
  @IsEnum(CampaignSourceType)
  sourceType!: CampaignSourceType;

  @ValidateIf(
    (data: CampaignSourceDto) =>
      data.sourceType === CampaignSourceType.IMPORT_JOB,
  )
  @IsUUID()
  sourceImportJobId?: string;
}
