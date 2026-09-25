import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, 'public');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
const inside = (base, file) => { const rel = relative(base,file); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); };

export function createPreviewServer() {
  return createServer(async (req,res) => {
    const send = (status,body,type='text/plain; charset=utf-8') => {
      res.writeHead(status, {'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(req.method==='HEAD' ? undefined : body);
    };
    if (!['GET','HEAD'].includes(req.method)) { req.resume(); return send(405,'Read-only preview: this server accepts GET and HEAD only.'); }
    try {
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (!pathname.startsWith('/') || /[\\\x00-\x1f:]/.test(pathname) || pathname.split('/').some(p=>p==='.'||p==='..')) return send(400,'Invalid path.');
      if (pathname==='/api/catalog') return send(200,await readFile(resolve(root,'catalog.json')),'application/json; charset=utf-8');
      if (pathname.startsWith('/api/')) return send(404,'No AI API is included.');
      const file=await realpath(resolve(publicRoot,'.'+(pathname==='/'?'/index.html':pathname)));
      if (!inside(await realpath(publicRoot),file)) return send(403,'Forbidden.');
      if (!(await stat(file)).isFile()) return send(404,'Not found.');
      send(200,await readFile(file),types[extname(file)] || 'application/octet-stream');
    } catch (error) { send(error instanceof URIError?400:404,'Not found or invalid path.'); }
  });
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const portText=process.env.PORT || '4186';
  if (!/^\d{1,5}$/.test(portText) || +portText<1 || +portText>65535) throw new Error('PORT must be 1–65535.');
  const server=createPreviewServer();
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(+portText,'127.0.0.1',()=>console.log(`Tilekind non-AI preview: http://127.0.0.1:${portText}`));
}
