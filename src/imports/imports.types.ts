export const IMPORT_FIELDS = [
  'companyName',
  'phone',
  'whatsapp',
  'city',
  'category',
  'website',
  'instagram',
  'twoGisUrl',
  'bookingUrl',
  'email',
  'address',
  'notes',
] as const;

export const MAPPING_FIELDS = [...IMPORT_FIELDS, 'ignore'] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export type MappingField = (typeof MAPPING_FIELDS)[number];
export type ColumnMapping = Record<string, MappingField>;
export type RawImportRow = Record<string, string | null>;

export type NormalizedContactData = {
  companyName: string;
  phone: string;
  whatsapp: string | null;
  phoneSource: 'PHONE' | 'WHATSAPP';
  extraPhones: string[];
  city: string | null;
  category: string | null;
  website: string | null;
  instagram: string | null;
  twoGisUrl: string | null;
  bookingUrl: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
};
