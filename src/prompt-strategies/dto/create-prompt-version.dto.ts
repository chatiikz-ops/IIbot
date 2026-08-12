import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreatePromptVersionDto {
  @IsString()
  @IsNotEmpty()
  systemInstruction!: string;

  @IsString()
  @IsNotEmpty()
  objective!: string;

  @IsString()
  @IsNotEmpty()
  firstMessage!: string;

  @IsString()
  @IsNotEmpty()
  communicationRules!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  qualificationQuestions!: string[];

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  sellingPoints!: string[];

  @IsOptional()
  @IsString()
  competitorContext?: string;

  @IsString()
  @IsNotEmpty()
  handoffRules!: string;

  @IsString()
  @IsNotEmpty()
  stopRules!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  forbiddenActions!: string[];

  @IsString()
  @IsNotEmpty()
  closingRules!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  maxAssistantMessages!: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  changeNote?: string;
}
