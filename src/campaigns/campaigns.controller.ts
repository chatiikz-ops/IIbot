import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CampaignLogsQueryDto } from './dto/campaign-logs-query.dto';
import { CampaignTargetsQueryDto } from './dto/campaign-targets-query.dto';
import { CampaignsQueryDto } from './dto/campaigns-query.dto';
import { CreateCampaignTargetDto } from './dto/create-campaign-target.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { PreviewCampaignTargetsDto } from './dto/preview-campaign-targets.dto';
import { UpdateCampaignTargetStatusDto } from './dto/update-campaign-target-status.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly service: CampaignsService) {}

  @Post('preview-targets')
  previewTargets(@Body() data: PreviewCampaignTargetsDto) {
    return this.service.previewTargets(data);
  }

  @Post()
  create(@Body() data: CreateCampaignDto) {
    return this.service.create(data);
  }

  @Get()
  findAll(@Query() query: CampaignsQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateCampaignDto,
  ) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }

  @Post(':id/start')
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.start(id);
  }

  @Post(':id/pause')
  pause(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.pause(id);
  }

  @Post(':id/resume')
  resume(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.resume(id);
  }

  @Post(':id/complete')
  complete(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.complete(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(id);
  }

  @Get(':id/targets')
  findTargets(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CampaignTargetsQueryDto,
  ) {
    return this.service.findTargets(id, query);
  }

  @Post(':id/targets')
  addTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: CreateCampaignTargetDto,
  ) {
    return this.service.addTarget(id, data);
  }

  @Get(':id/targets/:targetId')
  findTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.service.findTarget(id, targetId);
  }

  @Patch(':id/targets/:targetId/status')
  updateTargetStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Body() data: UpdateCampaignTargetStatusDto,
  ) {
    return this.service.updateTargetStatus(id, targetId, data);
  }

  @Delete(':id/targets/:targetId')
  removeTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.service.removeTarget(id, targetId);
  }

  @Get(':id/logs')
  findLogs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CampaignLogsQueryDto,
  ) {
    return this.service.findLogs(id, query);
  }
}
