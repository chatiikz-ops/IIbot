import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  TelegramNotificationStatus,
  TelegramNotificationType,
} from '../../generated/prisma/enums';

export class CreateTelegramRecipientDto {
  @IsString()
  @MaxLength(100)
  name!: string;
}

export class UpdateTelegramSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() notifyOnHandoff?: boolean;
  @IsOptional() @IsBoolean() notifyOnClientRequestedManager?: boolean;
  @IsOptional() @IsBoolean() notifyOnNewLead?: boolean;
  @IsOptional() @IsBoolean() notifyOnQualifiedLead?: boolean;
  @IsOptional() @IsBoolean() notifyOnAiUncertain?: boolean;
  @IsOptional() @IsBoolean() notifyOnAiFailure?: boolean;
  @IsOptional() @IsBoolean() notifyOnWhatsAppFailure?: boolean;
  @IsOptional() @IsBoolean() notifyOnMediaFailure?: boolean;
  @IsOptional() @IsBoolean() notifyOnAutomationFailure?: boolean;
  @IsOptional() @IsBoolean() notifyOnSystemError?: boolean;
}

export class TelegramNotificationsQueryDto {
  @IsOptional()
  @IsEnum(TelegramNotificationType)
  type?: TelegramNotificationType;
  @IsOptional()
  @IsEnum(TelegramNotificationStatus)
  status?: TelegramNotificationStatus;
  @IsOptional() @IsString() recipientId?: string;
  @Transform(({ value }) => Number(value ?? 1)) @IsInt() @Min(1) page = 1;
  @Transform(({ value }) => Number(value ?? 20))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
