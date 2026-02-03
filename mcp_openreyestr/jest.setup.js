// Jest setup file
require('dotenv').config({ path: '.env.local' });

// Set test timeout
jest.setTimeout(30000);

// Mock console.log to reduce test noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: console.warn,
  error: console.error,
};
