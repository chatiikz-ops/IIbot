import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class ClassifyAllQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  force: boolean = false;
}
