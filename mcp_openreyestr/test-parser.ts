import { createReadStream } from 'fs';
import { StreamingXMLParser } from './src/services/streaming-xml-parser.js';
import { ParsedUOEntity } from './src/services/xml-parser.js';

const parser = new StreamingXMLParser();
const stream = createReadStream('/tmp/test_uo.xml');

let count = 0;
parser.parseUOStream(stream, async (entity: ParsedUOEntity) => {
  count++;
  console.log(`\nEntity #${count}:`);
  console.log(`  Record: ${entity.record}`);
  console.log(`  Name: ${entity.name}`);
  console.log(`  EDRPOU: ${entity.edrpou}`);
  console.log(`  Stan: ${entity.stan}`);

  if (count >= 3) {
    process.exit(0);
  }
}).then(() => {
  console.log(`\nTotal entities processed: ${count}`);
});
