import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  contactId!: string;

  @IsString()
  @Matches(/^[A-Z0-9_]+$/)
  strategyCode!: string;

  @IsOptional()
  @IsUUID()
  promptStrategyId?: string;

  @IsOptional()
  @IsUUID()
  promptVersionId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
