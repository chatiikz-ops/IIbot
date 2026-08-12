import { IsEnum } from 'class-validator';
import { LeadStatus } from '../../generated/prisma/enums';

export class UpdateLeadStatusDto {
  @IsEnum(LeadStatus)
  status!: LeadStatus;
}
