// Isolated Swift/Node interoperability fixture. Never uses desktop/data/.
import fs from 'node:fs';
import path from 'node:path';
import { createService } from '../server.mjs';

const directory = fs.mkdtempSync('/private/tmp/linkflow-ios-sync-');
const service = await createService({ dataDir: path.join(directory, 'pc'), webPort: 0, syncPort: 0, syncHost: '127.0.0.1' });
const webURL = new URL(service.url).origin;
const response = await fetch(webURL + '/api/pairing', {
  method: 'POST', headers: { 'X-LinkFlow-Key': service.localKey, 'Content-Type': 'application/json' }, body: '{}'
});
if (!response.ok) throw new Error(`Fixture pairing failed: ${response.status}`);
const pairing = await response.json();
const config = path.join(directory, 'fixture.json');
// Synthetic credentials are handed to the CLI in a private temporary file, never
// in argv, screenshots, checked-in artifacts, or console output.
fs.writeFileSync(config, JSON.stringify({ code: pairing.code, webURL, webKey: service.localKey, libraryId: service.library.meta('libraryId') }), { mode: 0o600, flag: 'wx' });
console.log('READY fixture=' + config);
console.log('HTTPS loopback port=' + service.syncPort + '; persistent fixture data retained for inspection');
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await service.close();
  console.log('STOPPED isolated service');
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
