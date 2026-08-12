import { IsString } from 'class-validator';

export class UpdateLeadCommentDto {
  @IsString()
  managerComment!: string;
}
