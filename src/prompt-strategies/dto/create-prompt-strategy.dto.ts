import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreatePromptStrategyDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9_]+$/)
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}
