/**
 * Tests for B2BInvoiceService — invoice creation, listing, payment confirmation,
 * cancellation, PDF generation, and helper functions.
 */

jest.mock('pdfkit', () => {
  const mockDoc = {
    font: jest.fn().mockReturnThis(),
    fontSize: jest.fn().mockReturnThis(),
    text: jest.fn().mockReturnThis(),
    moveDown: jest.fn().mockReturnThis(),
    moveTo: jest.fn().mockReturnThis(),
    lineTo: jest.fn().mockReturnThis(),
    stroke: jest.fn().mockReturnThis(),
    strokeColor: jest.fn().mockReturnThis(),
    lineWidth: jest.fn().mockReturnThis(),
    fillColor: jest.fn().mockReturnThis(),
    rect: jest.fn().mockReturnThis(),
    fill: jest.fn().mockReturnThis(),
    registerFont: jest.fn().mockReturnThis(),
    addPage: jest.fn().mockReturnThis(),
    end: jest.fn(),
    on: jest.fn().mockImplementation(function(this: any, event: string, cb: Function) {
      if (event === 'data') setTimeout(() => cb(Buffer.from('pdf-chunk')), 0);
      if (event === 'end') setTimeout(() => cb(), 10);
      return this;
    }),
    y: 100,
    page: { width: 595, height: 842 },
    bufferedPageRange: jest.fn().mockReturnValue({ start: 0, count: 1 }),
  };
  return jest.fn().mockImplementation(() => mockDoc);
});

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { B2BInvoiceService } from '../b2b-invoice-service';

const createMockDb = () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
});

const MOCK_INVOICE = {
  id: 'inv-1',
  invoice_number: 'INV-2026-001',
  organization_id: 'org-1',
  requested_by: 'user-1',
  invoice_type: 'topup',
  status: 'issued',
  amount_uah: '5000.00',
  vat_uah: '1000.00',
  total_uah: '6000.00',
  amount_usd: '120.48',
  buyer_name: 'ТОВ Тест',
  buyer_edrpou: '12345678',
  buyer_address: 'Київ',
  buyer_email: 'org@test.com',
  issue_date: new Date('2026-01-15'),
  due_date: new Date('2026-01-22'),
  created_at: new Date(),
  updated_at: new Date(),
};

describe('B2BInvoiceService', () => {
  let service: B2BInvoiceService;
  let mockDb: ReturnType<typeof createMockDb>;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDb();
    service = new B2BInvoiceService(mockDb as any);
    process.env = {
      ...originalEnv,
      SELLER_NAME: 'ФОП Тест',
      SELLER_EDRPOU: '87654321',
      SELLER_IBAN: 'UA123456789',
      SELLER_BANK: 'ПриватБанк',
      SELLER_MFO: '305299',
      SELLER_ADDRESS: 'Київ',
      SELLER_IS_VAT_PAYER: 'true',
      USD_TO_UAH_RATE: '41.50',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('createInvoice', () => {
    it('should create topup invoice', async () => {
      mockDb.query
        .mockResolvedValueOnce({ // org lookup
          rows: [{ id: 'org-1', name: 'ТОВ Тест', edrpou: '12345678', legal_address: 'Київ', billing_email: 'org@test.com', owner_id: 'user-1' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ seq: '1' }] }) // generateInvoiceNumber sequence
        .mockResolvedValueOnce({ rows: [{ email: 'user@test.com' }] }) // user email fallback
        .mockResolvedValueOnce({ rows: [MOCK_INVOICE], rowCount: 1 }); // INSERT

      const result = await service.createInvoice({
        organizationId: 'org-1',
        requestedBy: 'user-1',
        invoiceType: 'topup',
        amountUah: 5000,
      });

      expect(result).toBeDefined();
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should throw when organization has no EDRPOU', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'org-1', name: 'Test', edrpou: null }],
        rowCount: 1,
      });

      await expect(service.createInvoice({
        organizationId: 'org-1',
        requestedBy: 'user-1',
        invoiceType: 'topup',
        amountUah: 5000,
      })).rejects.toThrow();
    });

    it('should throw when organization not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(service.createInvoice({
        organizationId: 'nonexistent',
        requestedBy: 'user-1',
        invoiceType: 'topup',
        amountUah: 5000,
      })).rejects.toThrow();
    });
  });

  describe('listByOrganization', () => {
    it('should return paginated invoices', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })
        .mockResolvedValueOnce({ rows: [MOCK_INVOICE], rowCount: 1 });

      const result = await service.listByOrganization('org-1');

      expect(result.total).toBe(3);
      expect(result.invoices).toHaveLength(1);
    });

    it('should filter by status', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [MOCK_INVOICE], rowCount: 1 });

      await service.listByOrganization('org-1', { status: 'paid' });

      const countQuery = mockDb.query.mock.calls[0];
      expect(countQuery[0]).toContain('status');
    });
  });

  describe('listAll', () => {
    it('should return all invoices for admin', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [MOCK_INVOICE], rowCount: 1 });

      const result = await service.listAll();
      expect(result.total).toBe(10);
    });
  });

  describe('getById', () => {
    it('should return invoice when found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [MOCK_INVOICE],
        rowCount: 1,
      });

      const result = await service.getById('inv-1');
      expect(result).toBeDefined();
      expect(result?.invoice_number).toBe('INV-2026-001');
    });

    it('should return null when not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await service.getById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('confirmPayment', () => {
    it('should confirm payment and top up balance for topup invoice', async () => {
      const issuedInvoice = { ...MOCK_INVOICE, status: 'issued', invoice_type: 'topup', amount_usd: '120.48', organization_id: 'org-1' };
      const paidInvoice = { ...issuedInvoice, status: 'paid' };
      mockDb.query
        .mockResolvedValueOnce({ rows: [issuedInvoice], rowCount: 1 }) // getById
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE status to paid
        .mockResolvedValueOnce({ rows: [{ owner_id: 'owner-1' }] }) // org owner
        .mockResolvedValueOnce({ rows: [paidInvoice], rowCount: 1 }); // getById refresh

      const mockBillingService = { topUpBalance: jest.fn().mockResolvedValue(undefined) };

      const result = await service.confirmPayment('inv-1', 'admin-1', 'REF-123', mockBillingService);

      expect(mockBillingService.topUpBalance).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should throw for already paid invoice', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ ...MOCK_INVOICE, status: 'paid' }],
        rowCount: 1,
      });

      await expect(
        service.confirmPayment('inv-1', 'admin-1', 'REF', { topUpBalance: jest.fn() })
      ).rejects.toThrow();
    });
  });

  describe('cancelInvoice', () => {
    it('should cancel issued invoice', async () => {
      const cancelled = { ...MOCK_INVOICE, status: 'cancelled' };
      mockDb.query
        .mockResolvedValueOnce({ rows: [MOCK_INVOICE], rowCount: 1 }) // getById
        .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 }) // UPDATE
        .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 }); // getById refresh

      const result = await service.cancelInvoice('inv-1', 'user-1', 'Помилка');

      expect(result.status).toBe('cancelled');
    });

    it('should throw for already paid invoice', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ ...MOCK_INVOICE, status: 'paid' }],
        rowCount: 1,
      });

      await expect(
        service.cancelInvoice('inv-1', 'user-1')
      ).rejects.toThrow();
    });
  });

  describe('generatePDF', () => {
    it('should return buffer for valid invoice', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [MOCK_INVOICE],
        rowCount: 1,
      });

      const result = await service.generatePDF('inv-1');
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('should throw for nonexistent invoice', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(service.generatePDF('nonexistent')).rejects.toThrow();
    });
  });
});

describe('B2BInvoiceService USD→UAH rate', () => {
  const saved = process.env.B2B_USD_UAH_RATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.B2B_USD_UAH_RATE;
    else process.env.B2B_USD_UAH_RATE = saved;
  });

  it('uses the NBU rate of the day, not a fixed 41,5', async () => {
    delete process.env.B2B_USD_UAH_RATE;
    const svc = new B2BInvoiceService({} as any, { getUsdToUahRate: async () => ({ rate: 45.4274, source: 'NBU', lastUpdated: '' }) } as any);
    expect(await (svc as any).usdToUahRate()).toBe(45.4274);
  });

  it('keeps a contract rate from B2B_USD_UAH_RATE when it is set', async () => {
    process.env.B2B_USD_UAH_RATE = '44.00';
    const svc = new B2BInvoiceService({} as any, { getUsdToUahRate: async () => ({ rate: 45.4274 }) } as any);
    expect(await (svc as any).usdToUahRate()).toBe(44);
  });
});
