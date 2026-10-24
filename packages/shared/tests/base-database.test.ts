/**
 * Tests for BaseDatabase — pool creation, connect, query, transaction,
 * pool stats, metrics collector, close, schema sanitization, and createDatabaseFromEnv.
 */

import { EventEmitter } from 'events';

const mockQuery = jest.fn();
const mockRelease = jest.fn();
// Real EventEmitter so the checked-out client supports on()/removeListener()/emit()
// — the transaction helper attaches an 'error' listener to it, and the
// idle-in-transaction regression test emits a real 'error' event.
const mockClient: any = Object.assign(new EventEmitter(), {
  query: mockQuery,
  release: mockRelease,
});
const mockConnect = jest.fn().mockResolvedValue(mockClient);
const mockPoolQuery = jest.fn();
const mockEnd = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockPoolQuery,
    end: mockEnd,
    on: mockOn,
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
  })),
  types: { setTypeParser: jest.fn() },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

import { BaseDatabase, createDatabaseFromEnv, DatabaseConfig } from '../src/database/base-database';
import { Pool } from 'pg';

describe('BaseDatabase', () => {
  const defaultConfig: DatabaseConfig = {
    host: 'localhost',
    port: 5432,
    user: 'testuser',
    password: 'testpass',
    database: 'testdb',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('constructor', () => {
    it('should create pool with provided config', () => {
      new BaseDatabase(defaultConfig);

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'localhost',
          port: 5432,
          user: 'testuser',
          password: 'testpass',
          database: 'testdb',
          max: 100,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        })
      );
    });

    it('should use custom pool size', () => {
      new BaseDatabase({ ...defaultConfig, max: 50 });

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({ max: 50 })
      );
    });

    it('should set schema search path when provided', () => {
      new BaseDatabase({ ...defaultConfig, schema: 'myschema' });

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          options: '-c search_path=myschema,public',
        })
      );
    });

    it('should reject invalid schema names', () => {
      expect(() => {
        new BaseDatabase({ ...defaultConfig, schema: 'DROP TABLE;' });
      }).toThrow('Invalid SQL identifier');
    });

    it('should reject schema names with special characters', () => {
      expect(() => {
        new BaseDatabase({ ...defaultConfig, schema: 'my-schema' });
      }).toThrow('Invalid SQL identifier');
    });

    it('should register pool error handler', () => {
      new BaseDatabase(defaultConfig);
      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('connect', () => {
    it('should verify connection with SELECT NOW()', async () => {
      const db = new BaseDatabase(defaultConfig);

      await db.connect();

      expect(mockConnect).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith('SELECT NOW()');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should throw on connection failure', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));
      const db = new BaseDatabase(defaultConfig);

      await expect(db.connect()).rejects.toThrow('Connection refused');
    });
  });

  describe('query', () => {
    it('should execute query and return result', async () => {
      const mockResult = { rows: [{ id: 1 }], rowCount: 1 };
      mockPoolQuery.mockResolvedValueOnce(mockResult);
      const db = new BaseDatabase(defaultConfig);

      const result = await db.query('SELECT * FROM users WHERE id = $1', [1]);

      expect(mockPoolQuery).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1]);
      expect(result).toEqual(mockResult);
    });

    it('should execute query without params', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const db = new BaseDatabase(defaultConfig);

      await db.query('SELECT 1');

      expect(mockPoolQuery).toHaveBeenCalledWith('SELECT 1', undefined);
    });

    it('should throw on query error', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('syntax error'));
      const db = new BaseDatabase(defaultConfig);

      await expect(db.query('INVALID SQL')).rejects.toThrow('syntax error');
    });
  });

  describe('transaction', () => {
    it('should execute callback within BEGIN/COMMIT', async () => {
      const db = new BaseDatabase(defaultConfig);
      const callback = jest.fn().mockResolvedValue('result');

      const result = await db.transaction(callback);

      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(callback).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockRelease).toHaveBeenCalled();
      expect(result).toBe('result');
    });

    it('should ROLLBACK on callback error', async () => {
      const db = new BaseDatabase(defaultConfig);
      const callback = jest.fn().mockRejectedValue(new Error('insert failed'));

      await expect(db.transaction(callback)).rejects.toThrow('insert failed');

      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should release client even on ROLLBACK error', async () => {
      const db = new BaseDatabase(defaultConfig);
      const callback = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(db.transaction(callback)).rejects.toThrow();

      expect(mockRelease).toHaveBeenCalled();
    });

    it('captures an async client error (idle-in-transaction) instead of crashing the process', async () => {
      const db = new BaseDatabase(defaultConfig);
      const fatal = new Error('terminating connection due to idle-in-transaction timeout');
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(fatal)        // COMMIT fails on the dead connection
        .mockRejectedValueOnce(fatal);       // ROLLBACK also fails

      // Postgres kills the idle-in-transaction session; pg emits 'error' on the
      // checked-out client. Without the helper's listener this throws
      // synchronously and crashes the process.
      let emitThrew = false;
      const callback = jest.fn().mockImplementation(async () => {
        try {
          mockClient.emit('error', fatal);
        } catch {
          emitThrew = true;
        }
      });

      await expect(db.transaction(callback)).rejects.toBe(fatal);
      expect(emitThrew).toBe(false);
      // The poisoned connection is destroyed (released WITH the error), not
      // returned to the pool.
      expect(mockRelease).toHaveBeenCalledWith(fatal);
    });

    it('releases the client without an error on a clean commit', async () => {
      const db = new BaseDatabase(defaultConfig);
      const callback = jest.fn().mockResolvedValue('ok');

      await db.transaction(callback);

      expect(mockRelease).toHaveBeenCalledWith(undefined);
    });
  });

  describe('getPool', () => {
    it('should return the pool instance', () => {
      const db = new BaseDatabase(defaultConfig);
      expect(db.getPool()).toBeDefined();
    });
  });

  describe('getPoolStats', () => {
    it('should return pool statistics', () => {
      const db = new BaseDatabase(defaultConfig);
      const stats = db.getPoolStats();

      expect(stats).toEqual({
        total: 5,
        idle: 3,
        waiting: 0,
      });
    });
  });

  describe('setMetricsCollector', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should call callback with pool stats every 5 seconds', () => {
      const db = new BaseDatabase(defaultConfig);
      const callback = jest.fn();

      db.setMetricsCollector(callback);

      jest.advanceTimersByTime(5000);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({ total: 5, idle: 3, waiting: 0 });

      jest.advanceTimersByTime(5000);
      expect(callback).toHaveBeenCalledTimes(2);

      // Cleanup
      db.close();
    });

    it('should replace previous metrics collector', () => {
      const db = new BaseDatabase(defaultConfig);
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      db.setMetricsCollector(callback1);
      db.setMetricsCollector(callback2);

      jest.advanceTimersByTime(5000);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);

      db.close();
    });
  });

  describe('close', () => {
    it('should end pool', async () => {
      const db = new BaseDatabase(defaultConfig);

      await db.close();

      expect(mockEnd).toHaveBeenCalled();
    });

    it('should clear metrics interval on close', async () => {
      jest.useFakeTimers();
      const db = new BaseDatabase(defaultConfig);
      const callback = jest.fn();

      db.setMetricsCollector(callback);
      await db.close();

      jest.advanceTimersByTime(10000);
      expect(callback).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });
});

describe('createDatabaseFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should use env vars when available', () => {
    process.env.POSTGRES_HOST = 'db.prod.com';
    process.env.POSTGRES_PORT = '5433';
    process.env.POSTGRES_USER = 'admin';
    process.env.POSTGRES_PASSWORD = 'secret';
    process.env.POSTGRES_DB = 'production';
    process.env.POSTGRES_SCHEMA = 'app';
    process.env.POSTGRES_POOL_MAX = '200';

    const db = createDatabaseFromEnv({});

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'db.prod.com',
        port: 5433,
        user: 'admin',
        password: 'secret',
        database: 'production',
        max: 200,
        options: '-c search_path=app,public',
      })
    );

    expect(db).toBeInstanceOf(BaseDatabase);
  });

  it('should fall back to defaults when env vars absent', () => {
    delete process.env.POSTGRES_HOST;
    delete process.env.POSTGRES_PORT;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.POSTGRES_DB;
    delete process.env.POSTGRES_SCHEMA;
    delete process.env.POSTGRES_POOL_MAX;

    createDatabaseFromEnv({
      host: 'fallback-host',
      port: 5434,
      user: 'fallback-user',
      password: 'fallback-pass',
      database: 'fallback-db',
    });

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'fallback-host',
        port: 5434,
        user: 'fallback-user',
        password: 'fallback-pass',
        database: 'fallback-db',
      })
    );
  });

  it('should use hardcoded defaults when neither env nor defaults provided', () => {
    delete process.env.POSTGRES_HOST;
    delete process.env.POSTGRES_PORT;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.POSTGRES_DB;
    delete process.env.POSTGRES_SCHEMA;
    delete process.env.POSTGRES_POOL_MAX;

    createDatabaseFromEnv({});

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: 'password',
        database: 'postgres',
      })
    );
  });

  it('should skip schema when empty string', () => {
    delete process.env.POSTGRES_SCHEMA;

    createDatabaseFromEnv({ schema: '' });

    expect(Pool).toHaveBeenCalledWith(
      expect.not.objectContaining({ options: expect.anything() })
    );
  });
});
