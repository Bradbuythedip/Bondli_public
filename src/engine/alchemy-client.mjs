/**
 * Alchemy Integration Layer
 *
 * Replaces all prior PumpPortal/Helius WebSocket calls with Alchemy SDK.
 * Provides:
 *   - WS subscription to pump.fun program for new token creates
 *   - Token metadata, holder snapshots, tx history
 *   - Bonding curve graduation webhooks
 *   - Reconnect with exponential backoff
 *
 * Never blocks the radar.
 */

import { Alchemy, Network } from 'alchemy-sdk';
import { EventEmitter } from 'events';

const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class AlchemyClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.ALCHEMY_API_KEY;
    this.network = config.network || Network.SOL_MAINNET;
    this.reconnectAttempts = 0;
    this.isConnected = false;
    this.subscriptions = new Map();

    if (!this.apiKey) {
      console.warn('[alchemy] No API key configured. Using fallback mode.');
    }

    this.alchemy = new Alchemy({
      apiKey: this.apiKey,
      network: this.network
    });
  }

  /**
   * Subscribe to pump.fun program logs for new token creates
   */
  async subscribePumpFunCreates() {
    try {
      const subId = await this.alchemy.ws.on(
        {
          method: 'logsSubscribe',
          params: [
            { mentions: [PUMP_FUN_PROGRAM_ID] },
            { commitment: 'confirmed' }
          ]
        },
        (log) => {
          try {
            this._handlePumpFunLog(log);
          } catch (err) {
            console.error('[alchemy] Error handling pump.fun log:', err.message);
          }
        }
      );

      this.subscriptions.set('pumpfun_creates', subId);
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log('[alchemy] Subscribed to pump.fun program logs');

      return subId;
    } catch (err) {
      console.error('[alchemy] Failed to subscribe to pump.fun:', err.message);
      this._scheduleReconnect('pumpfun_creates');
      return null;
    }
  }

  /**
   * Subscribe to a specific token's activity
   */
  async subscribeTokenActivity(tokenAddress) {
    try {
      const subId = await this.alchemy.ws.on(
        {
          method: 'logsSubscribe',
          params: [
            { mentions: [tokenAddress] },
            { commitment: 'confirmed' }
          ]
        },
        (log) => {
          this.emit('token_activity', { tokenAddress, log });
        }
      );

      this.subscriptions.set(`token_${tokenAddress}`, subId);
      return subId;
    } catch (err) {
      console.error(`[alchemy] Failed to subscribe to token ${tokenAddress}:`, err.message);
      return null;
    }
  }

  /**
   * Unsubscribe from a token's activity
   */
  async unsubscribeToken(tokenAddress) {
    const key = `token_${tokenAddress}`;
    const subId = this.subscriptions.get(key);
    if (subId) {
      try {
        await this.alchemy.ws.off(subId);
        this.subscriptions.delete(key);
      } catch {}
    }
  }

  /**
   * Get token metadata
   */
  async getTokenMetadata(tokenAddress) {
    try {
      return await this.alchemy.core.getTokenMetadata(tokenAddress);
    } catch (err) {
      console.error(`[alchemy] getTokenMetadata error for ${tokenAddress}:`, err.message);
      return null;
    }
  }

  /**
   * Get holder snapshot via getAssetsByOwner
   */
  async getHolderSnapshot(tokenAddress, options = {}) {
    try {
      const result = await this.alchemy.core.getTokenBalances(tokenAddress);
      return result;
    } catch (err) {
      console.error(`[alchemy] getHolderSnapshot error:`, err.message);
      return null;
    }
  }

  /**
   * Get transaction history for wallet tracing
   */
  async getWalletTransactions(walletAddress, options = {}) {
    try {
      const sigs = await this.alchemy.core.getSignaturesForAddress(
        walletAddress,
        { limit: options.limit || 20 }
      );
      return sigs;
    } catch (err) {
      console.error(`[alchemy] getWalletTransactions error:`, err.message);
      return [];
    }
  }

  /**
   * Get token balances for fleet wallet monitoring
   */
  async getFleetBalances(walletAddresses) {
    try {
      const results = await Promise.allSettled(
        walletAddresses.map(addr =>
          this.alchemy.core.getTokenBalances(addr)
        )
      );

      return walletAddresses.map((addr, i) => ({
        wallet: addr,
        balances: results[i].status === 'fulfilled' ? results[i].value : null
      }));
    } catch (err) {
      console.error('[alchemy] getFleetBalances error:', err.message);
      return [];
    }
  }

  /**
   * Build structural diversity graph for community module
   * Returns early buyers with their 2-hop transaction partners
   */
  async buildDiversityGraph(tokenAddress, limit = 50) {
    try {
      // Get recent transactions for the token
      const sigs = await this.getWalletTransactions(tokenAddress, { limit: 100 });

      // Extract unique buyers (addresses that interacted with the token)
      const buyers = new Set();
      for (const sig of sigs) {
        if (sig.from) buyers.add(sig.from);
        if (sig.to) buyers.add(sig.to);
      }

      const earlyBuyers = [...buyers].slice(0, limit);

      // For each buyer, get their transaction partners (2-hop graph)
      const graph = new Map();
      for (const buyer of earlyBuyers) {
        const buyerSigs = await this.getWalletTransactions(buyer, { limit: 20 });
        const partners = new Set();
        for (const sig of buyerSigs) {
          if (sig.from && sig.from !== buyer) partners.add(sig.from);
          if (sig.to && sig.to !== buyer) partners.add(sig.to);
        }
        graph.set(buyer, [...partners].slice(0, 50));
      }

      return { earlyBuyers, graph };
    } catch (err) {
      console.error('[alchemy] buildDiversityGraph error:', err.message);
      return { earlyBuyers: [], graph: new Map() };
    }
  }

  /**
   * Handle incoming pump.fun program logs
   */
  _handlePumpFunLog(log) {
    // Parse log for token creation events
    if (!log || !log.logs) return;

    const logStr = Array.isArray(log.logs) ? log.logs.join(' ') : String(log.logs);

    // Detect "create" instruction
    if (logStr.includes('Instruction: Create') || logStr.includes('InitializeMint')) {
      const tokenAddress = this._extractTokenAddress(log);
      if (tokenAddress) {
        this.emit('new_token', {
          tokenAddress,
          signature: log.signature,
          slot: log.slot,
          timestamp: Date.now()
        });
      }
    }

    // Detect bonding curve graduation
    if (logStr.includes('Graduated') || logStr.includes('BondingCurveComplete')) {
      const tokenAddress = this._extractTokenAddress(log);
      if (tokenAddress) {
        this.emit('graduation', {
          tokenAddress,
          signature: log.signature,
          timestamp: Date.now()
        });
      }
    }
  }

  /**
   * Extract token address from log accounts
   */
  _extractTokenAddress(log) {
    // The token mint is typically in the accounts array
    if (log.accountKeys && log.accountKeys.length > 0) {
      // Filter out known program IDs and system accounts
      const candidates = log.accountKeys.filter(key =>
        key !== PUMP_FUN_PROGRAM_ID &&
        key !== '11111111111111111111111111111111' &&
        key !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
      );
      return candidates[0] || null;
    }
    return null;
  }

  /**
   * Reconnect with exponential backoff
   */
  _scheduleReconnect(subscriptionType) {
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );

    console.log(`[alchemy] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        if (subscriptionType === 'pumpfun_creates') {
          await this.subscribePumpFunCreates();
        }
      } catch {
        this._scheduleReconnect(subscriptionType);
      }
    }, delay);
  }

  /**
   * Cleanup all subscriptions
   */
  async cleanup() {
    for (const [key, subId] of this.subscriptions) {
      try {
        await this.alchemy.ws.off(subId);
      } catch {}
    }
    this.subscriptions.clear();
    this.isConnected = false;
  }
}

export default AlchemyClient;
