export interface ProgressStats {
  parsed: number;
  imported: number;
  errors: number;
  skipped: number;
  unchanged: number;
  rate: number;
  heapMB: number;
  elapsedSec: number;
  etaMin: number | null;
}

export class ImportProgress {
  private label: string;
  private startTime: number;
  private parsed = 0;
  private imported = 0;
  private errors = 0;
  private skipped = 0;
  private unchanged = 0;
  private estimatedTotal: number | null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private printIntervalSec: number;
  private heapWarnMB: number;
  private heapWarned = false;

  constructor(label: string, options: {
    estimatedTotal?: number;
    printIntervalSec?: number;
    heapWarnMB?: number;
  } = {}) {
    this.label = label;
    this.estimatedTotal = options.estimatedTotal ?? null;
    this.printIntervalSec = options.printIntervalSec ?? parseInt(process.env.PROGRESS_INTERVAL_SEC || '5');
    this.heapWarnMB = options.heapWarnMB ?? 400;
    this.startTime = Date.now();
  }

  start(): void {
    this.startTime = Date.now();
    this.intervalId = setInterval(() => this.printLine(), this.printIntervalSec * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.printLine(); // Final print
    console.log(''); // newline after \r progress
  }

  addParsed(count: number): void {
    this.parsed += count;
  }

  addImported(count: number): void {
    this.imported += count;
  }

  addErrors(count: number): void {
    this.errors += count;
  }

  addSkipped(count: number): void {
    this.skipped += count;
  }

  addUnchanged(count: number): void {
    this.unchanged += count;
  }

  getStats(): ProgressStats {
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    const rate = elapsedSec > 0 ? Math.round(this.imported / elapsedSec) : 0;
    const heapMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    let etaMin: number | null = null;
    if (this.estimatedTotal && rate > 0) {
      const remaining = this.estimatedTotal - this.imported;
      etaMin = Math.round(remaining / rate / 60);
    }
    return {
      parsed: this.parsed,
      imported: this.imported,
      errors: this.errors,
      skipped: this.skipped,
      unchanged: this.unchanged,
      rate,
      heapMB,
      elapsedSec: Math.round(elapsedSec),
      etaMin,
    };
  }

  private printLine(): void {
    const s = this.getStats();
    const totalStr = this.estimatedTotal
      ? `/${this.formatNum(this.estimatedTotal)} (${Math.round((this.imported / this.estimatedTotal) * 100)}%)`
      : '';
    const etaStr = s.etaMin !== null ? ` | ETA: ${s.etaMin}min` : '';
    const line = `[${this.label}] ${this.formatNum(this.imported)}${totalStr} | ${this.formatNum(s.rate)}/s | ${s.heapMB}MB heap${etaStr} | Errors: ${s.errors} | Skipped: ${s.skipped}`;
    process.stdout.write(`\r${line.padEnd(120)}`);

    if (s.heapMB > this.heapWarnMB && !this.heapWarned) {
      this.heapWarned = true;
      console.warn(`\n⚠ Heap usage ${s.heapMB}MB exceeds ${this.heapWarnMB}MB threshold`);
    }
  }

  private formatNum(n: number): string {
    return n.toLocaleString('en-US');
  }
}
