import { Type } from 'class-transformer';
import {
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CampaignFiltersDto } from './campaign-filters.dto';
import { CampaignSettingsDto } from './campaign-settings.dto';

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignFiltersDto)
  filters?: CampaignFiltersDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignSettingsDto)
  settings?: CampaignSettingsDto;
}
