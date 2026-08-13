import { BadRequestException } from '@nestjs/common';
import * as path from 'node:path';
import * as XLSX from 'xlsx';

const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_SHEETS = 10;
const MAX_CELLS = 500_000;

export function parseSpreadsheet(file?: Express.Multer.File) {
  if (!file) {
    throw new BadRequestException('Файл не передан');
  }

  const extension = path.extname(file.originalname).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new BadRequestException('Поддерживаются только XLSX, XLS и CSV');
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new BadRequestException('Размер файла превышает 10 МБ');
  }

  if (!hasExpectedSignature(extension, file.buffer)) {
    throw new BadRequestException(
      'Содержимое файла не соответствует его формату',
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, { type: 'buffer', raw: false });
  } catch {
    throw new BadRequestException('Некорректный формат файла');
  }

  if (workbook.SheetNames.length > MAX_SHEETS) {
    throw new BadRequestException('Файл содержит слишком много листов');
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new BadRequestException('Файл не содержит данных');
  }
  const range = workbook.Sheets[firstSheetName]['!ref'];
  if (range) {
    const decoded = XLSX.utils.decode_range(range);
    const cells =
      (decoded.e.r - decoded.s.r + 1) * (decoded.e.c - decoded.s.c + 1);
    if (cells > MAX_CELLS) {
      throw new BadRequestException('Файл содержит слишком много ячеек');
    }
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(
    workbook.Sheets[firstSheetName],
    {
      header: 1,
      defval: null,
      blankrows: false,
      raw: false,
    },
  );

  if (matrix.length < 2) {
    throw new BadRequestException('Файл не содержит данных');
  }

  const headers = makeUniqueHeaders(matrix[0]);
  if (headers.every((header) => !header)) {
    throw new BadRequestException('Файл не содержит данных');
  }

  const rows = matrix
    .slice(1)
    .map((values, index) => ({
      rowNumber: index + 2,
      rawData: Object.fromEntries(
        headers.map((header, columnIndex) => [
          header,
          toNullableString(values[columnIndex]),
        ]),
      ),
    }))
    .filter(({ rawData }) =>
      Object.values(rawData).some((value) => value !== null),
    );

  if (rows.length === 0) {
    throw new BadRequestException('Файл не содержит данных');
  }

  if (rows.length > MAX_ROWS) {
    throw new BadRequestException('Файл содержит более 20 000 строк');
  }

  return { headers, rows };
}

function hasExpectedSignature(extension: string, buffer: Buffer) {
  if (extension === '.xlsx') {
    return (
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04
    );
  }
  if (extension === '.xls') {
    const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return signature.every((byte, index) => buffer[index] === byte);
  }
  return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

function makeUniqueHeaders(values: unknown[]): string[] {
  const counts = new Map<string, number>();

  return values.map((value, index) => {
    const base = toNullableString(value) ?? `column_${index + 1}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : value instanceof Date
          ? value.toISOString()
          : '';
  return normalized.length > 0 ? normalized : null;
}
