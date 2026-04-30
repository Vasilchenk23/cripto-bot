import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { WhalesService } from './whales.service';

@Injectable()
export class WhaleSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhaleSocketService.name);
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isClosing = false;
  private pendingAddresses: Set<string> = new Set();

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => WhalesService))
    private readonly whalesService: WhalesService,
  ) {
    this.apiKey = this.configService.getOrThrow<string>('HELIUS_API_KEY');
  }

  async onModuleInit() {
    this.connect();
  }

  onModuleDestroy() {
    this.isClosing = true;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.close();
  }

  private connect() {
    if (this.isClosing) return;

    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', async () => {
      this.logger.log('Helius WebSocket connected');
      try {
        await this.subscribeToAllWhales();
        if (this.pendingAddresses.size > 0) {
          this.logger.log(
            `[WS] Processing ${this.pendingAddresses.size} pending subscriptions`,
          );
          this.pendingAddresses.forEach((addr) =>
            this.subscribeToAddress(addr),
          );
          this.pendingAddresses.clear();
        }
      } catch (err) {
        this.logger.error(
          `[WS] Error during initial subscriptions: ${err.message}`,
        );
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });

    this.ws.on('close', () => {
      this.logger.warn('WebSocket connection closed');
      this.reconnect();
    });
  }

  private reconnect() {
    if (this.isClosing) return;
    this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
  }

  private close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async subscribeToAllWhales() {
    this.logger.log('[WS] Fetching active whales for subscription...');
    const whales = await this.whalesService.getActiveWhales();
    this.logger.log(`[WS] Found ${whales.length} whales to subscribe`);

    for (const whale of whales) {
      this.subscribeToAddress(whale.address);
    }
  }

  public subscribeToAddress(address: string) {
    if (!this.ws) {
      this.pendingAddresses.add(address);
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAddresses.add(address);
      return;
    }

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [address] }, { commitment: 'confirmed' }],
    };

    this.logger.log(`[WS] Subscribing to address: ${address}`);
    this.ws.send(JSON.stringify(request));
  }

  private async handleMessage(data: WebSocket.Data) {
    const rawData = data.toString();
    this.logger.log(`[WS] Message received: ${rawData.slice(0, 100)}...`);

    if (rawData.startsWith('Connection')) {
      this.logger.log(`Helius Status: ${rawData}`);
      return;
    }

    try {
      const message = JSON.parse(rawData);

      if (message.result !== undefined && message.id !== undefined) {
        this.logger.log(
          `[WS] Subscription confirmed with result: ${message.result}`,
        );
        return;
      }

      if (message.method === 'logsNotification' && message.params?.result) {
        const signature = message.params.result.value.signature;
        this.logger.log(`[WS] Received log for signature: ${signature}`);
        await this.whalesService.handleLogNotification(signature);
      }
    } catch (error) {
      this.logger.warn(
        `Received non-JSON message or parse error: ${rawData.slice(0, 100)}...`,
      );
    }
  }
}
