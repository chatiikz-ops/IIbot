import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  BusinessType,
  ContactStatus,
  CrmProvider,
} from '../../generated/prisma/enums';

export class CampaignFiltersDto {
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @IsOptional()
  @IsEnum(CrmProvider)
  crmProvider?: CrmProvider;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @Transform(({ value }: TransformFnParams): unknown =>
    (value as unknown) === true || (value as unknown) === 'true'
      ? true
      : (value as unknown) === false || (value as unknown) === 'false'
        ? false
        : (value as unknown),
  )
  @IsBoolean()
  outreachEligible?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_]+$/)
  strategyCode?: string;

  @IsOptional()
  @IsEnum(ContactStatus)
  contactStatus?: ContactStatus;
}
