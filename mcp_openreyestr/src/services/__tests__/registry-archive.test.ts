import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractZip, findDataFile } from '../registry-archive';

describe('findDataFile', () => {
  it('never picks a nested archive whose name matches innerFileName', () => {
    const files = ['25.1-edrnpa_cards.zip', 'edrnpa_cards_2026-11-15.xml', 'edrnpa_text_2026-11-15.xml'];
    expect(findDataFile(files, { format: 'xml', innerFileName: 'edrnpa_cards' })).toBe('edrnpa_cards_2026-11-15.xml');
  });

  it('returns undefined when only the archive matches and no data file exists', () => {
    expect(findDataFile(['25.1-edrnpa_cards.zip'], { format: 'xml', innerFileName: 'edrnpa_cards' })).toBeUndefined();
  });

  it('falls back to the first file with the format extension', () => {
    expect(findDataFile(['readme.txt', 'data.csv'], { format: 'csv', innerFileName: 'missing' })).toBe('data.csv');
    expect(findDataFile(['a.xml'], { format: 'xml', innerFileName: '' })).toBe('a.xml');
  });
});

describe('extractZip with a nested archive (25-edrnpa layout)', () => {
  let hasZip = true;
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch { hasZip = false; }
  const maybe = hasZip ? it : it.skip;

  maybe('extracts the inner archive and returns only data files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-archive-'));
    try {
      const build = path.join(tmp, 'build');
      fs.mkdirSync(build);
      fs.writeFileSync(path.join(build, 'edrnpa_cards_2026-11-15.xml'), '<rna><database><document/></database></rna>');
      execFileSync('zip', ['-q', '-j', path.join(build, '25.1-edrnpa_cards.zip'), path.join(build, 'edrnpa_cards_2026-11-15.xml')]);
      execFileSync('zip', ['-q', '-j', path.join(tmp, '25-edrnpa.zip'), path.join(build, '25.1-edrnpa_cards.zip')]);

      const out = path.join(tmp, 'out');
      fs.mkdirSync(out);
      const files = await extractZip(path.join(tmp, '25-edrnpa.zip'), out);
      expect(files).toEqual(['edrnpa_cards_2026-11-15.xml']);
      expect(findDataFile(files, { format: 'xml', innerFileName: 'edrnpa_cards' })).toBe('edrnpa_cards_2026-11-15.xml');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
