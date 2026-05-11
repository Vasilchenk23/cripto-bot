export const TARGET_WHALE_ADDRESS = 'EmDewJpfQaxWqxthX1FUyBCCPNGt8Ac5ek4M4pnGTgxC';
export const START_BALANCE      = 200.0;
export const TRADE_SIZE         = 10.0;
export const TP_1               = 1.20;   // sell 50% at +20%
export const TP_FINAL           = 1.50;   // sell rest at +50%
export const SL                 = 0.90;   // cut at -10%
export const SLIPPAGE_PENALTY   = 1.07;   // bot enters 7% above whale price
export const MAX_OPEN_POSITIONS = 5;
export const SOL_PRICE_REFRESH_MS = 30_000;
export const MIN_WHALE_PNL_24H  = 300;    // $ minimum daily PnL to track
export const MIN_WHALE_TRADES   = 3;      // minimum trades in discovery window
export const MAX_TRACKED_WHALES = 30;

// Known Solana DEX / AMM program IDs — used for early swap filter
export const DEX_PROGRAM_IDS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter v4
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',  // Moonshot
]);
