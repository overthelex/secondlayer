import { ParsedUOEntity, ParsedFOPEntity, ParsedFSUEntity } from './xml-parser.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidationSummary {
  total: number;
  valid: number;
  skipped: number;
  warnings: number;
}

const EDRPOU_REGEX = /^\d{8}$/;
const SKIP_INVALID = process.env.FAIL_ON_INVALID !== 'true';

// Max allowed future date offset (1 year from now)
const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

export class EntityValidator {
  private summary: ValidationSummary = { total: 0, valid: 0, skipped: 0, warnings: 0 };

  validateUO(entity: ParsedUOEntity): ValidationResult {
    this.summary.total++;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!entity.record) errors.push('Missing record');
    if (!entity.name) errors.push('Missing name');
    if (entity.edrpou && !EDRPOU_REGEX.test(entity.edrpou)) {
      errors.push(`Invalid EDRPOU format: ${entity.edrpou}`);
    }
    if (!entity.edrpou) warnings.push('Missing EDRPOU');

    this.validateDateField(entity.registration, 'registration', warnings);
    this.validateDateField(entity.terminated_info, 'terminated_info', warnings);

    if (entity.authorized_capital) {
      const val = parseFloat(entity.authorized_capital.replace(',', '.'));
      if (isNaN(val)) warnings.push(`Invalid authorized_capital: ${entity.authorized_capital}`);
    }

    return this.buildResult(errors, warnings);
  }

  validateFOP(entity: ParsedFOPEntity): ValidationResult {
    this.summary.total++;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!entity.record) errors.push('Missing record');
    if (!entity.name) errors.push('Missing name');

    this.validateDateField(entity.registration, 'registration', warnings);
    this.validateDateField(entity.terminated_info, 'terminated_info', warnings);

    return this.buildResult(errors, warnings);
  }

  validateFSU(entity: ParsedFSUEntity): ValidationResult {
    this.summary.total++;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!entity.record) errors.push('Missing record');
    if (!entity.name) errors.push('Missing name');
    if (entity.edrpou && !EDRPOU_REGEX.test(entity.edrpou)) {
      errors.push(`Invalid EDRPOU format: ${entity.edrpou}`);
    }
    if (!entity.edrpou) warnings.push('Missing EDRPOU');

    this.validateDateField(entity.registration, 'registration', warnings);
    this.validateDateField(entity.terminated_info, 'terminated_info', warnings);

    return this.buildResult(errors, warnings);
  }

  get skipInvalid(): boolean {
    return SKIP_INVALID;
  }

  getSummary(): ValidationSummary {
    return { ...this.summary };
  }

  resetSummary(): void {
    this.summary = { total: 0, valid: 0, skipped: 0, warnings: 0 };
  }

  private validateDateField(value: string | undefined, fieldName: string, warnings: string[]): void {
    if (!value) return;

    // Try to extract a date from the field — may contain text like "зареєстровано 01.01.2020"
    const dateMatch = value.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (dateMatch) {
      const [, dd, mm, yyyy] = dateMatch;
      const date = new Date(`${yyyy}-${mm}-${dd}`);
      if (isNaN(date.getTime())) {
        warnings.push(`Invalid date in ${fieldName}: ${value.substring(0, 50)}`);
      } else if (date.getTime() > Date.now() + MAX_FUTURE_MS) {
        warnings.push(`Future date in ${fieldName}: ${dd}.${mm}.${yyyy}`);
      }
    }
    // Also check ISO format
    const isoMatch = value.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch && !dateMatch) {
      const date = new Date(isoMatch[0]);
      if (isNaN(date.getTime())) {
        warnings.push(`Invalid ISO date in ${fieldName}: ${value.substring(0, 50)}`);
      } else if (date.getTime() > Date.now() + MAX_FUTURE_MS) {
        warnings.push(`Future date in ${fieldName}: ${isoMatch[0]}`);
      }
    }
  }

  private buildResult(errors: string[], warnings: string[]): ValidationResult {
    const valid = errors.length === 0;
    if (valid) {
      this.summary.valid++;
    } else {
      this.summary.skipped++;
    }
    if (warnings.length > 0) {
      this.summary.warnings++;
    }
    return { valid, errors, warnings };
  }
}
