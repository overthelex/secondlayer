/**
 * Payment Controller
 * Business logic for payment processing
 */

import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../types/index.js';

export async function listPaymentMethods(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Payment methods not yet implemented' });
}

export async function addPaymentMethod(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Add payment method not yet implemented' });
}

export async function removePaymentMethod(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Remove payment method not yet implemented' });
}

export async function setDefaultPaymentMethod(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Set default payment method not yet implemented' });
}

export async function buyTokens(req: AuthenticatedRequest, res: Response) {
  res.status(501).json({ message: 'Buy tokens not yet implemented' });
}

export async function generateMonobankQR(req: AuthenticatedRequest, res: Response) {
  // Mockup response
  res.json({
    qrCode: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHRleHQ+TW9ja3VwIFFSPC90ZXh0Pjwvc3ZnPg==',
    status: 'pending',
    message: 'Monobank QR code generation (mockup mode)',
  });
}

export async function prepareCryptoPayment(req: AuthenticatedRequest, res: Response) {
  // Mockup response
  res.json({
    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    amount: req.body.amount_usd,
    status: 'pending',
    message: 'Crypto payment preparation (mockup mode)',
  });
}

export async function stripeWebhook(req: Request, res: Response) {
  res.status(501).json({ message: 'Stripe webhook not yet implemented' });
}

export async function monobankWebhook(req: Request, res: Response) {
  res.status(501).json({ message: 'Monobank webhook not yet implemented' });
}
