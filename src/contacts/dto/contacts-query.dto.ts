import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  BusinessType,
  ContactStatus,
  CrmProvider,
} from '../../generated/prisma/enums';

export class ContactsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;

  @IsOptional() @IsEnum(CrmProvider) crmProvider?: CrmProvider;
  @IsOptional() @IsEnum(BusinessType) businessType?: BusinessType;
  @IsOptional() @Type(() => Boolean) outreachEligible?: boolean;
  @IsOptional() @IsString() strategyCode?: string;
  @IsOptional() @IsString() city?: string;
}
