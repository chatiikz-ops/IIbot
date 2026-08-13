import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { AdminRole } from '../../generated/prisma/enums';
export class CreateAdminUserDto {
  @IsString() @MinLength(2) name!: string;
  @IsEmail() email!: string;
  @IsEnum(AdminRole) role!: AdminRole;
}
export class UpdateAdminUserDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsEnum(AdminRole) role?: AdminRole;
}
