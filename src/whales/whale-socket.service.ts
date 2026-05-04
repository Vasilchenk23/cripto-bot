import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { WhalesService } from './whales.service';
import { VirtualTraderService } from '../trading/virtual-trader.service';
import { TARGET_WHALE_ADDRESS } from '../config/constants';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WhaleSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhaleSocketService.name);
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isClosing = false;

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => WhalesService))
    private readonly whalesService: WhalesService,
    @Inject(forwardRef(() => VirtualTraderService))
    private readonly virtualTrader: VirtualTraderService,
    private readonly prisma: PrismaService,
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
    this.logger.log(`[WS] Connecting to ${wsUrl.slice(0, 30)}...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', async () => {
      this.logger.log('✅ Helius WebSocket connected');
      const request = {
        jsonrpc: '2.0',
        id: TARGET_WHALE_ADDRESS,
        method: 'logsSubscribe',
        params: [{ mentions: [TARGET_WHALE_ADDRESS] }, { commitment: 'confirmed' }],
      };
      this.ws!.send(JSON.stringify(request));
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (err) => {
      this.logger.error(`❌ WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`⚠️ WebSocket closed (code: ${code}, reason: ${reason})`);
      this.reconnect();
    });
  }

  private reconnect() {
    if (this.isClosing) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
  }

  private close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async handleMessage(data: WebSocket.Data) {
    const raw = data.toString();
    try {
      const msg = JSON.parse(raw);
      if (msg.result !== undefined && typeof msg.id === 'string') {
        this.logger.log(`[WS] Subscription OK for ${msg.id.slice(0, 8)}... (SubID: ${msg.result})`);
        return;
      }
      if (msg.error) {
        this.logger.error(`[WS] Subscription error: ${JSON.stringify(msg.error)}`);
        return;
      }
      if (msg.method === 'logsNotification' && msg.params?.result) {
        const signature = msg.params.result.value.signature;
        // Analyze transaction (returns {mint, symbol, side, priceUsd, amountUsd})
        const info = await this.whalesService.analyzeSignature(signature);
        if (!info) return;
        // Record whale move (isBot false)
        await this.prisma.trade.create({
          data: {
            tokenMint: info.mint,
            tokenSymbol: info.symbol,
            side: info.side,
            priceUsd: info.priceUsd,
            amountUsd: info.amountUsd,
            isBot: false,
          },
        });
        // Forward to virtual trader
        if (info.side === 'BUY') {
          await this.virtualTrader.onWhaleBuy(info.mint, info.symbol, info.priceUsd);
        } else if (info.side === 'SELL') {
          await this.virtualTrader.onWhaleSell(info.mint, info.priceUsd);
        }
      }
    } catch (e) {
      if (!raw.includes('Connection')) {
        this.logger.warn(`[WS] Parse error: ${raw.slice(0, 100)}`);
      }
    }
  }
}
