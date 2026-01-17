// Jest setup file
// Load environment variables
require('dotenv').config();

// Ensure console output is not buffered
process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

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
