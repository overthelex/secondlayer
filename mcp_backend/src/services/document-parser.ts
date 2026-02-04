import { chromium, Browser } from 'playwright';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ParsedDocument {
  text: string;
  metadata: {
    title?: string;
    author?: string;
    createdDate?: Date;
    modifiedDate?: Date;
    pageCount?: number;
    source: 'native' | 'ocr';
    mimeType: string;
  };
  pages?: Array<{
    pageNumber: number;
    text: string;
    confidence?: number;
  }>;
}

export class DocumentParser {
  private visionClient: ImageAnnotatorClient;
  private browser: Browser | null = null;
  private readonly tempDir = '/tmp/document-parser';

  constructor(visionKeyPath: string) {
    this.visionClient = new ImageAnnotatorClient({
      keyFilename: visionKeyPath,
    });
  }

  async initialize(): Promise<void> {
    // Ensure temp directory exists
    await fs.mkdir(this.tempDir, { recursive: true });
    logger.info('DocumentParser initialized', { tempDir: this.tempDir });
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      logger.info('Playwright browser launched');
    }
    return this.browser;
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('Playwright browser closed');
    }
  }

  /**
   * Parse PDF document
   * Strategy: Try native text extraction first, fallback to OCR via screenshots
   */
  async parsePDF(fileBuffer: Buffer): Promise<ParsedDocument> {
    try {
      // For Ukrainian documents, always use OCR via Playwright + Google Vision
      // Native PDF extraction has encoding issues with Cyrillic text
      logger.info('Using OCR for PDF parsing (better for Ukrainian documents)');

      const parser = new PDFParse({ data: new Uint8Array(fileBuffer) });
      const textResult = await parser.getText();
      const pageCount = textResult.total || 1;

      return await this.parsePDFWithOCR(fileBuffer, pageCount);
    } catch (error: any) {
      logger.error('PDF parsing failed', { error: error.message });
      throw new Error(`Failed to parse PDF: ${error.message}`);
    }
  }

  /**
   * Parse PDF using OCR (convert PDF to images via pdftoppm → Vision API)
   */
  private async parsePDFWithOCR(fileBuffer: Buffer, pageCount?: number): Promise<ParsedDocument> {
    const tempPdfPath = path.join(this.tempDir, `${uuidv4()}.pdf`);
    const tempPngPrefix = path.join(this.tempDir, `pdf_${uuidv4()}`);

    try {
      // Save PDF temporarily
      await fs.writeFile(tempPdfPath, fileBuffer);

      logger.info('Converting PDF to PNG using pdftoppm', { pageCount });

      // Use pdftoppm to convert PDF pages to PNG images
      // -png: output format
      // -r 150: 150 DPI resolution (reduced from 300 to fit Vision API limits)
      // -f 1 -l 5: first 5 pages only
      await execAsync(`pdftoppm -png -r 150 -f 1 -l 5 "${tempPdfPath}" "${tempPngPrefix}"`);

      // Find all generated PNG files
      const files = await fs.readdir(this.tempDir);
      const pngFiles = files
        .filter(f => f.startsWith(path.basename(tempPngPrefix)) && f.endsWith('.png'))
        .sort();

      logger.info(`Generated ${pngFiles.length} PNG files from PDF`);

      const pages: Array<{ pageNumber: number; text: string; confidence?: number }> = [];
      let fullText = '';

      // Process each PNG file
      for (let i = 0; i < pngFiles.length; i++) {
        const pngPath = path.join(this.tempDir, pngFiles[i]);
        logger.info(`Processing PDF page ${i + 1}/${pngFiles.length} via OCR`);

        const pngBuffer = await fs.readFile(pngPath);
        const ocrResult = await this.performOCR(pngBuffer);

        pages.push({
          pageNumber: i + 1,
          text: ocrResult.text,
          confidence: ocrResult.confidence,
        });

        fullText += ocrResult.text + '\n\n';

        // Clean up PNG file
        await fs.unlink(pngPath).catch(() => {});
      }

      // Clean up temp PDF
      await fs.unlink(tempPdfPath).catch(() => {});

      return {
        text: fullText,
        metadata: {
          pageCount: pageCount || pngFiles.length,
          source: 'ocr',
          mimeType: 'application/pdf',
        },
        pages,
      };
    } catch (error: any) {
      logger.error('PDF OCR failed', { error: error.message });
      // Clean up temp files
      await fs.unlink(tempPdfPath).catch(() => {});
      const files = await fs.readdir(this.tempDir).catch(() => []);
      for (const file of files) {
        if (file.startsWith(path.basename(tempPngPrefix))) {
          await fs.unlink(path.join(this.tempDir, file)).catch(() => {});
        }
      }
      throw error;
    }
  }

  /**
   * Parse DOCX document
   * Strategy: Try mammoth first, fallback to OCR
   */
  async parseDOCX(fileBuffer: Buffer): Promise<ParsedDocument> {
    try {
      // Strategy 1: Try native DOCX parsing with mammoth
      logger.info('Attempting native DOCX parsing with mammoth');
      const result = await mammoth.extractRawText({ buffer: fileBuffer });

      if (result.value && result.value.trim().length > 50) {
        logger.info('DOCX parsed successfully with mammoth', {
          textLength: result.value.length,
          messages: result.messages.length,
        });

        return {
          text: result.value,
          metadata: {
            source: 'native',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        };
      }

      // Strategy 2: Fallback to OCR
      logger.warn('DOCX has no extractable text, falling back to OCR');
      return await this.parseDOCXWithOCR(fileBuffer);
    } catch (error: any) {
      logger.error('DOCX parsing failed', { error: error.message });
      throw new Error(`Failed to parse DOCX: ${error.message}`);
    }
  }

  /**
   * Parse DOCX using OCR (screenshot → Vision API)
   */
  private async parseDOCXWithOCR(fileBuffer: Buffer): Promise<ParsedDocument> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      // Save DOCX temporarily
      const tempDocxPath = path.join(this.tempDir, `${uuidv4()}.docx`);
      await fs.writeFile(tempDocxPath, fileBuffer);

      // Convert to HTML first using mammoth
      const htmlResult = await mammoth.convertToHtml({ buffer: fileBuffer });
      const tempHtmlPath = path.join(this.tempDir, `${uuidv4()}.html`);
      await fs.writeFile(tempHtmlPath, htmlResult.value);

      // Open HTML in browser
      await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'networkidle' });

      // Screenshot and OCR
      const screenshot = await page.screenshot({ fullPage: true });
      const ocrResult = await this.performOCR(screenshot);

      await page.close();
      await fs.unlink(tempDocxPath).catch(() => {});
      await fs.unlink(tempHtmlPath).catch(() => {});

      return {
        text: ocrResult.text,
        metadata: {
          source: 'ocr',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        pages: [
          {
            pageNumber: 1,
            text: ocrResult.text,
            confidence: ocrResult.confidence,
          },
        ],
      };
    } catch (error: any) {
      await page.close();
      throw error;
    }
  }

  /**
   * Parse HTML document
   * Strategy: Extract text from DOM using Playwright (better than OCR for HTML)
   */
  async parseHTML(html: string | Buffer): Promise<ParsedDocument> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      // Auto-detect encoding or assume UTF-8
      let htmlContent: string;
      if (typeof html === 'string') {
        htmlContent = html;
      } else {
        // Try UTF-8 first, then Windows-1251 if UTF-8 fails
        try {
          htmlContent = html.toString('utf-8');
        } catch {
          // Fallback to latin1 which can decode any byte sequence
          htmlContent = html.toString('latin1');
        }
      }

      // Save HTML temporarily (use binary to preserve original encoding)
      const tempHtmlPath = path.join(this.tempDir, `${uuidv4()}.html`);
      await fs.writeFile(tempHtmlPath, html);

      logger.info('Parsing HTML by extracting text from DOM');

      await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'networkidle' });

      // Extract text directly from DOM (much better than OCR for HTML)
      const text = await page.evaluate(() => {
        // @ts-ignore - browser context
        const scripts = document.querySelectorAll('script, style');
        // @ts-ignore
        scripts.forEach((el: any) => el.remove());

        // @ts-ignore - browser context
        return document.body?.innerText || document.body?.textContent || '';
      });

      await page.close();
      await fs.unlink(tempHtmlPath).catch(() => {});

      logger.info('HTML parsing completed', { textLength: text.length });

      return {
        text: text,
        metadata: {
          source: 'native',
          mimeType: 'text/html',
        },
        pages: [
          {
            pageNumber: 1,
            text: text,
          },
        ],
      };
    } catch (error: any) {
      await page.close();
      throw error;
    }
  }

  /**
   * Perform OCR using Google Vision API
   */
  private async performOCR(imageBuffer: Buffer): Promise<{ text: string; confidence: number }> {
    try {
      logger.info('Performing OCR with Google Vision API', {
        imageSize: imageBuffer.length,
      });

      const [result] = await this.visionClient.documentTextDetection({
        image: { content: imageBuffer },
        imageContext: {
          languageHints: ['uk', 'ru', 'en'], // Ukrainian, Russian, English
        },
      });

      const fullTextAnnotation = result.fullTextAnnotation;

      if (!fullTextAnnotation || !fullTextAnnotation.text) {
        logger.warn('No text detected by Vision API');
        return { text: '', confidence: 0 };
      }

      // Calculate average confidence from pages
      const pages = fullTextAnnotation.pages || [];
      let totalConfidence = 0;
      let confidenceCount = 0;

      pages.forEach((page: any) => {
        page.blocks?.forEach((block: any) => {
          if (block.confidence !== undefined && block.confidence !== null) {
            totalConfidence += block.confidence;
            confidenceCount++;
          }
        });
      });

      const averageConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;

      logger.info('OCR completed', {
        textLength: fullTextAnnotation.text.length,
        confidence: averageConfidence,
      });

      return {
        text: fullTextAnnotation.text,
        confidence: averageConfidence,
      };
    } catch (error: any) {
      logger.error('OCR failed', { error: error.message });
      throw new Error(`OCR failed: ${error.message}`);
    }
  }

  /**
   * Auto-detect document type and parse
   */
  async parseDocument(fileBuffer: Buffer, mimeType?: string): Promise<ParsedDocument> {
    // Detect MIME type from buffer if not provided
    if (!mimeType) {
      mimeType = this.detectMimeType(fileBuffer);
    }

    logger.info('Parsing document', { mimeType, size: fileBuffer.length });

    switch (mimeType) {
      case 'application/pdf':
        return await this.parsePDF(fileBuffer);

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/msword':
        return await this.parseDOCX(fileBuffer);

      case 'text/html':
        return await this.parseHTML(fileBuffer);

      default:
        throw new Error(`Unsupported MIME type: ${mimeType}`);
    }
  }

  /**
   * Detect MIME type from file buffer
   */
  private detectMimeType(buffer: Buffer): string {
    // Check magic bytes
    const header = buffer.slice(0, 8).toString('hex');

    // PDF: %PDF (25 50 44 46)
    if (header.startsWith('25504446')) {
      return 'application/pdf';
    }

    // DOCX: PK (ZIP format) + check for word/ inside
    if (header.startsWith('504b0304')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }

    // HTML: check for common HTML tags
    const textStart = buffer.slice(0, 200).toString('utf-8').toLowerCase();
    if (textStart.includes('<html') || textStart.includes('<!doctype html')) {
      return 'text/html';
    }

    throw new Error('Could not detect document type from file buffer');
  }
}
