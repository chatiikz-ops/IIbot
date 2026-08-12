import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AutomationEventsService } from './automation-events.service';
import { AutomationSettingsService } from './automation-settings.service';
import { ConversationOrchestratorService } from './conversation-orchestrator.service';
import { AutomationEventsQueryDto } from './dto/automation-events-query.dto';
import { UpdateAutomationSettingsDto } from './dto/update-automation-settings.dto';

@Controller('automation')
export class AutomationController {
  constructor(
    private readonly settings: AutomationSettingsService,
    private readonly events: AutomationEventsService,
    private readonly orchestrator: ConversationOrchestratorService,
  ) {}

  @Get('settings')
  getSettings() {
    return this.settings.get();
  }

  @Patch('settings')
  updateSettings(@Body() data: UpdateAutomationSettingsDto) {
    return this.settings.update(data);
  }

  @Post('campaign-targets/:targetId/start')
  startTarget(
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Headers('x-openai-mock-scenario') scenario?: string,
  ) {
    return this.orchestrator.startConversationForCampaignTarget(
      targetId,
      scenario,
    );
  }

  @Post('conversations/:conversationId/process-latest')
  processLatest(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Headers('x-openai-mock-scenario') scenario?: string,
  ) {
    return this.orchestrator.processLatestClientMessage(
      conversationId,
      scenario,
    );
  }

  @Get('events')
  getEvents(@Query() query: AutomationEventsQueryDto) {
    return this.events.findAll(query);
  }

  @Get('status')
  status() {
    return this.orchestrator.getStatus();
  }
}
