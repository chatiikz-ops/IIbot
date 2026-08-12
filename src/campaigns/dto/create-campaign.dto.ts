import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CampaignFiltersDto } from './campaign-filters.dto';
import { CampaignSettingsDto } from './campaign-settings.dto';
import { CampaignSourceDto } from './campaign-source.dto';

export class CreateCampaignDto extends CampaignSourceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => CampaignFiltersDto)
  filters!: CampaignFiltersDto;

  @IsObject()
  @ValidateNested()
  @Type(() => CampaignSettingsDto)
  settings!: CampaignSettingsDto;
}
