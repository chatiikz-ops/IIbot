import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from '../../generated/prisma/enums';

export class WhatsAppMessagesQueryDto {
  @IsOptional()
  @IsEnum(WhatsAppMessageDirection)
  direction?: WhatsAppMessageDirection;

  @IsOptional()
  @IsEnum(WhatsAppMessageStatus)
  status?: WhatsAppMessageStatus;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
