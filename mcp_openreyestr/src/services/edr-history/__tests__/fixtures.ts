/**
 * Synthetic ЄДР dumps for the edr-history tests. Every name, code and address is invented;
 * the shapes follow the data.gov.ua dumps (current SUBJECT, 2020-2022 SUBJECT with
 * addresses, 2018-2019 flat RECORD, 2016 ROWDATA/ROW with Ukrainian tags).
 */
import iconv from 'iconv-lite';

// zlib.crc32 needs Node >= 20.15; the package supports Node >= 20.0
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const SCARA_NEW = 'СКАРАМАНДЕР ЛІМІТЕД; HE123456; резиденство: Кіпр; розмір частки - 1000,00 грн.';
export const SCARA_2021 = 'СКАРАМАНДЕР ЛІМІТЕД, Кіпр, Кіпр, Нікосія, вул. Тестова, 5, розмір внеску до статутного фонду - 1000,00 грн.';
export const SCARA_OLD = 'СКАРАМАНДЕР ЛІМІТЕД (SCARAMANDER LIMITED), країна резиденства: Кіпр, місцезнаходження: Нікосія, вул. Тестова, 5, розмір внеску до статутного фонду - 1000.00 грн.';
export const JONES_NEW = 'ДЖОНС ДЖОН; громадянство: Кіпр; Непрямий вирішальний вплив; відсоток частки (непрямий вплив) - 100';
export const JONES_2021 = 'ДЖОНС ДЖОН; Кіпр; Кіпр, Нікосія, вул. Тестова, 5';
export const JONES_OLD = 'КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) - ДЖОНС ДЖОН, КІПР, Нікосія, вул. Тестова, 5';

export interface SubjectOpts {
  record: string; edrpou: string; name: string; stan?: string; address?: string; kved?: [string, string];
  founders?: string[]; benefs?: string[]; signers?: string[]; reg?: string; branch?: boolean;
}

export function subject(o: SubjectOpts): string {
  const f = (o.founders || []).map(x => `<FOUNDER>${x}</FOUNDER>`).join('');
  const b = (o.benefs || []).map(x => `<BENEFICIARY>${x}</BENEFICIARY>`).join('');
  const s = (o.signers || []).map(x => `<SIGNER>${x}</SIGNER>`).join('');
  const kved = o.kved
    ? `<ACTIVITY_KINDS><ACTIVITY_KIND><CODE>99.99</CODE><NAME>Інше</NAME></ACTIVITY_KIND><ACTIVITY_KIND><CODE>${o.kved[0]}</CODE><NAME>${o.kved[1]}</NAME><PRIMARY>так</PRIMARY></ACTIVITY_KIND></ACTIVITY_KINDS>`
    : '';
  const branch = o.branch ? '<TYPE_SUBJECT>Відокремлений підрозділ юридичної особи іноземної держави</TYPE_SUBJECT><TYPE_BRANCH>Представництво</TYPE_BRANCH>' : '';
  return `<SUBJECT><RECORD>${o.record}</RECORD><NAME>${o.name}</NAME><SHORT_NAME/>${branch}<OPF>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ</OPF>`
    + `<EDRPOU>${o.edrpou}</EDRPOU>${o.address ? `<ADDRESS>${o.address}</ADDRESS>` : ''}<STAN>${o.stan || 'зареєстровано'}</STAN>`
    + `<FOUNDERS>${f}</FOUNDERS><BENEFICIARIES>${b}</BENEFICIARIES>${kved}<SIGNERS>${s}</SIGNERS>`
    + `<AUTHORIZED_CAPITAL>1000,00</AUTHORIZED_CAPITAL><REGISTRATION>${o.reg || '01.03.2006; 01.03.2006; 10001020000000001'}</REGISTRATION>`
    + '<PREDECESSORS/><ASSIGNEES/><TERMINATED_INFO/><TERMINATION_CANCEL_INFO/><EXCHANGE_DATA/></SUBJECT>\n';
}

export const FOP_SUBJECT = '<SUBJECT><RECORD>653792</RECORD><NAME>ТЕСТЕНКО ОЛЕНА &#24;ІВАНІВНА</NAME><STAN>зареєстровано</STAN>'
  + '<REGISTRATION>18.07.2001; 06.09.2004; 20090170000000059</REGISTRATION></SUBJECT>\n';

/** <DATA><SUBJECT>... in windows-1251 (current and 2020-2022 format). */
export function subjectDump(...subjects: string[]): Buffer {
  return iconv.encode(`<?xml version="1.0" encoding="windows-1251"?>\n<DATA FORMAT_VERSION="1.0">\n${subjects.join('')}</DATA>\n`, 'win1251');
}

/** 2018-2019 flat RECORD format. */
export const RECORD_UO = `<?xml version="1.0" encoding="windows-1251"?>
<DATA FORMAT_VERSION="1.0">
<RECORD><NAME>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА"</NAME><SHORT_NAME>ТОВ "АЛЬФА"</SHORT_NAME><EDRPOU>11111111</EDRPOU>
<ADDRESS>01001, м.Київ, вул. Тестова, буд. 1</ADDRESS><BOSS>ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ</BOSS><KVED>46.90 Неспеціалізована оптова торгівля</KVED>
<STAN>зареєстровано</STAN><FOUNDERS><FOUNDER>${SCARA_OLD}</FOUNDER>
<FOUNDER>${JONES_OLD}</FOUNDER></FOUNDERS></RECORD>
<RECORD><NAME>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ГАММА"</NAME><SHORT_NAME/><EDRPOU>22222222</EDRPOU><ADDRESS>м.Львів</ADDRESS>
<BOSS>КОВАЛЬ ІВАН</BOSS><KVED/><STAN>зареєстровано</STAN><FOUNDERS><FOUNDER>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА", код ЄДРПОУ 11111111, країна резиденства: Україна, розмір внеску до статутного фонду - 500.00 грн.</FOUNDER></FOUNDERS></RECORD>
<RECORD><FIO>ТЕСТЕНКО ОЛЕНА ІВАНІВНА</FIO><ADDRESS>м.Київ</ADDRESS><KVED>47.11 Роздрібна торгівля</KVED><STAN>зареєстровано</STAN></RECORD>
</DATA>
`;

/** 2016 ROWDATA/ROW with Ukrainian tags (EXPERIMENTAL format). */
export const ROW_UO = `<?xml version="1.0" encoding="windows-1251"?>
<ROWDATA>
<ROW><Найменування>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА"</Найменування><Скорочена_назва>ТОВ "АЛЬФА"</Скорочена_назва><Код_ЄДРПОУ>11111111</Код_ЄДРПОУ><Місцезнаходження>01001, м.Київ, вул. Тестова, буд. 1</Місцезнаходження><ПІБ_керівника>ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ</ПІБ_керівника><Основний_вид_діяльності>46.90 Неспеціалізована оптова торгівля</Основний_вид_діяльності><Стан>зареєстровано</Стан></ROW>
<ROW Найменування="ПРИВАТНЕ ПІДПРИЄМСТВО &quot;ДЕЛЬТА&quot;" Код_ЄДРПОУ="44444444" Стан="припинено"/>
</ROWDATA>
`;

/** Minimal store-only zip writer (no compression) for fixtures with folders and several members. */
export function zipStore(entries: Array<[string, Buffer | string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const fname = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(fname.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(fname.length, 28); ch.writeUInt32LE(0, 30); ch.writeUInt32LE(0, 34);
    ch.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, fname, data);
    centrals.push(ch, fname);
    offset += lh.length + fname.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
