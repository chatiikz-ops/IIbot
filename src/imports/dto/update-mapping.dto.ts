import { IsObject } from 'class-validator';

export class UpdateMappingDto {
  @IsObject()
  mapping!: Record<string, string>;
}
