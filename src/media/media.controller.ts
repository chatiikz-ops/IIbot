import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { MediaQueryDto } from './dto/media-query.dto';
import { MediaService } from './media.service';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  findAll(@Query() query: MediaQueryDto) {
    return this.media.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.findOne(id);
  }
}
