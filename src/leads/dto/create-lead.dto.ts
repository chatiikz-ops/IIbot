import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateLeadDto {
  @IsUUID()
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  summary!: string;

  @IsString()
  @IsNotEmpty()
  qualificationReason!: string;

  @IsOptional()
  @IsObject()
  extractedData?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  managerComment?: string;
}
