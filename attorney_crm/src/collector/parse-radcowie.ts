// rejestrradcow.pl POST /Home/GetDataW → HTML fragment of .row.dataN blocks, 15 per page, no contacts.
import { normaliseEntryNumber, text } from './normalise';

export interface RadcaListRow {
  surname: string;
  givenNames: string;
  entryNumber: string;
  chamber: string;
  city: string;
  statusRaw: string;
}

export function parseRadcowieFragment(html: string): RadcaListRow[] {
  const rows: RadcaListRow[] = [];
  for (const m of html.matchAll(/<div Class="row data\d+">(.*?)<div Class="visible-xs/gis)) {
    const cells = [...m[1].matchAll(/<div Class="visible-sm[^"]*">(.*?)<\/div>/gis)].map((c) => text(c[1]));
    if (cells.length < 6) continue;
    const entryNumber = normaliseEntryNumber(cells[2]);
    if (!entryNumber) continue;
    rows.push({ surname: cells[0], givenNames: cells[1], entryNumber, chamber: cells[3], city: cells[4], statusRaw: cells[5] });
  }
  return rows;
}
