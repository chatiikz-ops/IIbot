import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class UpdateAutomationSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoReplyEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  campaignSendingEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAutoRepliesPerConversation?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300)
  responseDelayMinSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300)
  responseDelayMaxSeconds?: number;

  @IsOptional()
  @IsBoolean()
  workingHoursEnabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  workingHoursStart?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  workingHoursEnd?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}
