import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreateMessageDto } from './dto/create-message.dto';
import { MessagesQueryDto } from './dto/messages-query.dto';
import { MessagesService } from './messages.service';

@Controller('conversations/:conversationId/messages')
export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  @Post()
  create(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() data: CreateMessageDto,
  ) {
    return this.service.create(conversationId, data);
  }

  @Get()
  findAll(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: MessagesQueryDto,
  ) {
    return this.service.findAll(conversationId, query);
  }
}
