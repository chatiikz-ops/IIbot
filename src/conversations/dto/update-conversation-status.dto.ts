import { IsEnum } from 'class-validator';
import { ConversationStatus } from '../../generated/prisma/enums';

export class UpdateConversationStatusDto {
  @IsEnum(ConversationStatus)
  status!: ConversationStatus;
}
