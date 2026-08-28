import {
  Injectable,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createWhatsAppTransportProviders,
  WHATSAPP_TRANSPORT,
} from './transport/whatsapp-transport';

describe('WhatsApp transport DI lifecycle ownership', () => {
  it.each(['whatsapp-webjs', 'wppconnect'])(
    'initializes only selected %s provider once through a real app.init()',
    async (transport) => {
      const calls = { webInit: 0, webDestroy: 0, wppInit: 0, wppDestroy: 0 };
      @Injectable()
      class WebJsFake implements OnModuleInit, OnApplicationShutdown {
        onModuleInit() {
          calls.webInit += 1;
        }
        onApplicationShutdown() {
          calls.webDestroy += 1;
        }
      }
      @Injectable()
      class WppFake implements OnModuleInit, OnApplicationShutdown {
        onModuleInit() {
          calls.wppInit += 1;
        }
        onApplicationShutdown() {
          calls.wppDestroy += 1;
        }
      }
      @Module({
        providers: createWhatsAppTransportProviders(
          transport,
          WebJsFake,
          WppFake,
        ),
      })
      class LifecycleTestModule {}

      const testingModule = await Test.createTestingModule({
        imports: [LifecycleTestModule],
      }).compile();
      const app = testingModule.createNestApplication();
      await app.init();
      expect(app.get<unknown>(WHATSAPP_TRANSPORT)).toBe(
        app.get(transport === 'wppconnect' ? WppFake : WebJsFake),
      );
      expect(calls).toMatchObject(
        transport === 'wppconnect'
          ? { webInit: 0, wppInit: 1 }
          : { webInit: 1, wppInit: 0 },
      );
      await app.close();
      expect(calls).toMatchObject(
        transport === 'wppconnect'
          ? { webDestroy: 0, wppDestroy: 1 }
          : { webDestroy: 1, wppDestroy: 0 },
      );
    },
  );
});
