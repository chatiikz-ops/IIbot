import { Type } from 'class-transformer';
import { IsObject, ValidateNested } from 'class-validator';
import { CampaignFiltersDto } from './campaign-filters.dto';
import { CampaignSourceDto } from './campaign-source.dto';

export class PreviewCampaignTargetsDto extends CampaignSourceDto {
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignFiltersDto)
  filters!: CampaignFiltersDto;
}
