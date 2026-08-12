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
import { ConversationsService } from './conversations.service';
import { ConversationsQueryDto } from './dto/conversations-query.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationStatusDto } from './dto/update-conversation-status.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly service: ConversationsService) {}

  @Post()
  create(@Body() data: CreateConversationDto) {
    return this.service.create(data);
  }

  @Get()
  findAll(@Query() query: ConversationsQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateConversationStatusDto,
  ) {
    return this.service.updateStatus(id, data);
  }
}
