export interface RpcError {
  code: number;
  message: string;
}

export interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: RpcError;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: Record<string, unknown> | null;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus: string;
}

export interface UiTokenAmount {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  programId: string;
  uiTokenAmount: UiTokenAmount;
}

export interface TransactionMeta {
  err: Record<string, unknown> | null;
  fee: number;
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

export interface TransactionResult {
  slot: number;
  meta: TransactionMeta | null;
  blockTime: number | null;
}

export interface WhaleAlert {
  whaleName: string;
  whaleAddress: string;
  tokenMint: string;
  tokenSymbol?: string;
  amount: number;
  amountUSD?: number;
  type: 'BUY' | 'SELL';
  signature: string;
  tradesLast24h: number;
  isFatWhale?: boolean;
  tokenAge?: string;
  tokenAgeMin?: number;
  txId?: number;
  preAmount?: number;
  postAmount?: number;
  maxPositionUSD?: number;
  signalReceivedAt: number;
}

export interface WhaleStats {
  totalTrades: number;
  recentMints: string[];
}

export interface WhaleListItem {
  id: number;
  name: string;
  address: string;
}

export interface WhaleDetail {
  id: number;
  address: string;
  name: string;
  isActive: boolean;
  totalTrades: number;
  recentMints: string[];
}

export interface GlobalStats {
  activeWhales: number;
  alertsLast24h: number;
  mostActiveWhale: { name: string; tradeCount: number } | null;
  sniperOfTheDay: { name: string; tokenMint: string; timestamp: Date } | null;
}
