import { Injectable, OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class AutomationDelayService implements OnApplicationShutdown {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(key: string, delaySeconds: number, task: () => Promise<void>) {
    if (this.timers.has(key)) return false;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void task().catch(() => undefined);
    }, delaySeconds * 1000);
    this.timers.set(key, timer);
    return true;
  }

  get pendingCount() {
    return this.timers.size;
  }

  onApplicationShutdown() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
