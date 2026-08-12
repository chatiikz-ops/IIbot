import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { MessageRole } from '../../generated/prisma/enums';

export class CreateMessageDto {
  @IsEnum(MessageRole)
  role!: MessageRole;

  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
