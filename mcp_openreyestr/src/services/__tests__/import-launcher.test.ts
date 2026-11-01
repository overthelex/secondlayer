import { EventEmitter } from 'events';
import { ImportLauncher } from '../import-launcher';

function fakeChild(pid = 42) {
  const child: any = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const spec = { name: 'arma', title: 'АРМА', scriptPath: '/app/dist/scripts/import-arma.js' };

describe('ImportLauncher (LEXAI-2161)', () => {
  it('starts once, refuses a second run, and frees the slot on exit by signal', () => {
    const child = fakeChild();
    const spawn = jest.fn().mockReturnValue(child);
    const l = new ImportLauncher(logger(), spawn, () => true);

    expect(l.launch(spec, 'arma')).toEqual({ status: 202, body: { status: 'accepted', message: 'Імпорт АРМА запущено', registry: 'arma', pid: 42 } });
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['/app/dist/scripts/import-arma.js'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(l.launch(spec, 'arma')).toMatchObject({ status: 409, body: { error: 'Імпорт АРМА вже виконується' } });

    child.emit('exit', null, 'SIGKILL');
    expect(l.isRunning('arma')).toBe(false);
    spawn.mockReturnValue(fakeChild(43));
    expect(l.launch(spec, 'arma').status).toBe(202);
  });

  it('handles a spawn error event without throwing and frees the slot', () => {
    const child = fakeChild();
    const log = logger();
    const l = new ImportLauncher(log, jest.fn().mockReturnValue(child), () => true);
    l.launch(spec, 'arma');
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(l.isRunning('arma')).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  it('returns 500 when spawn throws synchronously', () => {
    const l = new ImportLauncher(logger(), jest.fn(() => { throw new Error('EAGAIN'); }), () => true);
    expect(l.launch(spec, 'arma')).toEqual({ status: 500, body: { error: 'Не вдалося запустити імпорт АРМА' } });
    expect(l.isRunning('arma')).toBe(false);
  });

  it('logs a missing script path but does not return it to the client', () => {
    const log = logger();
    const spawn = jest.fn();
    const l = new ImportLauncher(log, spawn, () => false);
    const res = l.launch(spec, 'arma');
    expect(res).toEqual({ status: 500, body: { error: 'Імпорт АРМА недоступний на цьому сервері' } });
    expect(JSON.stringify(res.body)).not.toContain('/app/dist');
    expect(log.error).toHaveBeenCalledWith(expect.any(String), { scriptPath: '/app/dist/scripts/import-arma.js' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps jobs with different names independent', () => {
    const l = new ImportLauncher(logger(), jest.fn(() => fakeChild()), () => true);
    expect(l.launch(spec, 'arma').status).toBe(202);
    expect(l.launch({ name: 'prozorro', title: 'ProZorro', scriptPath: '/x.js', args: ['--max-minutes=180'] }, 'prozorro').status).toBe(202);
  });
});
