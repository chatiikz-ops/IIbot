import { Module } from '@nestjs/common';
import { ClassificationModule } from '../classification/classification.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [ClassificationModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
