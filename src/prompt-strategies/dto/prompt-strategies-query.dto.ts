import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PromptStrategyStatus } from '../../generated/prisma/enums';

export class PromptStrategiesQueryDto {
  @IsOptional()
  @IsEnum(PromptStrategyStatus)
  status?: PromptStrategyStatus;

  @IsOptional()
  @IsString()
  search?: string;

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
}
