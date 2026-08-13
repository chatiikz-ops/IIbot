import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { AdminRole } from '../generated/prisma/enums';
import { Roles } from '../auth/auth.decorators';
import { AdminUsersService } from './admin-users.service';
import { CreateAdminUserDto, UpdateAdminUserDto } from './dto/admin-user.dto';
@Roles(AdminRole.OWNER)
@Controller('admin-users')
export class AdminUsersController {
  constructor(private users: AdminUsersService) {}
  @Post() create(@Body() dto: CreateAdminUserDto) {
    return this.users.create(dto);
  }
  @Get() list() {
    return this.users.list();
  }
  @Get(':id') one(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.one(id);
  }
  @Patch(':id') update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminUserDto,
  ) {
    return this.users.update(id, dto);
  }
  @Post(':id/block') block(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.block(id);
  }
  @Post(':id/unblock') unblock(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.unblock(id);
  }
  @Post(':id/reset-password') reset(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.reset(id);
  }
}
