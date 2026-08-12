import { IsString, MaxLength, MinLength } from 'class-validator';

export class SendContactWhatsAppMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;
}
