import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('dist');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json' };
http.createServer(async(req,res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url,'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url,'http://localhost').pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const body = await readFile(path);
    res.writeHead(200,{'Content-Type':types[extname(path)] || 'application/octet-stream','Cache-Control':'no-cache'}); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(5173, '127.0.0.1', () => console.log('Local: http://127.0.0.1:5173'));
