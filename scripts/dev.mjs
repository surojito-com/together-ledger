import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 4173;
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function appServer(rootDirectory = root) {
  return createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const relative = normalize(pathname).replace(/^[/\\]+/, '');
    let file = join(rootDirectory, relative || 'index.html');
    if (!file.startsWith(rootDirectory) || !existsSync(file)) file = join(rootDirectory, 'index.html');
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    response.writeHead(200, { 'content-type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  appServer().listen(port, '127.0.0.1', () => {
    console.log(`Together Ledger is running at http://127.0.0.1:${port}`);
  });
}
