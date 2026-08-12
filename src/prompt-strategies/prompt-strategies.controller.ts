import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreatePromptStrategyDto } from './dto/create-prompt-strategy.dto';
import { CreatePromptVersionDto } from './dto/create-prompt-version.dto';
import { PromptStrategiesQueryDto } from './dto/prompt-strategies-query.dto';
import { PromptStrategiesService } from './prompt-strategies.service';
import { Roles } from '../auth/auth.decorators';
import { AdminRole } from '../generated/prisma/enums';

@Controller('prompt-strategies')
export class PromptStrategiesController {
  constructor(private readonly service: PromptStrategiesService) {}

  @Roles(AdminRole.OWNER)
  @Post()
  create(@Body() data: CreatePromptStrategyDto) {
    return this.service.create(data);
  }

  @Roles(AdminRole.OWNER)
  @Post('seed')
  seed() {
    return this.service.seed();
  }

  @Get()
  findAll(@Query() query: PromptStrategiesQueryDto) {
    return this.service.findAll(query);
  }

  @Get('code/:code/active')
  getActiveByCode(@Param('code') code: string) {
    return this.service.getActivePromptByCode(code);
  }

  @Get('code/:code')
  findByCode(@Param('code') code: string) {
    return this.service.findByCode(code);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Roles(AdminRole.OWNER)
  @Post(':id/versions')
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: CreatePromptVersionDto,
  ) {
    return this.service.createVersion(id, data);
  }

  @Get(':id/versions/:version')
  findVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.service.findVersion(id, version);
  }

  @Roles(AdminRole.OWNER)
  @Post(':id/versions/:version/activate')
  activateVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.service.activateVersion(id, version);
  }

  @Roles(AdminRole.OWNER)
  @Post(':id/archive')
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(id);
  }

  @Roles(AdminRole.OWNER)
  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.restore(id);
  }

  @Roles(AdminRole.OWNER)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
