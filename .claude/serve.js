const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file);
    // A manifest served as octet-stream is ignored, and a service worker needs
    // a JS content type or the browser refuses to register it.
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
                    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8742, () => console.log('serving on 8742'));
