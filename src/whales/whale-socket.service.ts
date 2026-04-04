import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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

  constructor(
    private readonly configService: ConfigService,
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

    this.ws.on('open', () => {
      this.logger.log('Helius WebSocket connected');
      this.subscribeToAllWhales();
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
    const whales = await this.whalesService.getActiveWhales();

    for (const whale of whales) {
      this.subscribeToAddress(whale.address);
    }
  }

  public subscribeToAddress(address: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        { accountInclude: [address] },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    this.ws.send(JSON.stringify(request));
  }

  private async handleMessage(data: WebSocket.Data) {
    try {
      const message = JSON.parse(data.toString());

      if (message.method === 'transactionNotification' && message.params?.result) {
        const result = message.params.result;
        await (this.whalesService as any).handleRealTimeTransaction(result);
      }
    } catch (error) {
      this.logger.error(`Error handling WebSocket message: ${error.message}`);
    }
  }
}
