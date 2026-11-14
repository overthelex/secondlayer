/**
 * B2B Invoice Service
 * Handles invoice generation, PDF creation, and payment confirmation
 * for legal entities paying via bank transfer (безготівковий розрахунок)
 */

import PDFDocument from 'pdfkit';
import path from 'path';
import type { IDatabase } from '../domain/ports/index.js';
import { logger } from '../utils/logger.js';
import type { CurrencyService } from './currency-service.js';

export interface B2BInvoice {
  id: string;
  invoice_number: string;
  organization_id: string;
  requested_by: string;
  invoice_type: 'subscription' | 'topup';
  status: 'draft' | 'issued' | 'sent' | 'paid' | 'cancelled' | 'overdue';
  tier_key: string | null;
  billing_cycle: string | null;
  amount_uah: number;
  vat_uah: number;
  total_uah: number;
  amount_usd: number | null;
  buyer_name: string;
  buyer_edrpou: string;
  buyer_address: string | null;
  buyer_email: string | null;
  issue_date: string;
  due_date: string;
  paid_at: string | null;
  cancelled_at: string | null;
  confirmed_by: string | null;
  payment_reference: string | null;
  notes: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  organization_name?: string;
  requested_by_name?: string;
  requested_by_email?: string;
  tier_name?: string;
}

export interface CreateB2BInvoiceParams {
  organizationId: string;
  requestedBy: string;
  invoiceType: 'subscription' | 'topup';
  tierKey?: string;
  billingCycle?: 'monthly' | 'quarterly' | 'annual';
  amountUah?: number; // Required for topup
  notes?: string;
}

// Seller details from env vars
function getSellerDetails() {
  return {
    name: process.env.COMPANY_LEGAL_NAME || 'ФОП Кириченко Ігор Вікторович',
    edrpou: process.env.COMPANY_EDRPOU || '2967214056',
    iban: process.env.COMPANY_IBAN || 'UA613220010000026006330050699',
    bank: process.env.COMPANY_BANK || 'АТ «УНІВЕРСАЛ БАНК»',
    mfo: process.env.COMPANY_MFO || '322001',
    address: process.env.COMPANY_LEGAL_ADDRESS || 'м. Київ, Дніпровський р-н, Садовод вул. Садова 47, буд. 1А',
    isVatPayer: process.env.COMPANY_IS_VAT_PAYER === 'true',
  };
}

const VAT_RATE = 0.20;

/**
 * Add N business days to a date (skip weekends)
 */
function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) {
      added++;
    }
  }
  return result;
}

/**
 * Convert number to Ukrainian words (for invoice total)
 */
function numberToUkrainianWords(num: number): string {
  const ones = ['', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
  const teens = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять',
    "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
  const tens = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят",
    'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
  const hundreds = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот",
    'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];

  const wholePart = Math.floor(num);
  const kopPart = Math.round((num - wholePart) * 100);

  function convertGroup(n: number): string {
    if (n === 0) return '';
    let result = '';
    const h = Math.floor(n / 100);
    const remainder = n % 100;
    const t = Math.floor(remainder / 10);
    const o = remainder % 10;

    if (h > 0) result += hundreds[h] + ' ';
    if (t === 1) {
      result += teens[o] + ' ';
    } else {
      if (t > 0) result += tens[t] + ' ';
      if (o > 0) result += ones[o] + ' ';
    }
    return result.trim();
  }

  function getThousandSuffix(n: number): string {
    const lastTwo = n % 100;
    const lastOne = n % 10;
    if (lastTwo >= 11 && lastTwo <= 19) return 'тисяч';
    if (lastOne === 1) return 'тисяча';
    if (lastOne >= 2 && lastOne <= 4) return 'тисячі';
    return 'тисяч';
  }

  function getHryvniaSuffix(n: number): string {
    const lastTwo = n % 100;
    const lastOne = n % 10;
    if (lastTwo >= 11 && lastTwo <= 19) return 'грн';
    if (lastOne === 1) return 'грн';
    if (lastOne >= 2 && lastOne <= 4) return 'грн';
    return 'грн';
  }

  let result = '';

  if (wholePart === 0) {
    result = 'нуль';
  } else {
    const millions = Math.floor(wholePart / 1000000);
    const thousands = Math.floor((wholePart % 1000000) / 1000);
    const remainder = wholePart % 1000;

    if (millions > 0) {
      const millionLastTwo = millions % 100;
      const millionLastOne = millions % 10;
      let suffix = 'мільйонів';
      if (millionLastTwo >= 11 && millionLastTwo <= 19) suffix = 'мільйонів';
      else if (millionLastOne === 1) suffix = 'мільйон';
      else if (millionLastOne >= 2 && millionLastOne <= 4) suffix = 'мільйони';
      result += convertGroup(millions) + ' ' + suffix + ' ';
    }
    if (thousands > 0) {
      result += convertGroup(thousands) + ' ' + getThousandSuffix(thousands) + ' ';
    }
    if (remainder > 0) {
      result += convertGroup(remainder) + ' ';
    }
  }

  // Capitalize first letter
  result = result.trim();
  result = result.charAt(0).toUpperCase() + result.slice(1);

  const kopStr = kopPart.toString().padStart(2, '0');
  return `${result} ${getHryvniaSuffix(wholePart)} ${kopStr} коп.`;
}

/** Fallback only when neither B2B_USD_UAH_RATE nor the NBU rate is available. */
const DEFAULT_USD_UAH_RATE = 45.43;

export class B2BInvoiceService {
  constructor(
    private db: IDatabase,
    private currencyService?: CurrencyService,
  ) {}

  /**
   * USD→UAH rate for an invoice: B2B_USD_UAH_RATE if set (a rate fixed in a
   * contract), otherwise the NBU rate of the day, the same rate Monobank top-ups
   * and tool charges convert at. A fixed 41,5 credited ~9% more USD than paid for
   * once the NBU rate moved to 45+.
   */
  private async usdToUahRate(): Promise<number> {
    const fixed = parseFloat(process.env.B2B_USD_UAH_RATE || '');
    if (fixed > 0) return fixed;
    if (this.currencyService) return (await this.currencyService.getUsdToUahRate()).rate;
    return DEFAULT_USD_UAH_RATE;
  }

  /**
   * Generate next invoice number in format B2B-YYYY-NNNNN
   */
  private async generateInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const result = await this.db.query(
      "SELECT nextval('b2b_invoice_number_seq') AS seq"
    );
    const seq = String(result.rows[0].seq).padStart(5, '0');
    return `B2B-${year}-${seq}`;
  }

  /**
   * Create a new B2B invoice
   */
  async createInvoice(params: CreateB2BInvoiceParams): Promise<B2BInvoice> {
    // Fetch org details for snapshot
    const orgResult = await this.db.query(
      'SELECT id, name, edrpou, legal_address, billing_email, owner_id FROM organizations WHERE id = $1',
      [params.organizationId]
    );
    if (orgResult.rows.length === 0) {
      throw new Error('Організацію не знайдено');
    }
    const org = orgResult.rows[0];

    if (!org.edrpou) {
      throw new Error('Для виставлення рахунку організація повинна мати заповнений ЄДРПОУ');
    }

    // For subscriptions, get tier pricing
    let amountUah: number;
    if (params.invoiceType === 'subscription') {
      if (!params.tierKey || !params.billingCycle) {
        throw new Error('Для підписки потрібно вказати тариф та період оплати');
      }
      const tierResult = await this.db.query(
        'SELECT tier_key, display_name, monthly_price_usd FROM billing_tiers WHERE tier_key = $1',
        [params.tierKey]
      );
      if (tierResult.rows.length === 0) {
        throw new Error('Тариф не знайдено');
      }
      const tier = tierResult.rows[0];
      const monthlyUsd = parseFloat(tier.monthly_price_usd || '0');

      // Calculate total based on billing cycle
      let months: number;
      if (params.billingCycle === 'monthly') months = 1;
      else if (params.billingCycle === 'quarterly') months = 3;
      else months = 12;

      amountUah = monthlyUsd * months * (await this.usdToUahRate());
    } else {
      if (!params.amountUah || params.amountUah < 500) {
        throw new Error('Мінімальна сума поповнення — 500 грн');
      }
      amountUah = params.amountUah;
    }

    const seller = getSellerDetails();
    const vatUah = seller.isVatPayer ? Math.round(amountUah * VAT_RATE * 100) / 100 : 0;
    const totalUah = Math.round((amountUah + vatUah) * 100) / 100;

    // Convert to USD for balance crediting
    const usdToUah = await this.usdToUahRate();
    const amountUsd = Math.round((amountUah / usdToUah) * 100) / 100;

    const invoiceNumber = await this.generateInvoiceNumber();
    const issueDate = new Date();
    const dueDate = addBusinessDays(issueDate, 5);

    // Get buyer email — prefer org billing_email, fall back to requester's email
    const userResult = await this.db.query(
      'SELECT email FROM users WHERE id = $1',
      [params.requestedBy]
    );
    const buyerEmail = org.billing_email || userResult.rows[0]?.email || null;

    const result = await this.db.query(`
      INSERT INTO b2b_invoices (
        invoice_number, organization_id, requested_by,
        invoice_type, status, tier_key, billing_cycle,
        amount_uah, vat_uah, total_uah, amount_usd,
        buyer_name, buyer_edrpou, buyer_address, buyer_email,
        issue_date, due_date, notes
      ) VALUES ($1, $2, $3, $4, 'issued', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `, [
      invoiceNumber, params.organizationId, params.requestedBy,
      params.invoiceType, params.tierKey || null, params.billingCycle || null,
      amountUah, vatUah, totalUah, amountUsd,
      org.name, org.edrpou, org.legal_address || null, buyerEmail,
      issueDate.toISOString().slice(0, 10), dueDate.toISOString().slice(0, 10),
      params.notes || null,
    ]);

    logger.info('B2B invoice created', {
      invoiceNumber,
      orgId: params.organizationId,
      type: params.invoiceType,
      totalUah,
    });

    return this.coerce(result.rows[0]);
  }

  /**
   * List invoices by organization
   */
  async listByOrganization(orgId: string, filters?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ invoices: B2BInvoice[]; total: number }> {
    const conditions = ['i.organization_id = $1'];
    const params: any[] = [orgId];
    let paramCount = 1;

    if (filters?.status) {
      paramCount++;
      conditions.push(`i.status = $${paramCount}`);
      params.push(filters.status);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM b2b_invoices i WHERE ${where}`,
      params
    );

    const limit = filters?.limit || 20;
    const offset = filters?.offset || 0;

    const result = await this.db.query(`
      SELECT i.*,
        o.name AS organization_name,
        u.name AS requested_by_name,
        u.email AS requested_by_email,
        bt.display_name AS tier_name
      FROM b2b_invoices i
      LEFT JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN users u ON u.id = i.requested_by
      LEFT JOIN billing_tiers bt ON bt.tier_key = i.tier_key
      WHERE ${where}
      ORDER BY i.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, [...params, limit, offset]);

    return {
      invoices: result.rows.map(r => this.coerce(r)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * List all invoices (admin)
   */
  async listAll(filters?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ invoices: B2BInvoice[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramCount = 0;

    if (filters?.status) {
      paramCount++;
      conditions.push(`i.status = $${paramCount}`);
      params.push(filters.status);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM b2b_invoices i ${where}`,
      params
    );

    const limit = filters?.limit || 20;
    const offset = filters?.offset || 0;

    const result = await this.db.query(`
      SELECT i.*,
        o.name AS organization_name,
        u.name AS requested_by_name,
        u.email AS requested_by_email,
        bt.display_name AS tier_name
      FROM b2b_invoices i
      LEFT JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN users u ON u.id = i.requested_by
      LEFT JOIN billing_tiers bt ON bt.tier_key = i.tier_key
      ${where}
      ORDER BY i.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, [...params, limit, offset]);

    return {
      invoices: result.rows.map(r => this.coerce(r)),
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get single invoice by ID
   */
  async getById(id: string): Promise<B2BInvoice | null> {
    const result = await this.db.query(`
      SELECT i.*,
        o.name AS organization_name,
        u.name AS requested_by_name,
        u.email AS requested_by_email,
        bt.display_name AS tier_name
      FROM b2b_invoices i
      LEFT JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN users u ON u.id = i.requested_by
      LEFT JOIN billing_tiers bt ON bt.tier_key = i.tier_key
      WHERE i.id = $1
    `, [id]);

    if (result.rows.length === 0) return null;
    return this.coerce(result.rows[0]);
  }

  /**
   * Confirm payment (admin action)
   * Credits org balance (topup) or creates subscription
   */
  async confirmPayment(
    invoiceId: string,
    adminUserId: string,
    paymentReference: string,
    billingService: { topUpBalance: Function },
    subscriptionService?: { create: Function }
  ): Promise<B2BInvoice> {
    // Get invoice
    const invoice = await this.getById(invoiceId);
    if (!invoice) throw new Error('Рахунок не знайдено');
    if (invoice.status === 'paid') throw new Error('Рахунок вже оплачено');
    if (invoice.status === 'cancelled') throw new Error('Рахунок скасовано');

    // Update invoice status
    await this.db.query(`
      UPDATE b2b_invoices
      SET status = 'paid',
          paid_at = NOW(),
          confirmed_by = $1,
          payment_reference = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [adminUserId, paymentReference, invoiceId]);

    // Get org owner for balance crediting
    const orgResult = await this.db.query(
      'SELECT owner_id FROM organizations WHERE id = $1',
      [invoice.organization_id]
    );
    const ownerId = orgResult.rows[0]?.owner_id;

    if (invoice.invoice_type === 'topup' && ownerId && invoice.amount_usd) {
      // Credit org owner balance
      await billingService.topUpBalance({
        userId: ownerId,
        amountUsd: invoice.amount_usd,
        amountUah: invoice.amount_uah,
        description: `Поповнення за рахунком ${invoice.invoice_number}`,
        paymentProvider: 'b2b_bank_transfer',
        paymentId: paymentReference,
        metadata: { b2b_invoice_id: invoiceId, invoice_number: invoice.invoice_number },
      });
    } else if (invoice.invoice_type === 'subscription' && subscriptionService && invoice.tier_key && invoice.billing_cycle) {
      // Create subscription
      await subscriptionService.create({
        organization_id: invoice.organization_id,
        tier_key: invoice.tier_key,
        billing_cycle: invoice.billing_cycle,
        price_usd: invoice.amount_usd || 0,
        status: 'active',
        created_by: invoice.requested_by,
      });
    }

    logger.info('B2B invoice payment confirmed', {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      confirmedBy: adminUserId,
      paymentReference,
    });

    return (await this.getById(invoiceId))!;
  }

  /**
   * Cancel unpaid invoice
   */
  async cancelInvoice(invoiceId: string, userId: string, reason?: string): Promise<B2BInvoice> {
    const invoice = await this.getById(invoiceId);
    if (!invoice) throw new Error('Рахунок не знайдено');
    if (invoice.status === 'paid') throw new Error('Неможливо скасувати оплачений рахунок');
    if (invoice.status === 'cancelled') throw new Error('Рахунок вже скасовано');

    await this.db.query(`
      UPDATE b2b_invoices
      SET status = 'cancelled',
          cancelled_at = NOW(),
          admin_notes = COALESCE(admin_notes, '') || $1,
          updated_at = NOW()
      WHERE id = $2
    `, [reason ? `\nСкасовано: ${reason}` : '\nСкасовано користувачем', invoiceId]);

    logger.info('B2B invoice cancelled', { invoiceId, userId, reason });
    return (await this.getById(invoiceId))!;
  }

  /**
   * Generate Ukrainian-format PDF invoice
   */
  async generatePDF(invoiceId: string): Promise<Buffer> {
    const invoice = await this.getById(invoiceId);
    if (!invoice) throw new Error('Рахунок не знайдено');

    const seller = getSellerDetails();

    return new Promise((resolve, reject) => {
      try {
        // Register DejaVu font for Ukrainian characters
        // Try multiple possible paths (dev vs container)
        const basePaths = [
          path.join(process.cwd(), 'assets', 'fonts'),
          path.resolve(__dirname, '..', '..', 'assets', 'fonts'),
        ];

        let fontPath = '';
        let fontBoldPath = '';
        for (const base of basePaths) {
          const regular = path.join(base, 'DejaVuSans.ttf');
          try {
            require('fs').accessSync(regular);
            fontPath = regular;
            fontBoldPath = path.join(base, 'DejaVuSans-Bold.ttf');
            break;
          } catch { /* try next */ }
        }

        if (!fontPath) {
          throw new Error('DejaVuSans fonts not found — cannot generate PDF with Ukrainian text');
        }

        const doc = new PDFDocument({
          margin: 50,
          size: 'A4',
          font: fontPath,
        });
        doc.registerFont('Regular', fontPath);
        doc.registerFont('Bold', fontBoldPath);

        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const formatDate = (dateStr: string) => {
          const d = new Date(dateStr);
          return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
        };

        const formatMoney = (amount: number) => {
          return amount.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };

        // === HEADER ===
        doc
          .font('Bold')
          .fontSize(16)
          .text(`РАХУНОК НА ОПЛАТУ № ${invoice.invoice_number}`, { align: 'center' });

        doc
          .fontSize(12)
          .text(`від ${formatDate(invoice.issue_date)}`, { align: 'center' });

        doc.moveDown(1.5);

        // === SELLER BLOCK ===
        doc
          .font('Bold')
          .fontSize(10)
          .text('Постачальник:', { continued: true })
          .font('Regular')
          .text(` ${seller.name}`);

        doc.text(`ЄДРПОУ: ${seller.edrpou}`);
        doc.text(`IBAN: ${seller.iban}`);
        doc.text(`Банк: ${seller.bank}, МФО ${seller.mfo}`);
        doc.text(`Адреса: ${seller.address}`);
        if (seller.isVatPayer) {
          doc.text('Платник ПДВ');
        } else {
          doc.text('Не є платником ПДВ');
        }

        doc.moveDown(1);

        // === BUYER BLOCK ===
        doc
          .font('Bold')
          .fontSize(10)
          .text('Покупець:', { continued: true })
          .font('Regular')
          .text(` ${invoice.buyer_name}`);

        doc.text(`ЄДРПОУ: ${invoice.buyer_edrpou}`);
        if (invoice.buyer_address) {
          doc.text(`Адреса: ${invoice.buyer_address}`);
        }
        if (invoice.buyer_email) {
          doc.text(`Email: ${invoice.buyer_email}`);
        }

        doc.moveDown(1);

        // === ITEMS TABLE ===
        const tableTop = doc.y;
        const col1 = 50;   // №
        const col2 = 80;   // Найменування
        const col3 = 340;  // Кількість
        const col4 = 400;  // Ціна
        const col5 = 480;  // Сума

        // Table header
        doc
          .font('Bold')
          .fontSize(9);

        doc.text('№', col1, tableTop, { width: 25 });
        doc.text('Найменування', col2, tableTop, { width: 250 });
        doc.text('К-ть', col3, tableTop, { width: 50 });
        doc.text('Ціна, грн', col4, tableTop, { width: 70 });
        doc.text('Сума, грн', col5, tableTop, { width: 70 });

        // Header line
        const lineY = tableTop + 15;
        doc
          .moveTo(col1, lineY)
          .lineTo(550, lineY)
          .stroke();

        // Table row
        const rowY = lineY + 8;
        doc.font('Regular').fontSize(9);

        let itemDescription: string;
        if (invoice.invoice_type === 'subscription') {
          const cycleName = invoice.billing_cycle === 'monthly' ? 'місяць'
            : invoice.billing_cycle === 'quarterly' ? 'квартал' : 'рік';
          itemDescription = `Підписка на сервіс legal.org.ua — тариф "${invoice.tier_name || invoice.tier_key}" (${cycleName})`;
        } else {
          itemDescription = 'Поповнення балансу сервісу legal.org.ua';
        }

        doc.text('1', col1, rowY, { width: 25 });
        doc.text(itemDescription, col2, rowY, { width: 250 });
        doc.text('1', col3, rowY, { width: 50 });
        doc.text(formatMoney(invoice.amount_uah), col4, rowY, { width: 70 });
        doc.text(formatMoney(invoice.amount_uah), col5, rowY, { width: 70 });

        // Bottom line
        const endLineY = rowY + 25;
        doc
          .moveTo(col1, endLineY)
          .lineTo(550, endLineY)
          .stroke();

        // === TOTALS ===
        let totalY = endLineY + 12;
        const labelX = 350;
        const valueX = 480;

        doc.font('Regular').fontSize(10);
        doc.text('Сума:', labelX, totalY);
        doc.text(`${formatMoney(invoice.amount_uah)} грн`, valueX, totalY);

        totalY += 18;
        if (seller.isVatPayer && invoice.vat_uah > 0) {
          doc.text('ПДВ 20%:', labelX, totalY);
          doc.text(`${formatMoney(invoice.vat_uah)} грн`, valueX, totalY);
        } else {
          doc.text('Без ПДВ', labelX, totalY);
        }

        totalY += 18;
        doc.font('Bold').fontSize(11);
        doc.text('Всього до оплати:', labelX, totalY);
        doc.text(`${formatMoney(invoice.total_uah)} грн`, valueX, totalY);

        // === TOTAL IN WORDS ===
        totalY += 30;
        doc.font('Regular').fontSize(10);
        doc.text(`Всього до оплати: ${numberToUkrainianWords(invoice.total_uah)}`, col1, totalY);

        // === PAYMENT PURPOSE ===
        totalY += 30;
        doc.font('Bold').fontSize(10);
        doc.text('Призначення платежу:', col1, totalY);
        doc.font('Regular');
        totalY += 15;
        doc.text(`Оплата за послуги згідно рахунку № ${invoice.invoice_number} від ${formatDate(invoice.issue_date)}`, col1, totalY);

        // === DUE DATE ===
        totalY += 30;
        doc.font('Bold').fontSize(10);
        doc.text(`Строк оплати: до ${formatDate(invoice.due_date)}`, col1, totalY);

        // === NOTES ===
        if (invoice.notes) {
          totalY += 25;
          doc.font('Regular').fontSize(9);
          doc.text(`Примітки: ${invoice.notes}`, col1, totalY, { width: 500 });
        }

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private coerce(row: any): B2BInvoice {
    return {
      ...row,
      amount_uah: parseFloat(row.amount_uah) || 0,
      vat_uah: parseFloat(row.vat_uah) || 0,
      total_uah: parseFloat(row.total_uah) || 0,
      amount_usd: row.amount_usd ? parseFloat(row.amount_usd) : null,
    };
  }
}
