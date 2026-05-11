import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Api } from 'grammy';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly api: Api;
  private readonly adminId: string;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.adminId = this.configService.getOrThrow<string>('MY_TELEGRAM_ID');
    this.api = new Api(token);
  }

  async send(text: string): Promise<void> {
    try {
      await this.api.sendMessage(this.adminId, text, { parse_mode: 'HTML' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to send Telegram notification: ${msg}`);
    }
  }
}
