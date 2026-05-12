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
import { VirtualTraderService } from '../trading/virtual-trader.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEX_PROGRAM_IDS, TARGET_WHALE_ADDRESS } from '../config/constants';

type LogsNotificationParams = {
  subscription: number;
  result: {
    value: {
      signature: string;
      err: unknown;
      logs: string[];
    };
  };
};

@Injectable()
export class WhaleSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhaleSocketService.name);
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isClosing = false;

  // In-memory address list — no DB reads needed
  private trackedAddresses: string[] = [TARGET_WHALE_ADDRESS];
  private subIdToAddress = new Map<number, string>();
  private pendingAddresses = new Set<string>();

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

  // ─── Public API ───────────────────────────────────────────────────────────

  public getTrackedCount(): number {
    return this.trackedAddresses.length;
  }

  // Called by WhaleDiscoveryService after fetch+filter
  public updateTrackedAddresses(addresses: string[]) {
    this.trackedAddresses = [...new Set([TARGET_WHALE_ADDRESS, ...addresses])];
    this.logger.log(`[WS] Tracking ${this.trackedAddresses.length} addresses`);

    if (this.ws?.readyState === WebSocket.OPEN) {
      void this.resubscribeAll();
    }
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  private connect() {
    if (this.isClosing) return;
    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
    this.logger.log(`[WS] Connecting...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', async () => {
      this.logger.log('✅ Helius WebSocket connected');
      await this.subscribeAll();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      void this.handleMessage(data);
    });

    this.ws.on('error', (err) => {
      this.logger.error(`❌ WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`⚠️ WebSocket closed (code=${code}, reason=${reason})`);
      this.reconnect();
    });
  }

  private async resubscribeAll() {
    for (const [subId] of this.subIdToAddress) {
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id: `unsub_${subId}`,
        method: 'logsUnsubscribe',
        params: [subId],
      }));
    }
    this.subIdToAddress.clear();
    this.pendingAddresses.clear();
    await this.subscribeAll();
  }

  private subscribeAll() {
    for (const address of this.trackedAddresses) {
      this.pendingAddresses.add(address);
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id: address,
        method: 'logsSubscribe',
        params: [{ mentions: [address] }, { commitment: 'confirmed' }],
      }));
      this.logger.log(`[WS] Subscribing to ${address.slice(0, 8)}...`);
    }
  }

  private reconnect() {
    if (this.isClosing) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => this.connect(), 5_000);
  }

  private close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private async handleMessage(data: WebSocket.Data) {
    const raw = data.toString();
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;

      // Subscription confirmation
      if ('result' in msg && typeof msg.result === 'number' && typeof msg.id === 'string') {
        const address = msg.id;
        if (this.pendingAddresses.has(address)) {
          this.subIdToAddress.set(msg.result, address);
          this.pendingAddresses.delete(address);
          this.logger.log(`[WS] Confirmed ${address.slice(0, 8)}... SubID=${msg.result}`);
        }
        return;
      }

      if (msg.error) {
        this.logger.error(`[WS] Error: ${JSON.stringify(msg.error)}`);
        return;
      }

      if (msg.method !== 'logsNotification') return;

      const params = msg.params as LogsNotificationParams;
      const whaleAddress = this.subIdToAddress.get(params.subscription);
      if (!whaleAddress) return;

      const { signature, err, logs } = params.result.value;

      if (err) {
        this.logger.debug(`[WS] Tx ${signature.slice(0, 8)} failed on-chain`);
        return;
      }

      // ── DEX filter ────────────────────────────────────────────────────────
      const logText = logs.join(' ');
      const isDex = [...DEX_PROGRAM_IDS].some((id) => logText.includes(id));
      if (!isDex) {
        this.logger.debug(`[WS] ${signature.slice(0, 8)} — no DEX program, skip`);
        return;
      }

      this.logger.log(`[WS] Swap ${whaleAddress.slice(0, 8)} sig=${signature.slice(0, 8)}`);

      const info = await this.whalesService.analyzeSignature(signature, whaleAddress);
      if (!info) return;

      // Persist whale trade (signature deduplicates)
      try {
        await this.prisma.trade.upsert({
          where: { signature },
          update: {},
          create: {
            tokenMint: info.mint,
            tokenSymbol: info.symbol,
            side: info.side,
            priceUsd: info.priceUsd,
            amountUsd: info.amountUsd,
            isBot: false,
            signature,
          },
        });
      } catch (dbErr) {
        this.logger.error(`[DB] Save failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
      }

      if (info.side === 'BUY') {
        await this.virtualTrader.onWhaleBuy(info.mint, info.symbol, info.priceUsd);
      } else if (info.side === 'SELL') {
        await this.virtualTrader.onWhaleSell(info.mint, info.priceUsd, info.sellPercent);
      }
    } catch {
      if (!raw.includes('Connection')) {
        this.logger.warn(`[WS] Parse error: ${raw.slice(0, 120)}`);
      }
    }
  }
}
