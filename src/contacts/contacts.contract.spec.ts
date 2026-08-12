/* eslint-disable @typescript-eslint/no-unsafe-assignment */
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {
      code = '';
    },
  },
}));

import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ClassificationService } from '../classification/classification.service';
import { Prisma } from '../generated/prisma/client';
import { CrmProvider } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

describe('Contacts production contract', () => {
  const baseContact = {
    id: 'contact-id',
    companyName: 'Salon',
    phone: '+77011112233',
    city: null,
    category: null,
    website: null,
    instagram: null,
    twoGisUrl: null,
    bookingUrl: null,
    email: null,
    address: null,
    notes: null,
    status: 'NEW',
    crmProvider: CrmProvider.UNKNOWN,
  };
  let prisma: { contact: { create: jest.Mock; update: jest.Mock } };
  let classification: { classifyContact: jest.Mock };
  let service: ContactsService;

  beforeEach(() => {
    prisma = { contact: { create: jest.fn(), update: jest.fn() } };
    classification = { classifyContact: jest.fn() };
    service = new ContactsService(
      prisma as unknown as PrismaService,
      classification as unknown as ClassificationService,
    );
  });

  it.each(['8 701 111 22 33', '+7 701 111 22 33', '87011112233'])(
    'normalizes Kazakhstan phone %s',
    async (phone) => {
      prisma.contact.create.mockResolvedValue(baseContact);
      classification.classifyContact.mockResolvedValue(baseContact);
      await service.create({ companyName: ' Salon ', phone });
      expect(prisma.contact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          companyName: 'Salon',
          phone: '+77011112233',
        }),
      });
    },
  );

  it('normalizes all URL-like and email fields and returns classification', async () => {
    const classified = { ...baseContact, crmProvider: CrmProvider.ALTEGIO };
    prisma.contact.create.mockResolvedValue(baseContact);
    classification.classifyContact.mockResolvedValue(classified);
    const result = await service.create({
      companyName: 'Salon',
      phone: '87011112233',
      website: 'example.com',
      instagram: '@beauty_room',
      twoGisUrl: 'https://2gis.kz/almaty',
      bookingUrl: 'app.alteg.io/1',
      email: 'TEST@EXAMPLE.COM',
      address: 'A',
      notes: 'N',
    });
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        website: 'https://example.com/',
        instagram: 'https://instagram.com/beauty_room',
        bookingUrl: 'https://app.alteg.io/1',
      }),
    });
    expect(result).toBe(classified);
  });

  it('keeps a created contact when non-critical classification fails', async () => {
    prisma.contact.create.mockResolvedValue(baseContact);
    classification.classifyContact.mockRejectedValue(
      new Error('classification'),
    );
    await expect(
      service.create({ companyName: 'Salon', phone: '87011112233' }),
    ).resolves.toBe(baseContact);
  });

  it('reclassifies sensitive PATCH and does not reclassify notes PATCH', async () => {
    prisma.contact.update.mockResolvedValue(baseContact);
    classification.classifyContact.mockResolvedValue(baseContact);
    await service.update('contact-id', { category: 'barber' });
    expect(classification.classifyContact).toHaveBeenCalledWith('contact-id');
    classification.classifyContact.mockClear();
    await service.update('contact-id', { notes: 'context' });
    expect(classification.classifyContact).not.toHaveBeenCalled();
  });

  it('maps a duplicate phone Prisma error to 409', async () => {
    const error = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
    Object.assign(error, { code: 'P2002' });
    prisma.contact.create.mockRejectedValue(error);
    await expect(
      service.create({ companyName: 'Salon', phone: '87011112233' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    ['website', 'javascript:alert(1)'],
    ['website', 'localhost'],
    ['instagram', 'https://example.com/user'],
    ['bookingUrl', 'file:///tmp/a'],
  ] as const)('rejects invalid %s', async (field, value) => {
    await expect(
      service.create({
        companyName: 'Salon',
        phone: '87011112233',
        [field]: value,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('validates full DTO and turns empty optional strings into null', async () => {
    const dto = plainToInstance(CreateContactDto, {
      companyName: 'Salon',
      phone: '87011112233',
      city: 'Almaty',
      category: 'Beauty',
      website: '',
      instagram: '',
      twoGisUrl: '',
      bookingUrl: '',
      email: '',
      address: '',
      notes: '',
      status: 'NEW',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto).toEqual(
      expect.objectContaining({ website: null, email: null, notes: null }),
    );
  });

  it.each([
    { companyName: '', phone: '87011112233' },
    { companyName: 'Salon', phone: '' },
    { companyName: 'Salon', phone: '87011112233', email: 'bad-email' },
    { companyName: 'x'.repeat(256), phone: '87011112233' },
  ])('rejects invalid DTO %#', async (input) => {
    expect(
      await validate(plainToInstance(CreateContactDto, input)),
    ).not.toHaveLength(0);
  });

  it('allows every documented PATCH business field', async () => {
    const dto = plainToInstance(UpdateContactDto, {
      companyName: 'Salon',
      phone: '87011112233',
      city: 'A',
      category: 'B',
      website: 'example.com',
      instagram: '@salon',
      twoGisUrl: '2gis.kz/x',
      bookingUrl: 'zapis.kz/x',
      email: 'a@example.com',
      address: 'A',
      notes: 'N',
      status: 'NEW',
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
