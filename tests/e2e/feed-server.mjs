import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

/**
 * A tiny feed host for the e2e stack (S6-04): serves the non-Kyero fixture feed on loopback, the way an agency's
 * CRM export would be served. The api and the worker may fetch it because `loopback-feeds.ts` allows exactly this
 * origin in their process (it is blocked everywhere else: private addresses are never fetched).
 */
const port = Number(process.argv[2]);
const root = join(import.meta.dirname, '..', 'fixtures', 'xml-mapped');
createServer((req, res) => {
  if (req.url === '/healthz') return res.writeHead(200).end('ok');
  if (req.url === '/estate.xml') {
    return res.writeHead(200, { 'content-type': 'application/xml' }).end(readFileSync(join(root, 'estate-export.xml')));
  }
  return res.writeHead(404).end();
}).listen(port, '127.0.0.1');
