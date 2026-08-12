import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadsQueryDto } from './dto/leads-query.dto';
import { UpdateLeadCommentDto } from './dto/update-lead-comment.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly service: LeadsService) {}

  @Post()
  create(@Body() data: CreateLeadDto) {
    return this.service.create(data);
  }

  @Get()
  findAll(@Query() query: LeadsQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateLeadStatusDto,
  ) {
    return this.service.updateStatus(id, data);
  }

  @Patch(':id/comment')
  updateComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateLeadCommentDto,
  ) {
    return this.service.updateComment(id, data);
  }
}
