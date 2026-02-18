// Jest setup file
// Load environment variables
require('dotenv').config();

// Ensure console output is not buffered
if (typeof process.stdout.setEncoding === 'function') process.stdout.setEncoding('utf8');
if (typeof process.stderr.setEncoding === 'function') process.stderr.setEncoding('utf8');

// Make console.log output immediately
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

console.log = (...args) => {
  process.stdout.write(args.map(String).join(' ') + '\n');
};

console.error = (...args) => {
  process.stderr.write(args.map(String).join(' ') + '\n');
};

console.warn = (...args) => {
  process.stdout.write(args.map(String).join(' ') + '\n');
};

console.info = (...args) => {
  process.stdout.write(args.map(String).join(' ') + '\n');
};

// Mock File and Blob for cheerio/undici compatibility
if (typeof global.File === 'undefined') {
  global.File = class File extends Blob {
    constructor(bits, name, options) {
      super(bits, options);
      this.name = name;
      this.lastModified = options?.lastModified || Date.now();
    }
  };
}

if (typeof global.Blob === 'undefined') {
  global.Blob = class Blob {
    constructor(bits, options) {
      this.size = 0;
      this.type = options?.type || '';
    }
  };
}
