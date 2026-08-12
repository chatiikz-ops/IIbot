import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ContactStatus } from '../../generated/prisma/enums';

export class UpdateContactDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  companyName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;
}
