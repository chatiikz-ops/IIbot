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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportRowsQueryDto } from './dto/import-rows-query.dto';
import { UpdateMappingDto } from './dto/update-mapping.dto';
import { ImportsService } from './imports.service';

@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('preview')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
      fileFilter: (_request, file, callback) => {
        const allowed = /\.(xlsx|xls|csv)$/i.test(file.originalname);
        callback(
          allowed ? null : new Error('Unsupported spreadsheet type'),
          allowed,
        );
      },
    }),
  )
  preview(@UploadedFile() file?: Express.Multer.File) {
    return this.importsService.preview(file);
  }

  @Patch(':id/mapping')
  updateMapping(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: UpdateMappingDto,
  ) {
    return this.importsService.updateMapping(id, data.mapping);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.importsService.findOne(id);
  }

  @Get(':id/rows')
  findRows(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ImportRowsQueryDto,
  ) {
    return this.importsService.findRows(id, query);
  }

  @Post(':id/confirm')
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    return this.importsService.confirm(id);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.importsService.remove(id);
  }
}
