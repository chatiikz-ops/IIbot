import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  normalizedEmail,
  optionalText,
  trimmedText,
} from '../../common/utils/contact-normalization.util';
import { ContactStatus } from '../../generated/prisma/enums';

export class CreateContactDto {
  @IsString()
  @Transform(({ value }) => trimmedText(value))
  @IsNotEmpty()
  @MaxLength(255)
  companyName!: string;

  @IsString()
  @Transform(({ value }) => trimmedText(value))
  @IsNotEmpty()
  @MaxLength(64)
  phone!: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => optionalText(value))
  @MaxLength(255)
  city?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => optionalText(value))
  @MaxLength(255)
  category?: string;

  @IsOptional()
  @Transform(({ value }) => optionalText(value))
  @IsString()
  @MaxLength(2048)
  website?: string | null;
  @IsOptional()
  @Transform(({ value }) => optionalText(value))
  @IsString()
  @MaxLength(2048)
  instagram?: string | null;
  @IsOptional()
  @Transform(({ value }) => optionalText(value))
  @IsString()
  @MaxLength(2048)
  twoGisUrl?: string | null;
  @IsOptional()
  @Transform(({ value }) => optionalText(value))
  @IsString()
  @MaxLength(2048)
  bookingUrl?: string | null;
  @IsOptional()
  @Transform(({ value }) => normalizedEmail(value))
  @IsEmail({}, { message: 'Некорректный email' })
  @MaxLength(320)
  email?: string | null;
  @IsOptional()
  @Transform(({ value }) => optionalText(value))
  @IsString()
  @MaxLength(1000)
  address?: string | null;
  @IsOptional()
  @Transform(({ value }) => optionalText(value))
  @IsString()
  @MaxLength(5000)
  notes?: string | null;

  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;
}
