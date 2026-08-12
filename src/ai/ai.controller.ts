import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AiService } from './ai.service';
import { AiRunsQueryDto } from './dto/ai-runs-query.dto';

@Controller('ai')
export class AiController {
  constructor(private readonly service: AiService) {}

  @Post('conversations/:id/first-message')
  firstMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-openai-mock-scenario') scenario?: string,
  ) {
    return this.service.generateFirstMessage(id, scenario);
  }

  @Post('conversations/:id/process-message/:messageId')
  processMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Headers('x-openai-mock-scenario') scenario?: string,
  ) {
    return this.service.processClientMessage(id, messageId, scenario);
  }

  @Get('conversations/:id/runs')
  findRuns(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AiRunsQueryDto,
  ) {
    return this.service.findRuns(id, query);
  }

  @Get('runs/:id')
  findRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findRun(id);
  }

  @Post('conversations/:id/preview-context')
  previewContext(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.previewContext(id);
  }
}
