// yauzl ships no types and @types/yauzl is not installed. Minimal surface used by
// services/edr-history/records.ts.
declare module 'yauzl' {
  import { Readable } from 'stream';
  import { EventEmitter } from 'events';
  export interface Entry {
    fileName: string | Buffer;
    generalPurposeBitFlag: number;
    uncompressedSize: number;
    compressedSize: number;
  }
  export interface ZipFile extends EventEmitter {
    readEntry(): void;
    openReadStream(entry: Entry, cb: (err: Error | null, stream?: Readable) => void): void;
    close(): void;
  }
  export function open(
    path: string,
    options: { lazyEntries?: boolean; autoClose?: boolean; decodeStrings?: boolean },
    cb: (err: Error | null, zip?: ZipFile) => void,
  ): void;
}
