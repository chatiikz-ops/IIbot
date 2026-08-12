import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ClassificationService } from './classification.service';
import { ClassifyAllQueryDto } from './dto/classify-all-query.dto';

@Controller('classification')
export class ClassificationController {
  constructor(private readonly classificationService: ClassificationService) {}

  @Post('contacts/:id')
  classifyContact(@Param('id', ParseUUIDPipe) id: string) {
    return this.classificationService.classifyContact(id);
  }

  @Post('imports/:importId')
  classifyImport(@Param('importId', ParseUUIDPipe) importId: string) {
    return this.classificationService.classifyImport(importId);
  }

  @Post('all')
  classifyAll(@Query() query: ClassifyAllQueryDto) {
    return this.classificationService.classifyAll(query.force);
  }

  @Get('stats')
  getStats() {
    return this.classificationService.getStats();
  }
}
