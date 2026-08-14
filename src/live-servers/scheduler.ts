import type { LiveServerService } from "./service.js";

export class ExpirationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly service: LiveServerService, private readonly intervalMs: number) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.expireDue();
    } catch (error) {
      console.error("Expiration sweep failed", error);
    } finally {
      this.running = false;
    }
  }
}
