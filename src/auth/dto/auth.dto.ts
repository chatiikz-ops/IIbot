import { IsEmail, IsString, MinLength } from 'class-validator';
export class LoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
}
export class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString()
  @MinLength(8, { message: 'Новый пароль должен содержать минимум 8 символов' })
  newPassword!: string;
}
