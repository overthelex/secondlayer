/**
 * Email Service
 * Handles transactional email notifications for billing events
 */

import nodemailer from 'nodemailer';
import { logger } from '../utils/logger.js';
import type { EmailPreferences } from './billing-service.js';

export interface EmailConfig {
  from: string;
  fromName: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth: {
      user: string;
      pass: string;
    };
  };
}

export interface PaymentSuccessParams {
  email: string;
  name: string;
  amount: number;
  currency: string;
  newBalance: number;
  paymentId: string;
}

export interface PaymentFailureParams {
  email: string;
  name: string;
  amount: number;
  currency: string;
  reason: string;
}

export interface LowBalanceParams {
  email: string;
  name: string;
  balance: number;
  currency: string;
}

export type PreferenceFetcher = (userId: string) => Promise<EmailPreferences>;

export class EmailService {
  private transporter: nodemailer.Transporter;
  private config: EmailConfig;
  private frontendUrl: string;
  private getPreferences?: PreferenceFetcher;

  constructor() {
    this.frontendUrl = process.env.FRONTEND_URL || 'https://billing.legal.org.ua';

    this.config = {
      from: process.env.EMAIL_FROM || 'noreply@legal.org.ua',
      fromName: process.env.EMAIL_FROM_NAME || 'SecondLayer Legal Platform',
      smtp: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
        },
      },
    };

    // Create transporter
    if (this.config.smtp.auth.user && this.config.smtp.auth.pass) {
      this.transporter = nodemailer.createTransport(this.config.smtp);
      logger.info('EmailService initialized with SMTP', {
        host: this.config.smtp.host,
      });
    } else {
      // Development mode: use JSON transport (log only)
      this.transporter = nodemailer.createTransport({
        jsonTransport: true,
      } as any);
      logger.warn('EmailService in development mode (no SMTP configured)');
    }
  }

  /**
   * Set the preference fetcher (called after construction to avoid circular deps)
   */
  setPreferenceFetcher(fetcher: PreferenceFetcher): void {
    this.getPreferences = fetcher;
  }

  /**
   * Send payment success notification
   */
  async sendPaymentSuccess(params: PaymentSuccessParams & { userId?: string }): Promise<void> {
    try {
      // Check user preferences if userId is available
      if (params.userId && this.getPreferences) {
        const prefs = await this.getPreferences(params.userId);
        if (!prefs.email_notifications || !prefs.notify_payment_success) {
          logger.info('Payment success email skipped due to user preferences', { userId: params.userId });
          return;
        }
      }

      const html = this.generatePaymentSuccessTemplate(params);

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: params.email,
        subject: `Payment Successful - ${params.currency} ${params.amount.toFixed(2)}`,
        html,
      });

      logger.info('Payment success email sent', {
        email: params.email,
        amount: params.amount,
        currency: params.currency,
      });
    } catch (error: any) {
      logger.error('Failed to send payment success email', {
        email: params.email,
        error: error.message,
      });
    }
  }

  /**
   * Send payment failure notification
   */
  async sendPaymentFailure(params: PaymentFailureParams & { userId?: string }): Promise<void> {
    try {
      // Check user preferences if userId is available
      if (params.userId && this.getPreferences) {
        const prefs = await this.getPreferences(params.userId);
        if (!prefs.email_notifications || !prefs.notify_payment_failure) {
          logger.info('Payment failure email skipped due to user preferences', { userId: params.userId });
          return;
        }
      }

      const html = this.generatePaymentFailureTemplate(params);

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: params.email,
        subject: `Payment Failed - ${params.currency} ${params.amount.toFixed(2)}`,
        html,
      });

      logger.info('Payment failure email sent', {
        email: params.email,
        amount: params.amount,
        currency: params.currency,
      });
    } catch (error: any) {
      logger.error('Failed to send payment failure email', {
        email: params.email,
        error: error.message,
      });
    }
  }

  /**
   * Send low balance alert
   */
  async sendLowBalanceAlert(params: LowBalanceParams & { userId?: string }): Promise<void> {
    try {
      // Check user preferences if userId is available
      if (params.userId && this.getPreferences) {
        const prefs = await this.getPreferences(params.userId);
        if (!prefs.email_notifications || !prefs.notify_low_balance) {
          logger.info('Low balance email skipped due to user preferences', { userId: params.userId });
          return;
        }
        // Use user's custom threshold
        if (params.balance >= prefs.low_balance_threshold_usd) {
          logger.info('Balance above user threshold, skipping alert', {
            userId: params.userId,
            balance: params.balance,
            threshold: prefs.low_balance_threshold_usd,
          });
          return;
        }
      }

      const html = this.generateLowBalanceTemplate(params);

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: params.email,
        subject: `Low Balance Alert - ${params.currency} ${params.balance.toFixed(2)}`,
        html,
      });

      logger.info('Low balance alert sent', {
        email: params.email,
        balance: params.balance,
        currency: params.currency,
      });
    } catch (error: any) {
      logger.error('Failed to send low balance alert', {
        email: params.email,
        error: error.message,
      });
    }
  }

  /**
   * Send email verification link
   */
  async sendVerificationEmail(email: string, token: string): Promise<void> {
    try {
      const verificationUrl = `${this.frontendUrl}/verify-email?token=${token}`;

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: email,
        subject: 'Verify your email - SecondLayer',
        html: this.generateVerificationEmailTemplate(email, verificationUrl),
      });

      logger.info('Verification email sent', { email });
    } catch (error: any) {
      logger.error('Failed to send verification email', {
        email,
        error: error.message,
      });
    }
  }

  /**
   * Send password reset link
   */
  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    try {
      const resetUrl = `${this.frontendUrl}/reset-password?token=${token}`;

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: email,
        subject: 'Reset your password - SecondLayer',
        html: this.generatePasswordResetEmailTemplate(email, resetUrl),
      });

      logger.info('Password reset email sent', { email });
    } catch (error: any) {
      logger.error('Failed to send password reset email', {
        email,
        error: error.message,
      });
    }
  }

  /**
   * Generate verification email template
   */
  private generateVerificationEmailTemplate(email: string, verificationUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #2196F3; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .button { display: inline-block; background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Verify Your Email</h1>
    </div>
    <div class="content">
      <p>Thank you for registering with SecondLayer!</p>
      <p>Please click the button below to verify your email address:</p>
      <p style="text-align: center;">
        <a href="${verificationUrl}" class="button">Verify Email</a>
      </p>
      <p>Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; font-size: 14px; color: #666;">${verificationUrl}</p>
      <p>This link is valid for 24 hours.</p>
      <p>If you didn't create an account, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} SecondLayer Legal Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate password reset email template
   */
  private generatePasswordResetEmailTemplate(email: string, resetUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #ff9800; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .button { display: inline-block; background: #2196F3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Password Reset</h1>
    </div>
    <div class="content">
      <p>You requested a password reset for your SecondLayer account.</p>
      <p>Click the button below to create a new password:</p>
      <p style="text-align: center;">
        <a href="${resetUrl}" class="button">Reset Password</a>
      </p>
      <p>Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; font-size: 14px; color: #666;">${resetUrl}</p>
      <p>This link is valid for 1 hour.</p>
      <p>If you didn't request a password reset, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} SecondLayer Legal Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate payment success email template
   */
  private generatePaymentSuccessTemplate(params: PaymentSuccessParams): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #4CAF50; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .amount { font-size: 32px; font-weight: bold; color: #4CAF50; margin: 20px 0; }
    .details { background: white; padding: 15px; border-radius: 5px; margin: 20px 0; }
    .button { display: inline-block; background: #2196F3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>✓ Payment Successful</h1>
    </div>
    <div class="content">
      <p>Hi ${params.name},</p>
      <p>Your payment has been successfully processed!</p>

      <div class="amount">${params.currency} ${params.amount.toFixed(2)}</div>

      <div class="details">
        <p><strong>Payment ID:</strong> ${params.paymentId}</p>
        <p><strong>New Balance:</strong> $${params.newBalance.toFixed(2)} USD</p>
      </div>

      <p>Your account has been credited and you can now use the SecondLayer API.</p>

      <a href="${this.frontendUrl}/dashboard" class="button">View Dashboard</a>

      <p>If you have any questions, please contact our support team.</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} SecondLayer Legal Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate payment failure email template
   */
  private generatePaymentFailureTemplate(params: PaymentFailureParams): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #f44336; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .amount { font-size: 28px; font-weight: bold; color: #f44336; margin: 20px 0; }
    .reason { background: #fff3cd; padding: 15px; border-left: 4px solid #ff9800; margin: 20px 0; }
    .button { display: inline-block; background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚠ Payment Failed</h1>
    </div>
    <div class="content">
      <p>Hi ${params.name},</p>
      <p>We were unable to process your payment.</p>

      <div class="amount">${params.currency} ${params.amount.toFixed(2)}</div>

      <div class="reason">
        <strong>Reason:</strong> ${params.reason}
      </div>

      <p>Please try again with a different payment method or contact your bank for more information.</p>

      <a href="${this.frontendUrl}/topup" class="button">Try Again</a>

      <p>If you continue to experience issues, please contact our support team.</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} SecondLayer Legal Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate low balance alert email template
   */
  private generateLowBalanceTemplate(params: LowBalanceParams): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #ff9800; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .balance { font-size: 32px; font-weight: bold; color: #ff9800; margin: 20px 0; }
    .warning { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; }
    .button { display: inline-block; background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ Low Balance Alert</h1>
    </div>
    <div class="content">
      <p>Hi ${params.name},</p>
      <p>Your SecondLayer account balance is running low.</p>

      <div class="balance">${params.currency} ${params.balance.toFixed(2)}</div>

      <div class="warning">
        ⚠️ You may not be able to use the API if your balance reaches $0.00
      </div>

      <p>Top up your account to continue using SecondLayer without interruption.</p>

      <a href="${this.frontendUrl}/topup" class="button">Top Up Now</a>

      <p>Need help? Contact our support team.</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} SecondLayer Legal Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }
}
