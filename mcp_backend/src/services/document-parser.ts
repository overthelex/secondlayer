import { chromium, Browser } from 'playwright';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { logger } from '../utils/logger.js';
import { getLLMManager } from '../utils/llm-client-manager.js';
import fs from 'fs/promises';
import fsSync from 'fs';
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
  private visionClient: ImageAnnotatorClient | null = null;
  private ocrAvailable = false;
  private browser: Browser | null = null;
  private readonly tempDir = '/tmp/document-parser';

  constructor(visionKeyPath: string) {
    try {
      if (fsSync.existsSync(visionKeyPath)) {
        this.visionClient = new ImageAnnotatorClient({
          keyFilename: visionKeyPath,
        });
        this.ocrAvailable = true;
        logger.info('Vision OCR enabled', { keyPath: visionKeyPath });
      } else {
        logger.warn('Vision OCR credentials not found, OCR disabled', { keyPath: visionKeyPath });
      }
    } catch (err: any) {
      logger.warn('Vision OCR initialization failed, OCR disabled', { error: err.message });
    }
  }

  async initialize(): Promise<void> {
    // Ensure temp directory exists
    await fs.mkdir(this.tempDir, { recursive: true });
    logger.info('DocumentParser initialized', { tempDir: this.tempDir, ocrAvailable: this.ocrAvailable });
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
      // Strategy 1: Try native text extraction
      const parser = new PDFParse({ data: new Uint8Array(fileBuffer) });
      const textResult = await parser.getText();
      const pageCount = textResult.total || 1;
      const nativeText = textResult.text?.trim() || '';

      // If native extraction yields good text, use it
      if (nativeText.length > 100) {
        logger.info('PDF parsed with native text extraction', { textLength: nativeText.length, pageCount });
        return {
          text: nativeText,
          metadata: { pageCount, source: 'native', mimeType: 'application/pdf' },
        };
      }

      // Strategy 2: OCR fallback if available
      if (this.ocrAvailable) {
        logger.info('Native PDF text too short, falling back to OCR', { nativeTextLength: nativeText.length });
        return await this.parsePDFWithOCR(fileBuffer, pageCount);
      }

      // Strategy 3: Return whatever native text we got
      logger.warn('OCR not available and native text is sparse', { nativeTextLength: nativeText.length });
      return {
        text: nativeText || '[PDF could not be parsed — OCR credentials not configured]',
        metadata: { pageCount, source: 'native', mimeType: 'application/pdf' },
      };
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

      // Strategy 2: Fallback to OCR if available
      if (this.ocrAvailable) {
        logger.warn('DOCX has no extractable text, falling back to OCR');
        return await this.parseDOCXWithOCR(fileBuffer);
      }

      logger.warn('DOCX has no extractable text and OCR not available');
      return {
        text: result.value || '[DOCX could not be parsed — no text and OCR not configured]',
        metadata: { source: 'native', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      };
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
    if (!this.visionClient || !this.ocrAvailable) {
      throw new Error('OCR not available — Vision credentials not configured');
    }

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
   * Parse plain text document with encoding detection
   */
  async parsePlainText(fileBuffer: Buffer): Promise<ParsedDocument> {
    logger.info('Parsing plain text document', { size: fileBuffer.length });

    let text: string;

    // Check for BOM (Byte Order Mark)
    if (fileBuffer[0] === 0xEF && fileBuffer[1] === 0xBB && fileBuffer[2] === 0xBF) {
      // UTF-8 BOM
      text = fileBuffer.slice(3).toString('utf-8');
    } else if (fileBuffer[0] === 0xFF && fileBuffer[1] === 0xFE) {
      // UTF-16 LE BOM
      text = fileBuffer.slice(2).toString('utf16le');
    } else {
      // Try UTF-8, check for replacement characters that indicate wrong encoding
      text = fileBuffer.toString('utf-8');
      const replacementCount = (text.match(/\uFFFD/g) || []).length;
      if (replacementCount > text.length * 0.05) {
        // Too many replacement chars — likely Windows-1251 (common for Ukrainian docs)
        try {
          const decoder = new TextDecoder('windows-1251');
          text = decoder.decode(fileBuffer);
        } catch {
          // Keep UTF-8 result
        }
      }
    }

    if (!text.trim()) {
      throw new Error('Plain text file is empty');
    }

    logger.info('Plain text parsed', { textLength: text.length });

    return {
      text,
      metadata: {
        source: 'native',
        mimeType: 'text/plain',
      },
    };
  }

  /**
   * Parse RTF document by stripping control codes
   */
  async parseRTF(fileBuffer: Buffer): Promise<ParsedDocument> {
    logger.info('Parsing RTF document', { size: fileBuffer.length });

    const raw = fileBuffer.toString('latin1');

    // Strip RTF control sequences to extract plain text
    let text = raw;

    // Remove RTF header/groups
    text = text.replace(/\{\\rtf[^}]*\}/g, '');
    // Remove font tables, color tables, stylesheet, info groups
    text = text.replace(/\{\\fonttbl[^}]*(\{[^}]*\})*[^}]*\}/g, '');
    text = text.replace(/\{\\colortbl[^}]*\}/g, '');
    text = text.replace(/\{\\stylesheet[^}]*(\{[^}]*\})*[^}]*\}/g, '');
    text = text.replace(/\{\\info[^}]*(\{[^}]*\})*[^}]*\}/g, '');
    text = text.replace(/\{\\\*\\[^}]*\}/g, '');
    // Replace paragraph and line breaks
    text = text.replace(/\\par\b/g, '\n');
    text = text.replace(/\\line\b/g, '\n');
    text = text.replace(/\\tab\b/g, '\t');
    // Remove remaining control words
    text = text.replace(/\\[a-z]+(-?\d+)?\s?/gi, '');
    // Remove braces
    text = text.replace(/[{}]/g, '');
    // Decode Unicode escapes \'XX (hex byte — typically Windows-1251 for Ukrainian)
    text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
      const byte = parseInt(hex, 16);
      // Decode as Windows-1251 for values above 127
      if (byte > 127) {
        try {
          const decoder = new TextDecoder('windows-1251');
          return decoder.decode(new Uint8Array([byte]));
        } catch {
          return String.fromCharCode(byte);
        }
      }
      return String.fromCharCode(byte);
    });
    // Decode Unicode escapes \uNNNN
    text = text.replace(/\\u(\d+)\??/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    // Clean up whitespace
    text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    if (!text.trim()) {
      throw new Error('RTF file contains no extractable text');
    }

    logger.info('RTF parsed', { textLength: text.length });

    return {
      text,
      metadata: {
        source: 'native',
        mimeType: 'application/rtf',
      },
    };
  }

  /**
   * Attempt to parse unknown format using LLM
   * Sends a sample of the file content to LLM for format identification and text extraction
   */
  async parseWithLLM(fileBuffer: Buffer, mimeType: string): Promise<ParsedDocument> {
    logger.info('Attempting LLM-based parsing for unknown format', { mimeType, size: fileBuffer.length });

    // Take a sample (first 2KB) to send to LLM
    const sampleSize = Math.min(fileBuffer.length, 2048);
    let sample: string;

    // Try to read as text
    try {
      sample = fileBuffer.slice(0, sampleSize).toString('utf-8');
    } catch {
      sample = fileBuffer.slice(0, sampleSize).toString('latin1');
    }

    // Check if it's mostly binary (non-printable characters)
    const printableRatio = sample.replace(/[^\x20-\x7E\xA0-\xFF\u0400-\u04FF\n\r\t]/g, '').length / sample.length;
    if (printableRatio < 0.3) {
      throw new Error(
        `File appears to be binary (${(printableRatio * 100).toFixed(0)}% printable). ` +
        `MIME type: ${mimeType}. Cannot extract text from binary files.`
      );
    }

    const llm = getLLMManager();
    const response = await llm.chatCompletion({
      messages: [
        {
          role: 'system',
          content:
            'You are a document format analyst. Given a sample of file content, determine:\n' +
            '1. What format/type is this file?\n' +
            '2. Does it contain meaningful text data (legal docs, contracts, notes, etc.)?\n' +
            '3. If yes, extract the clean text content.\n\n' +
            'Respond in JSON format:\n' +
            '{"format": "description", "has_text": true/false, "text": "extracted text or empty", "reason": "why it does/doesnt have text"}',
        },
        {
          role: 'user',
          content:
            `MIME type: ${mimeType}\nFile size: ${fileBuffer.length} bytes\n\n` +
            `--- File content sample (first ${sampleSize} bytes) ---\n${sample}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }, 'quick');

    let result: { format: string; has_text: boolean; text: string; reason: string };
    try {
      result = JSON.parse(response.content);
    } catch {
      throw new Error(`LLM could not analyze file format: ${response.content.substring(0, 200)}`);
    }

    if (!result.has_text || !result.text?.trim()) {
      throw new Error(
        `File format "${result.format}" does not contain extractable text. ${result.reason || ''}`
      );
    }

    // If the sample was smaller than the file, extract full text
    let fullText = result.text;
    if (fileBuffer.length > sampleSize) {
      // For larger files, read entire content as text
      try {
        fullText = fileBuffer.toString('utf-8');
      } catch {
        fullText = fileBuffer.toString('latin1');
      }
      // Remove non-printable characters
      fullText = fullText.replace(/[^\x20-\x7E\xA0-\xFF\u0400-\u04FF\n\r\t]/g, '');
    }

    logger.info('LLM-based parsing completed', {
      format: result.format,
      textLength: fullText.length,
    });

    return {
      text: fullText,
      metadata: {
        source: 'native',
        mimeType,
      },
    };
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

      case 'text/plain':
        return await this.parsePlainText(fileBuffer);

      case 'application/rtf':
        return await this.parseRTF(fileBuffer);

      default:
        // Try LLM-based parsing for unknown formats
        logger.warn(`Unknown MIME type "${mimeType}", attempting LLM-based parsing`);
        return await this.parseWithLLM(fileBuffer, mimeType);
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

    // RTF: {\rtf
    const textStart = buffer.slice(0, 200).toString('utf-8');
    if (textStart.startsWith('{\\rtf')) {
      return 'application/rtf';
    }

    // HTML: check for common HTML tags
    const textLower = textStart.toLowerCase();
    if (textLower.includes('<html') || textLower.includes('<!doctype html')) {
      return 'text/html';
    }

    // Check if it looks like plain text (mostly printable characters)
    const sample = buffer.slice(0, Math.min(buffer.length, 512));
    const printable = sample.filter(
      (b) => (b >= 0x20 && b <= 0x7E) || b === 0x0A || b === 0x0D || b === 0x09 || b >= 0xC0
    ).length;
    if (printable / sample.length > 0.85) {
      return 'text/plain';
    }

    // Fall back to text/plain for unknown — parseWithLLM will handle in parseDocument
    return 'text/plain';
  }
}
