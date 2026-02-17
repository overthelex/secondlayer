/**
 * MetaMask Payment Service
 * Handles MetaMask wallet payments — ETH + USDT/USDC on Ethereum and Polygon.
 * Verifies on-chain transactions using ethers v6.
 */

import { ethers } from 'ethers';
import { BillingService } from './billing-service.js';
import { EmailService } from './email-service.js';
import { invoiceService } from './invoice-service.js';
import { logger } from '../utils/logger.js';
import { BaseDatabase } from '@secondlayer/shared';

// ERC-20 contract addresses per network
const TOKEN_CONTRACTS: Record<string, Record<string, string>> = {
  ethereum: {
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  polygon: {
    usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
};

// Minimal ERC-20 ABI for Transfer event
const ERC20_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
];

export interface MetaMaskPaymentResult {
  paymentIntentId: string;
  walletAddress: string;
  network: string;
  token: string;
  cryptoAmount: string;
  exchangeRate: number;
  amountUsd: number;
}

export interface MetaMaskVerifyResult {
  status: 'succeeded' | 'failed' | 'pending';
  txHash: string;
  amountUsd: number;
  message?: string;
}

export class MetaMaskService {
  private receivingWallet: string;
  private providers: Record<string, ethers.JsonRpcProvider>;

  constructor(
    private billingService: BillingService,
    private emailService: EmailService,
    private db: BaseDatabase
  ) {
    this.receivingWallet = process.env.CRYPTO_RECEIVING_WALLET || '';

    if (!this.receivingWallet) {
      throw new Error('CRYPTO_RECEIVING_WALLET environment variable is required');
    }

    this.providers = {};
    if (process.env.ETHEREUM_RPC_URL) {
      this.providers.ethereum = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
    }
    if (process.env.POLYGON_RPC_URL) {
      this.providers.polygon = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    }

    logger.info('MetaMaskService initialized', {
      wallet: this.receivingWallet.substring(0, 10) + '...',
      networks: Object.keys(this.providers),
    });
  }

  /**
   * Create a payment intent for MetaMask payment
   */
  async createPaymentIntent(
    userId: string,
    amountUsd: number,
    email: string,
    network: string,
    token: string
  ): Promise<MetaMaskPaymentResult> {
    if (amountUsd < 1) {
      throw new Error('Minimum top-up amount is $1.00');
    }

    if (!['ethereum', 'polygon'].includes(network)) {
      throw new Error('Unsupported network. Use ethereum or polygon.');
    }

    const tokenLower = token.toLowerCase();
    if (!['eth', 'usdt', 'usdc'].includes(tokenLower)) {
      throw new Error('Unsupported token. Use ETH, USDT, or USDC.');
    }

    // For ETH, get current price; for stablecoins, 1:1
    let exchangeRate = 1;
    let cryptoAmount: string;

    if (tokenLower === 'eth') {
      exchangeRate = await this.getEthUsdPrice();
      cryptoAmount = (amountUsd / exchangeRate).toFixed(8);
    } else {
      cryptoAmount = amountUsd.toFixed(2);
    }

    // Create payment_intents record
    const externalId = `mm_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const result = await this.db.query(
      `INSERT INTO payment_intents
        (user_id, provider, external_id, amount_usd, status, crypto_network, crypto_token, crypto_amount, wallet_address, exchange_rate_usd, metadata)
       VALUES ($1, 'metamask', $2, $3, 'pending', $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [userId, externalId, amountUsd, network, tokenLower, cryptoAmount, this.receivingWallet, exchangeRate, JSON.stringify({ email })]
    );

    const paymentIntentId = result.rows[0].id;

    logger.info('MetaMask payment intent created', {
      paymentIntentId,
      userId,
      amountUsd,
      network,
      token: tokenLower,
      cryptoAmount,
    });

    return {
      paymentIntentId,
      walletAddress: this.receivingWallet,
      network,
      token: tokenLower,
      cryptoAmount,
      exchangeRate,
      amountUsd,
    };
  }

  /**
   * Verify an on-chain transaction matches the payment intent
   */
  async verifyTransaction(paymentIntentId: string, txHash: string): Promise<MetaMaskVerifyResult> {
    // Load payment intent
    const piResult = await this.db.query(
      'SELECT * FROM payment_intents WHERE id = $1 AND provider = $2',
      [paymentIntentId, 'metamask']
    );

    if (piResult.rows.length === 0) {
      throw new Error('Payment intent not found');
    }

    const pi = piResult.rows[0];

    if (pi.status === 'succeeded') {
      return { status: 'succeeded', txHash: pi.crypto_tx_hash, amountUsd: parseFloat(pi.amount_usd), message: 'Already verified' };
    }

    const network = pi.crypto_network as string;
    const provider = this.providers[network];
    if (!provider) {
      throw new Error(`No RPC provider configured for ${network}`);
    }

    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        // Tx not yet mined
        return { status: 'pending', txHash, amountUsd: parseFloat(pi.amount_usd), message: 'Transaction not yet confirmed' };
      }

      if (receipt.status !== 1) {
        await this.db.query('UPDATE payment_intents SET status = $1, crypto_tx_hash = $2, updated_at = NOW() WHERE id = $3', ['failed', txHash, paymentIntentId]);
        return { status: 'failed', txHash, amountUsd: parseFloat(pi.amount_usd), message: 'Transaction reverted on-chain' };
      }

      const token = pi.crypto_token as string;
      const expectedAmount = parseFloat(pi.crypto_amount);

      let verified = false;

      if (token === 'eth') {
        // Native ETH transfer — check tx value and recipient
        const tx = await provider.getTransaction(txHash);
        if (!tx) {
          return { status: 'pending', txHash, amountUsd: parseFloat(pi.amount_usd), message: 'Transaction data not available' };
        }

        const receivedEth = parseFloat(ethers.formatEther(tx.value));
        const tolerance = 0.01; // 1% tolerance
        const correctRecipient = tx.to?.toLowerCase() === this.receivingWallet.toLowerCase();
        const correctAmount = Math.abs(receivedEth - expectedAmount) / expectedAmount <= tolerance;

        verified = correctRecipient && correctAmount;
      } else {
        // ERC-20 transfer — parse Transfer event
        const contractAddress = TOKEN_CONTRACTS[network]?.[token];
        if (!contractAddress) {
          throw new Error(`Unknown token contract: ${token} on ${network}`);
        }

        const iface = new ethers.Interface(ERC20_TRANSFER_ABI);
        const transferTopic = iface.getEvent('Transfer')!.topicHash;

        const transferLog = receipt.logs.find(
          (log: any) =>
            log.address.toLowerCase() === contractAddress.toLowerCase() &&
            log.topics[0] === transferTopic
        );

        if (transferLog) {
          const parsed = iface.parseLog({ topics: transferLog.topics as string[], data: transferLog.data });
          if (parsed) {
            const to = parsed.args[1] as string;
            const value = parsed.args[2] as bigint;

            // USDT = 6 decimals, USDC = 6 decimals
            const decimals = 6;
            const received = parseFloat(ethers.formatUnits(value, decimals));
            const correctRecipient = to.toLowerCase() === this.receivingWallet.toLowerCase();
            const correctAmount = Math.abs(received - expectedAmount) / expectedAmount <= 0.001; // 0.1% for stablecoins

            verified = correctRecipient && correctAmount;
          }
        }
      }

      if (!verified) {
        await this.db.query('UPDATE payment_intents SET status = $1, crypto_tx_hash = $2, updated_at = NOW() WHERE id = $3', ['failed', txHash, paymentIntentId]);
        return { status: 'failed', txHash, amountUsd: parseFloat(pi.amount_usd), message: 'Transaction does not match expected payment (wrong recipient or amount)' };
      }

      // Mark succeeded and credit balance
      await this.db.query(
        'UPDATE payment_intents SET status = $1, crypto_tx_hash = $2, updated_at = NOW() WHERE id = $3',
        ['succeeded', txHash, paymentIntentId]
      );

      const transaction = await this.billingService.topUpBalance({
        userId: pi.user_id,
        amountUsd: parseFloat(pi.amount_usd),
        description: `MetaMask payment (${token.toUpperCase()} on ${network}): ${txHash}`,
        paymentProvider: 'metamask',
        paymentId: paymentIntentId,
        metadata: { txHash, network, token },
      });

      const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
      await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

      logger.info('MetaMask payment verified and credited', {
        paymentIntentId,
        txHash,
        amountUsd: pi.amount_usd,
        transactionId: transaction.id,
      });

      // Send confirmation email
      const metadata = JSON.parse(pi.metadata || '{}');
      if (metadata.email) {
        await this.emailService.sendPaymentSuccess({
          email: metadata.email,
          name: 'User',
          amount: parseFloat(pi.amount_usd),
          currency: 'USD',
          newBalance: transaction.balance_after_usd,
          paymentId: paymentIntentId,
          userId: pi.user_id,
        });
      }

      return { status: 'succeeded', txHash, amountUsd: parseFloat(pi.amount_usd) };
    } catch (error: any) {
      logger.error('MetaMask verification failed', { paymentIntentId, txHash, error: error.message });
      throw error;
    }
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(paymentIntentId: string): Promise<{ status: string; amount: number; currency: string; network?: string; token?: string; txHash?: string }> {
    const result = await this.db.query(
      'SELECT status, amount_usd, crypto_network, crypto_token, crypto_tx_hash FROM payment_intents WHERE id = $1 AND provider = $2',
      [paymentIntentId, 'metamask']
    );

    if (result.rows.length === 0) {
      throw new Error('Payment intent not found');
    }

    const row = result.rows[0];
    return {
      status: row.status,
      amount: parseFloat(row.amount_usd),
      currency: 'usd',
      network: row.crypto_network,
      token: row.crypto_token,
      txHash: row.crypto_tx_hash,
    };
  }

  /**
   * Get ETH/USD price from CoinGecko
   */
  private async getEthUsdPrice(): Promise<number> {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
      const data = await response.json() as any;
      const price = data?.ethereum?.usd;
      if (!price || typeof price !== 'number') {
        throw new Error('Invalid price response from CoinGecko');
      }
      return price;
    } catch (error: any) {
      logger.error('Failed to fetch ETH/USD price', { error: error.message });
      throw new Error('Unable to fetch current ETH price. Please try again later.');
    }
  }
}
