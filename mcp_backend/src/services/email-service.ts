/**
 * Email Service
 * Handles transactional email notifications for billing events
 */

import nodemailer from 'nodemailer';
import type { Mail } from 'nodemailer';
// nodemailer 10 ships its own types (no `nodemailer.*` namespace): SendMailOptions is the
// first parameter of Mail#sendMail.
type SendMailOptions = Parameters<Mail['sendMail']>[0];
import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { maskSensitive } from '../utils/sanitize-log.js';
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

export interface AdminCreditParams {
  email: string;
  name: string;
  amount: number;
  currency: string;
  newBalance: number;
}

export interface LowBalanceParams {
  email: string;
  name: string;
  balance: number;
  currency: string;
}

export interface ReferralData {
  referralCode: string | null;
  totalReferrals: number;
  totalEarnedUsd: number;
  totalEarnedUah: number;
  isVerified: boolean;
}

export type PreferenceFetcher = (userId: string) => Promise<EmailPreferences>;
export type ReferralDataFetcher = (userId: string) => Promise<ReferralData>;

export class EmailService {
  private transporter: Mail;
  private config: EmailConfig;
  private frontendUrl: string;
  private getPreferences?: PreferenceFetcher;
  private getReferralData?: ReferralDataFetcher;
  private logoBuffer: Buffer | null = null;
  private fractalBuffer: Buffer | null = null;

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

    // Load logo and fractal banner for email templates
    try {
      const logoPath = join(__dirname, '..', '..', 'assets', 'logolex_dark.png');
      this.logoBuffer = readFileSync(logoPath);
      logger.info('LEX logo loaded for email templates');
    } catch {
      logger.warn('LEX logo not found at assets/logolex_dark.png — emails will render without logo');
    }
    try {
      const fractalPath = join(__dirname, '..', '..', 'assets', 'email-header-fractal.png');
      this.fractalBuffer = readFileSync(fractalPath);
      logger.info('Fractal header banner loaded for email templates');
    } catch {
      logger.warn('Fractal banner not found at assets/email-header-fractal.png — emails will use plain header');
    }

    // Create transporter
    if (this.config.smtp.auth.user && this.config.smtp.auth.pass) {
      this.transporter = nodemailer.createTransport(this.config.smtp);
      logger.info('EmailService initialized with SMTP (authenticated)', {
        host: this.config.smtp.host,
      });
    } else if (process.env.SMTP_HOST) {
      // IP-based auth (no credentials) — e.g. postfix with mynetworks
      this.transporter = nodemailer.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
        tls: { rejectUnauthorized: false },
      });
      logger.info('EmailService initialized with SMTP (IP-based auth)', {
        host: this.config.smtp.host,
        port: this.config.smtp.port,
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
   * Set the referral data fetcher (called after construction to avoid circular deps)
   */
  setReferralDataFetcher(fetcher: ReferralDataFetcher): void {
    this.getReferralData = fetcher;
  }

  /**
   * Send test email — throws on failure so the caller can report the error.
   * All other send methods swallow errors to avoid disrupting payment flows;
   * this method is intentionally different so the /api/billing/test-email route
   * can surface SMTP failures to the user.
   */
  async sendTestEmailTo(email: string, name: string): Promise<void> {
    const html = this.generatePaymentSuccessTemplate(
      {
        email,
        name,
        amount: 25.00,
        currency: 'USD',
        paymentId: 'TEST-' + Date.now(),
        newBalance: 100.00,
      },
      null,
    );

    const attachments: SendMailOptions['attachments'] = [];
    if (this.logoBuffer) {
      attachments.push({
        filename: 'logolex.png',
        content: this.logoBuffer,
        cid: 'lexlogo@legal.org.ua',
      });
    }
    if (this.fractalBuffer) {
      attachments.push({
        filename: 'email-header-fractal.png',
        content: this.fractalBuffer,
        cid: 'fractal-header@legal.org.ua',
      });
    }

    // Throws on SMTP error — intentionally not caught here
    await this.transporter.sendMail({
      from: `"${this.config.fromName}" <${this.config.from}>`,
      to: email,
      subject: 'LEX — Тестовий лист (перевірка сповіщень)',
      html,
      attachments,
    });

    logger.info('Test email sent successfully', { email });
  }

  /**
   * Send payment success notification with LEX branding and referral data
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

      // Fetch referral data if available
      let referralData: ReferralData | null = null;
      if (params.userId && this.getReferralData) {
        try {
          referralData = await this.getReferralData(params.userId);
        } catch (err: any) {
          logger.warn('Failed to fetch referral data for payment email', { userId: params.userId, error: err.message });
        }
      }

      const html = this.generatePaymentSuccessTemplate(params, referralData);

      const attachments: SendMailOptions['attachments'] = [];
      if (this.logoBuffer) {
        attachments.push({
          filename: 'logolex.png',
          content: this.logoBuffer,
          cid: 'lexlogo@legal.org.ua',
        });
      }
      if (this.fractalBuffer) {
        attachments.push({
          filename: 'email-header-fractal.png',
          content: this.fractalBuffer,
          cid: 'fractal-header@legal.org.ua',
        });
      }

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: params.email,
        subject: `LEX — Оплата успішна: ${params.currency} ${params.amount.toFixed(2)}`,
        html,
        attachments,
      });

      logger.info('Payment success email sent', {
        amount: params.amount,
        currency: params.currency,
        hasReferralData: !!referralData,
      });
    } catch (error: any) {
      logger.error('Failed to send payment success email', {
        errorMessage: String(error.message).substring(0, 100),
      });
    }
  }

  /**
   * Send admin credit notification (test account invitation)
   */
  async sendAdminCredit(params: AdminCreditParams): Promise<void> {
    try {
      const html = this.generateAdminCreditTemplate(params);

      const attachments: SendMailOptions['attachments'] = [];
      if (this.logoBuffer) {
        attachments.push({
          filename: 'logolex.png',
          content: this.logoBuffer,
          cid: 'lexlogo@legal.org.ua',
        });
      }
      if (this.fractalBuffer) {
        attachments.push({
          filename: 'email-header-fractal.png',
          content: this.fractalBuffer,
          cid: 'fractal-header@legal.org.ua',
        });
      }

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: params.email,
        subject: `LEX — Вам надано тестовий доступ: ${params.currency} ${params.amount.toFixed(2)}`,
        html,
        attachments,
      });

      logger.info('Admin credit email sent', {
        amount: params.amount,
        currency: params.currency,
      });
    } catch (error: any) {
      logger.error('Failed to send admin credit email', {
        errorMessage: String(error.message).substring(0, 100),
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
        amount: params.amount,
        currency: params.currency,
      });
    } catch (error: any) {
      logger.error('Failed to send payment failure email', {
        errorMessage: String(error.message).substring(0, 100),
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
        balance: params.balance,
        currency: params.currency,
      });
    } catch (error: any) {
      logger.error('Failed to send low balance alert', {
        errorMessage: String(error.message).substring(0, 100),
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
   * Warn a user that the password they just logged in with is in a known data breach
   * (Cloudflare leaked-credentials detection). Sent at most once a week per user.
   */
  async sendLeakedPasswordWarning(email: string): Promise<void> {
    try {
      const loginUrl = `${this.frontendUrl}/login`;

      await this.transporter.sendMail({
        from: `"${this.config.fromName}" <${this.config.from}>`,
        to: email,
        subject: 'Ваш пароль є у відомих витоках даних - SecondLayer',
        html: this.generateLeakedPasswordEmailTemplate(loginUrl),
      });

      logger.info('Leaked password warning sent', { email });
    } catch (error: any) {
      logger.error('Failed to send leaked password warning', {
        email,
        error: error.message,
      });
    }
  }

  // ─── Consultation Email Notifications ───────────────────────

  /**
   * Send notification about a new consultation request (to attorney)
   */
  async sendConsultationRequestEmail(params: {
    email: string;
    attorneyName: string;
    clientName: string;
    requestTitle: string;
    consultationId: string;
  }): Promise<void> {
    try {
      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Нова заявка на консультацію від ${params.clientName}`,
        heading: 'Нова заявка на консультацію',
        body: `<p>Шановний(-а) ${params.attorneyName},</p>
               <p>Ви отримали нову заявку на консультацію:</p>
               <p><strong>${params.requestTitle}</strong></p>
               <p>Від клієнта: ${params.clientName}</p>`,
        actionUrl: `${this.frontendUrl}/consultations/${params.consultationId}`,
        actionText: 'Переглянути заявку',
      });
      logger.info('Consultation request email sent', { consultationId: params.consultationId });
    } catch (error: any) {
      logger.error('Failed to send consultation request email', { error: error.message });
    }
  }

  /**
   * Send notification that attorney accepted consultation (to client)
   */
  async sendConsultationAcceptedEmail(params: {
    email: string;
    clientName: string;
    attorneyName: string;
    requestTitle: string;
    agreedFeeUah: number;
    consultationId: string;
  }): Promise<void> {
    try {
      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Адвокат ${params.attorneyName} прийняв вашу заявку`,
        heading: 'Заявку прийнято',
        body: `<p>Вітаємо, ${params.clientName}!</p>
               <p>Адвокат <strong>${params.attorneyName}</strong> прийняв вашу заявку «${params.requestTitle}».</p>
               <p>Узгоджена вартість: <strong>${params.agreedFeeUah} грн</strong></p>
               <p>Для продовження необхідно здійснити оплату.</p>`,
        actionUrl: `${this.frontendUrl}/consultations/${params.consultationId}`,
        actionText: 'Перейти до оплати',
      });
      logger.info('Consultation accepted email sent', { consultationId: params.consultationId });
    } catch (error: any) {
      logger.error('Failed to send consultation accepted email', { error: error.message });
    }
  }

  /**
   * Send notification that attorney declined consultation (to client)
   */
  async sendConsultationDeclinedEmail(params: {
    email: string;
    clientName: string;
    attorneyName: string;
    requestTitle: string;
    reason?: string;
    consultationId: string;
  }): Promise<void> {
    try {
      const reasonText = params.reason
        ? `<p>Причина: ${params.reason}</p>`
        : '';
      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Адвокат відхилив заявку «${params.requestTitle}»`,
        heading: 'Заявку відхилено',
        body: `<p>Шановний(-а) ${params.clientName},</p>
               <p>На жаль, адвокат <strong>${params.attorneyName}</strong> відхилив вашу заявку «${params.requestTitle}».</p>
               ${reasonText}
               <p>Ви можете звернутися до іншого адвоката на платформі.</p>`,
        actionUrl: `${this.frontendUrl}/attorneys`,
        actionText: 'Знайти адвоката',
      });
      logger.info('Consultation declined email sent', { consultationId: params.consultationId });
    } catch (error: any) {
      logger.error('Failed to send consultation declined email', { error: error.message });
    }
  }

  /**
   * Send notification that payment was confirmed/held in escrow (to both parties)
   */
  async sendConsultationPaidEmail(params: {
    email: string;
    recipientName: string;
    otherPartyName: string;
    requestTitle: string;
    amountUah: number;
    consultationId: string;
    isAttorney: boolean;
  }): Promise<void> {
    try {
      const body = params.isAttorney
        ? `<p>Шановний(-а) ${params.recipientName},</p>
           <p>Клієнт ${params.otherPartyName} здійснив оплату <strong>${params.amountUah} грн</strong> за консультацію «${params.requestTitle}».</p>
           <p>Кошти утримуються на ескроу-рахунку. Ви можете розпочати консультацію.</p>`
        : `<p>Вітаємо, ${params.recipientName}!</p>
           <p>Ваша оплата <strong>${params.amountUah} грн</strong> за консультацію «${params.requestTitle}» підтверджена.</p>
           <p>Кошти утримуються на ескроу-рахунку до завершення консультації.</p>`;

      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Оплату підтверджено: ${params.requestTitle}`,
        heading: 'Оплату підтверджено',
        body,
        actionUrl: `${this.frontendUrl}/consultations/${params.consultationId}`,
        actionText: params.isAttorney ? 'Розпочати консультацію' : 'Переглянути консультацію',
      });
      logger.info('Consultation paid email sent', { consultationId: params.consultationId, isAttorney: params.isAttorney });
    } catch (error: any) {
      logger.error('Failed to send consultation paid email', { error: error.message });
    }
  }

  /**
   * Send notification that consultation was completed (to client)
   */
  async sendConsultationCompletedEmail(params: {
    email: string;
    clientName: string;
    attorneyName: string;
    requestTitle: string;
    consultationId: string;
  }): Promise<void> {
    try {
      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Консультацію завершено: ${params.requestTitle}`,
        heading: 'Консультацію завершено',
        body: `<p>Вітаємо, ${params.clientName}!</p>
               <p>Адвокат <strong>${params.attorneyName}</strong> завершив консультацію «${params.requestTitle}».</p>
               <p>Кошти з ескроу-рахунку буде перераховано адвокату.</p>
               <p>Будь ласка, залиште відгук про якість консультації.</p>`,
        actionUrl: `${this.frontendUrl}/consultations/${params.consultationId}`,
        actionText: 'Залишити відгук',
      });
      logger.info('Consultation completed email sent', { consultationId: params.consultationId });
    } catch (error: any) {
      logger.error('Failed to send consultation completed email', { error: error.message });
    }
  }

  /**
   * Send notification that consultation was cancelled (to other party)
   */
  async sendConsultationCancelledEmail(params: {
    email: string;
    recipientName: string;
    cancelledByName: string;
    requestTitle: string;
    reason?: string;
    consultationId: string;
  }): Promise<void> {
    try {
      const reasonText = params.reason
        ? `<p>Причина: ${params.reason}</p>`
        : '';
      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Консультацію скасовано: ${params.requestTitle}`,
        heading: 'Консультацію скасовано',
        body: `<p>Шановний(-а) ${params.recipientName},</p>
               <p>Консультацію «${params.requestTitle}» було скасовано користувачем ${params.cancelledByName}.</p>
               ${reasonText}
               <p>Якщо було здійснено оплату, кошти буде повернено на ваш рахунок.</p>`,
        actionUrl: `${this.frontendUrl}/consultations/${params.consultationId}`,
        actionText: 'Переглянути деталі',
      });
      logger.info('Consultation cancelled email sent', { consultationId: params.consultationId });
    } catch (error: any) {
      logger.error('Failed to send consultation cancelled email', { error: error.message });
    }
  }

  /**
   * Send notification that a dispute was opened (to other party)
   */
  async sendConsultationDisputeEmail(params: {
    email: string;
    recipientName: string;
    raisedByName: string;
    requestTitle: string;
    reason: string;
    consultationId: string;
  }): Promise<void> {
    try {
      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Відкрито спір: ${params.requestTitle}`,
        heading: 'Відкрито спір',
        body: `<p>Шановний(-а) ${params.recipientName},</p>
               <p>Користувач ${params.raisedByName} відкрив спір щодо консультації «${params.requestTitle}».</p>
               <p><strong>Причина:</strong> ${params.reason}</p>
               <p>Адміністрація платформи розгляне спір та прийме рішення.</p>`,
        actionUrl: `${this.frontendUrl}/consultations/${params.consultationId}`,
        actionText: 'Переглянути деталі',
      });
      logger.info('Consultation dispute email sent', { consultationId: params.consultationId });
    } catch (error: any) {
      logger.error('Failed to send consultation dispute email', { error: error.message });
    }
  }

  /**
   * Generic consultation email sender with LEX branding
   */
  private async sendConsultationEmail(params: {
    to: string;
    subject: string;
    heading: string;
    body: string;
    actionUrl: string;
    actionText: string;
  }): Promise<void> {
    const logoImg = this.logoBuffer
      ? '<img src="cid:lexlogo@legal.org.ua" alt="LEX" width="40" height="40" style="display:inline-block;vertical-align:middle;margin-right:8px;" />'
      : '<span style="font-size:22px;font-weight:bold;color:#1e293b;letter-spacing:3px;vertical-align:middle;">LEX</span>';

    const html = `
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 0; background: #f1f5f9; }
    .wrapper { max-width: 600px; margin: 0 auto; padding: 20px; }
    .card { background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
    .header { background: #e8effa; padding: 24px 30px; }
    .content { padding: 30px; }
    .btn { display: inline-block; background: #1e293b; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; }
    .btn-center { text-align: center; margin: 24px 0; }
    .footer { text-align: center; padding: 20px; font-size: 12px; color: #94a3b8; }
    .footer a { color: #64748b; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        <div style="margin-bottom:12px;">${logoImg}</div>
        <h1 style="color:#1e293b;font-size:20px;margin:0;font-weight:700;">${params.heading}</h1>
      </div>
      <div class="content">
        ${params.body}
        <div class="btn-center">
          <a href="${params.actionUrl}" class="btn">${params.actionText}</a>
        </div>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
        <p style="font-size:13px;color:#64748b;text-align:center;">
          Якщо у вас виникли питання — напишіть нам на <a href="mailto:support@legal.org.ua" style="color:#1e293b;">support@legal.org.ua</a>
        </p>
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} LEX Legal Platform. Усі права захищено.</p>
        <p><a href="${this.frontendUrl}">legal.org.ua</a></p>
      </div>
    </div>
  </div>
</body>
</html>`.trim();

    const attachments: SendMailOptions['attachments'] = [];
    if (this.logoBuffer) {
      attachments.push({
        filename: 'logolex.png',
        content: this.logoBuffer,
        cid: 'lexlogo@legal.org.ua',
      });
    }

    await this.transporter.sendMail({
      from: `"${this.config.fromName}" <${this.config.from}>`,
      to: params.to,
      subject: params.subject,
      html,
      attachments,
    });
  }

  // ─── Legislation Monitoring Email ───────────────────────

  async sendLegislationChangeNotification(params: {
    email: string;
    name: string;
    lawTitle: string;
    radaId: string;
    changeCount: number;
    changedArticles: string;
    link: string;
  }): Promise<void> {
    try {
      const articlesText = params.changedArticles
        ? `<p>Змінені статті: <strong>${params.changedArticles}</strong></p>`
        : '<p>Виявлено структурні зміни</p>';

      await this.sendConsultationEmail({
        to: params.email,
        subject: `LEX — Зміни в ${params.lawTitle}`,
        heading: 'Зміни в законодавстві',
        body: `<p>Вітаємо, ${params.name}!</p>
               <p>У документі <strong>${params.lawTitle}</strong> виявлено <strong>${params.changeCount}</strong> змін.</p>
               ${articlesText}
               <p>Перегляньте деталі змін на платформі.</p>`,
        actionUrl: `${this.frontendUrl}${params.link}`,
        actionText: 'Переглянути зміни',
      });
      logger.info('Legislation change email sent', { email: params.email, radaId: params.radaId });
    } catch (error: any) {
      logger.error('Failed to send legislation change email', { error: error.message });
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

  private generateLeakedPasswordEmailTemplate(loginUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #c62828; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .button { display: inline-block; background: #2196F3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Змініть пароль</h1>
    </div>
    <div class="content">
      <p>Щойно хтось увійшов у ваш акаунт SecondLayer з паролем, який є у відомих базах витоків даних.</p>
      <p>Вхід відбувся успішно. Якщо це були ви, це означає, що ваш пароль вже відомий зловмисникам з інших сервісів, і його треба замінити на новий, унікальний для SecondLayer.</p>
      <p>Як змінити: вийдіть з акаунту, на сторінці входу натисніть «Забули пароль?» і задайте новий.</p>
      <p style="text-align: center;">
        <a href="${loginUrl}" class="button">Перейти до входу</a>
      </p>
      <p>Якщо це були не ви, змініть пароль негайно і напишіть нам у відповідь на цей лист.</p>
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
   * Generate LEX-branded payment success email template with referral data
   */
  private generatePaymentSuccessTemplate(params: PaymentSuccessParams, referralData: ReferralData | null): string {
    const logoImg = this.logoBuffer
      ? '<img src="cid:lexlogo@legal.org.ua" alt="LEX" width="50" height="50" style="display:inline-block;vertical-align:middle;margin-right:8px;" />'
      : '<span style="font-size:26px;font-weight:bold;color:#1e293b;letter-spacing:3px;vertical-align:middle;">LEX</span>';

    const referralSection = this.generateReferralSection(referralData);

    // Fractal header: real Mandelbrot PNG (CID attachment) or solid bg fallback
    const headerBgStyle = this.fractalBuffer
      ? 'background:#e8effa url(cid:fractal-header@legal.org.ua) no-repeat center center;background-size:cover;'
      : 'background:#e8effa;';

    return `
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 0; background: #f1f5f9; }
    .wrapper { max-width: 600px; margin: 0 auto; padding: 20px; }
    .card { background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
    .header h1 { color: #1e293b; font-size: 20px; margin: 0 0 10px; font-weight: 700; text-align: left; }
    .success-badge { display: inline-block; background: #22c55e; color: #fff; padding: 5px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; }
    .content { padding: 30px; }
    .amount-block { text-align: center; margin: 24px 0; }
    .amount { font-size: 36px; font-weight: 700; color: #1e293b; }
    .amount-label { font-size: 13px; color: #64748b; margin-top: 4px; }
    .details-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .details-table td { padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
    .details-table td:first-child { color: #64748b; }
    .details-table td:last-child { text-align: right; font-weight: 600; color: #1e293b; }
    .details-table tr:last-child td { border-bottom: none; }
    .btn { display: inline-block; background: #1e293b; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; }
    .btn-center { text-align: center; margin: 24px 0; }
    .referral-box { background: #fefce8; border: 1px solid #fde047; border-radius: 10px; padding: 20px; margin: 24px 0; }
    .referral-box h3 { margin: 0 0 8px; font-size: 16px; color: #854d0e; }
    .referral-box p { margin: 4px 0; font-size: 14px; color: #713f12; }
    .referral-code { display: inline-block; background: #ffffff; border: 2px dashed #eab308; padding: 8px 20px; border-radius: 6px; font-size: 20px; font-weight: 700; letter-spacing: 2px; color: #854d0e; margin: 10px 0; }
    .referral-stats { display: flex; gap: 16px; margin-top: 12px; }
    .referral-stat { flex: 1; background: #fff; border-radius: 6px; padding: 10px; text-align: center; }
    .referral-stat-value { font-size: 18px; font-weight: 700; color: #854d0e; }
    .referral-stat-label { font-size: 11px; color: #a16207; margin-top: 2px; }
    .referral-btn { display: inline-block; background: #eab308; color: #ffffff; padding: 10px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-top: 12px; }
    .divider { border: none; border-top: 1px solid #e2e8f0; margin: 24px 0; }
    .footer { text-align: center; padding: 20px; font-size: 12px; color: #94a3b8; }
    .footer a { color: #64748b; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header" style="${headerBgStyle}padding:28px 30px 24px;text-align:left;">
        <div style="margin-bottom:14px;">${logoImg}</div>
        <h1 style="color:#1e293b;font-size:21px;margin:0 0 12px;font-weight:700;">Оплата пройшла успішно</h1>
        <div class="success-badge">Підтверджено</div>
      </div>
      <div class="content">
        <p>Вітаємо, ${params.name}!</p>
        <p>Ваш платіж успішно оброблено. Кошти зараховано на баланс.</p>

        <div class="amount-block">
          <div class="amount">${params.currency} ${params.amount.toFixed(2)}</div>
          <div class="amount-label">сума поповнення</div>
        </div>

        <table class="details-table">
          <tr>
            <td>Номер платежу</td>
            <td>${params.paymentId}</td>
          </tr>
          <tr>
            <td>Поточний баланс</td>
            <td>$${Number(params.newBalance).toFixed(2)} USD</td>
          </tr>
          <tr>
            <td>Дата</td>
            <td>${new Date().toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })}</td>
          </tr>
        </table>

        <div class="btn-center">
          <a href="${this.frontendUrl}/dashboard" class="btn">Перейти до кабінету</a>
        </div>

        ${referralSection}

        <hr class="divider" />
        <p style="font-size:13px; color:#64748b; text-align:center;">
          Якщо у вас виникли питання — напишіть нам на <a href="mailto:support@legal.org.ua" style="color:#1e293b;">support@legal.org.ua</a>
        </p>
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} LEX Legal Platform. Усі права захищено.</p>
        <p><a href="${this.frontendUrl}">legal.org.ua</a></p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate referral program section for payment email
   */
  private generateReferralSection(referralData: ReferralData | null): string {
    if (!referralData) {
      // Show generic referral CTA even without data
      return `
        <div class="referral-box">
          <h3>Запрошуйте колег — заробляйте 20%</h3>
          <p>Приєднуйтеся до реферальної програми LEX та отримуйте <strong>20% від кожного поповнення</strong> запрошених користувачів — довічно!</p>
          <div style="text-align:center; margin-top:12px;">
            <a href="${this.frontendUrl}/referral" class="referral-btn">Дізнатися більше</a>
          </div>
        </div>
      `;
    }

    if (!referralData.isVerified || !referralData.referralCode) {
      // User not verified yet — encourage to join
      return `
        <div class="referral-box">
          <h3>Запрошуйте колег — заробляйте 20%</h3>
          <p>Верифікуйте свій акаунт (ФОП, ТОВ або адвокат) та отримайте персональний реферальний код.</p>
          <p>Ви отримуватимете <strong>20% від кожного поповнення</strong> запрошених вами користувачів — довічно!</p>
          <div style="text-align:center; margin-top:12px;">
            <a href="${this.frontendUrl}/referral" class="referral-btn">Приєднатися до програми</a>
          </div>
        </div>
      `;
    }

    // Verified user with referral code — show code and stats
    return `
      <div class="referral-box">
        <h3>Ваша реферальна програма</h3>
        <p>Діліться вашим кодом з колегами та отримуйте <strong>20% від кожного їхнього поповнення</strong> — довічно!</p>
        <div style="text-align:center;">
          <div class="referral-code">${referralData.referralCode}</div>
        </div>
        <!--[if mso]><table role="presentation" width="100%"><tr><td width="50%" style="padding:5px"><![endif]-->
        <div style="text-align:center;">
          <table role="presentation" style="margin:12px auto;border-collapse:collapse;">
            <tr>
              <td style="background:#fff;border-radius:6px;padding:10px 20px;text-align:center;">
                <div class="referral-stat-value">${referralData.totalReferrals}</div>
                <div class="referral-stat-label">запрошених</div>
              </td>
              <td style="width:16px;"></td>
              <td style="background:#fff;border-radius:6px;padding:10px 20px;text-align:center;">
                <div class="referral-stat-value">$${referralData.totalEarnedUsd.toFixed(2)}</div>
                <div class="referral-stat-label">зароблено</div>
              </td>
            </tr>
          </table>
        </div>
        <p style="text-align:center; font-size:13px;">Посилання для запрошення: <a href="${this.frontendUrl}/register?ref=${referralData.referralCode}" style="color:#854d0e; font-weight:600;">${this.frontendUrl}/register?ref=${referralData.referralCode}</a></p>
        <div style="text-align:center; margin-top:8px;">
          <a href="${this.frontendUrl}/referral" class="referral-btn">Переглянути статистику</a>
        </div>
      </div>
    `;
  }

  /**
   * Generate admin credit (test account) email template
   */
  private generateAdminCreditTemplate(params: AdminCreditParams): string {
    const logoImg = this.logoBuffer
      ? '<img src="cid:lexlogo@legal.org.ua" alt="LEX" width="50" height="50" style="display:inline-block;vertical-align:middle;margin-right:8px;" />'
      : '<span style="font-size:26px;font-weight:bold;color:#1e293b;letter-spacing:3px;vertical-align:middle;">LEX</span>';

    const headerBgStyle = this.fractalBuffer
      ? 'background:#e8effa url(cid:fractal-header@legal.org.ua) no-repeat center center;background-size:cover;'
      : 'background:#e8effa;';

    return `
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 0; background: #f1f5f9; }
    .wrapper { max-width: 600px; margin: 0 auto; padding: 20px; }
    .card { background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
    .content { padding: 30px; }
    .invite-badge { display: inline-block; background: #3b82f6; color: #fff; padding: 5px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; }
    .amount-block { text-align: center; margin: 24px 0; padding: 20px; background: #eff6ff; border-radius: 10px; }
    .amount { font-size: 36px; font-weight: 700; color: #1e40af; }
    .amount-label { font-size: 13px; color: #64748b; margin-top: 4px; }
    .details-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .details-table td { padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
    .details-table td:first-child { color: #64748b; }
    .details-table td:last-child { text-align: right; font-weight: 600; color: #1e293b; }
    .details-table tr:last-child td { border-bottom: none; }
    .btn { display: inline-block; background: #1e293b; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; }
    .btn-center { text-align: center; margin: 24px 0; }
    .features { background: #f8fafc; border-radius: 10px; padding: 20px; margin: 20px 0; }
    .features h3 { margin: 0 0 12px; font-size: 15px; color: #1e293b; }
    .features ul { margin: 0; padding-left: 20px; }
    .features li { font-size: 14px; color: #475569; margin-bottom: 6px; }
    .divider { border: none; border-top: 1px solid #e2e8f0; margin: 24px 0; }
    .footer { text-align: center; padding: 20px; font-size: 12px; color: #94a3b8; }
    .footer a { color: #64748b; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header" style="${headerBgStyle}padding:28px 30px 24px;text-align:left;">
        <div style="margin-bottom:14px;">${logoImg}</div>
        <h1 style="color:#1e293b;font-size:21px;margin:0 0 12px;font-weight:700;">Запрошення до тестування платформи</h1>
        <div class="invite-badge">Тестовий акаунт</div>
      </div>
      <div class="content">
        <p>Вітаємо, ${params.name}!</p>
        <p>Вас запрошено до тестування юридичної AI-платформи <strong>LEX</strong>. Це не поповнення рахунку — для вас створено тестовий акаунт з балансом для ознайомлення з можливостями системи.</p>

        <div class="amount-block">
          <div class="amount">${params.currency} ${params.amount.toFixed(2)}</div>
          <div class="amount-label">тестовий баланс</div>
        </div>

        <table class="details-table">
          <tr>
            <td>Баланс акаунту</td>
            <td>$${Number(params.newBalance).toFixed(2)} USD</td>
          </tr>
          <tr>
            <td>Дата</td>
            <td>${new Date().toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })}</td>
          </tr>
        </table>

        <div class="features">
          <h3>Що можна протестувати:</h3>
          <ul>
            <li>Пошук судових рішень з AI-аналізом</li>
            <li>Аналіз законодавства та нормативних актів</li>
            <li>Семантичний пошук по правовій базі</li>
            <li>Робота з документами та витягами</li>
          </ul>
        </div>

        <div class="btn-center">
          <a href="${this.frontendUrl}/dashboard" class="btn">Перейти до платформи</a>
        </div>

        <hr class="divider" />
        <p style="font-size:13px; color:#64748b; text-align:center;">
          Якщо у вас виникли питання — напишіть нам на <a href="mailto:support@legal.org.ua" style="color:#1e293b;">support@legal.org.ua</a>
        </p>
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} LEX Legal Platform. Усі права захищено.</p>
        <p><a href="${this.frontendUrl}">legal.org.ua</a></p>
      </div>
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

  // ─── Support Widget (FAB) ───────────────────────────────

  /**
   * Send a support widget message (feedback or question) from a logged-in user
   * to the support inbox.
   */
  async sendSupportMessage(params: {
    type: 'feedback' | 'question';
    message: string;
    fromEmail: string;
    fromName: string;
    userId: string;
    pageUrl?: string;
    userAgent?: string;
  }): Promise<void> {
    const supportInbox = process.env.SUPPORT_EMAIL || 'info@legal.org.ua';
    const typeLabel = params.type === 'feedback' ? 'Зауваження' : 'Питання';
    const subject = `LEX — ${typeLabel} від ${params.fromName || params.fromEmail}`;

    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const messageHtml = escape(params.message).replace(/\n/g, '<br>');

    const html = `
<!DOCTYPE html>
<html lang="uk">
<head><meta charset="utf-8"></head>
<body style="font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; background: #f1f5f9; margin: 0; padding: 20px;">
  <div style="max-width:600px; margin: 0 auto; background:#fff; border-radius:12px; padding:24px;">
    <h2 style="margin-top:0; color:#1e293b;">${typeLabel} з Support Widget</h2>
    <table style="width:100%; font-size:13px; color:#475569; border-collapse:collapse;">
      <tr><td style="padding:4px 0; width:130px;"><b>Користувач:</b></td><td>${escape(params.fromName)} &lt;${escape(params.fromEmail)}&gt;</td></tr>
      <tr><td style="padding:4px 0;"><b>User ID:</b></td><td>${escape(params.userId)}</td></tr>
      ${params.pageUrl ? `<tr><td style="padding:4px 0;"><b>Сторінка:</b></td><td>${escape(params.pageUrl)}</td></tr>` : ''}
      ${params.userAgent ? `<tr><td style="padding:4px 0;"><b>User-Agent:</b></td><td style="font-family:monospace;font-size:11px;">${escape(params.userAgent)}</td></tr>` : ''}
    </table>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;">
    <div style="white-space:pre-wrap; line-height:1.6; font-size:14px; color:#1e293b;">${messageHtml}</div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;">
    <p style="font-size:12px;color:#94a3b8;margin:0;">
      Reply directly to this email to respond to ${escape(params.fromEmail)}.
    </p>
  </div>
</body>
</html>`.trim();

    await this.transporter.sendMail({
      from: `"${this.config.fromName}" <${this.config.from}>`,
      to: supportInbox,
      replyTo: params.fromEmail,
      subject,
      html,
    });

    logger.info('Support message sent', {
      type: params.type,
      userId: params.userId,
      to: supportInbox,
    });
  }
}
