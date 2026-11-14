// serve: local HTTP server for the stage screen, data files, SSE and resolve. // [guard-serve:R1.1]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardDir } from './config.js';
import { startHumanWatch } from './humanwatch.js';
import { ResolveError, isChoice, recordResolution } from './resolve.js';
import { StreamHub, sseFrame } from './stream.js';
export { sseFrame };
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
};
const DATA_FILES = new Set(['index.json', 'report.json', 'resolution.json', 'sealed.json', 'events.jsonl']);
const RUN_NAME = /^runs\/[A-Za-z0-9_-]+__R\d+\.\d+\.json$/;
/** Content-Type for a file name by extension. // [guard-serve:R1.2] */
export function contentType(file) {
    return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
/** Default screen folder: `ui/` next to the CLI file, else `../../ui` from it. // [guard-serve:R1.2] */
export function defaultUiDir(cliDir = dirname(fileURLToPath(import.meta.url))) {
    const beside = join(cliDir, 'ui');
    return existsSync(beside) ? beside : resolve(cliDir, '..', '..', 'ui');
}
/** Absolute file for a URL path inside the screen folder, or null when outside. // [guard-serve:R1.2] */
export function resolveStaticPath(uiDir, urlPath) {
    let p = urlPath.split(/[?#]/)[0];
    try {
        p = decodeURIComponent(p);
    }
    catch {
        return null;
    }
    if (p.includes('\0') || p.includes(':'))
        return null;
    if (!p.startsWith('/'))
        p = '/' + p;
    if (p.endsWith('/'))
        p += 'index.html';
    const base = resolve(uiDir);
    const abs = resolve(base, '.' + p);
    return abs.startsWith(base + sep) ? abs : null;
}
/** True for the data names the screen may read. // [guard-serve:R1.3] */
export function isAllowedDataName(name) {
    return DATA_FILES.has(name) || RUN_NAME.test(name);
}
/** True for a loopback remote address. // [guard-serve:R4.1] */
export function isLoopback(addr) {
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
/** True when Origin is this server on 127.0.0.1 or localhost. // [guard-serve:R4.1] */
export function isAllowedOrigin(origin, port) {
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
export function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(body);
}
function sendFile(req, res, abs, extra = {}) {
    let st;
    try {
        st = statSync(abs);
    }
    catch {
        send(res, 404, 'not found\n');
        return;
    }
    if (!st.isFile()) {
        send(res, 404, 'not found\n');
        return;
    }
    res.writeHead(200, { 'Content-Type': contentType(abs), 'Content-Length': st.size, ...extra });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    const s = createReadStream(abs);
    s.on('error', () => res.destroy());
    s.pipe(res);
}
/** Serve one request. // [guard-serve:R4.4] */
function handle(req, res, routes, root, uiDir, port) {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = url.split(/[?#]/)[0];
    const api = routes.get(pathname);
    if (api) {
        if (method !== api.method) {
            send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: api.method });
            return;
        }
        api.handler(req, res, { root, port });
        return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
        return;
    }
    if (pathname.startsWith('/data/')) {
        let name;
        try {
            name = decodeURIComponent(pathname.slice('/data/'.length));
        }
        catch {
            send(res, 404, 'not found\n');
            return;
        }
        if (!isAllowedDataName(name)) {
            send(res, 404, 'not found\n');
            return;
        }
        sendFile(req, res, join(guardDir(root), ...name.split('/')), { 'Cache-Control': 'no-store' }); // [guard-serve:R1.3]
        return;
    }
    const abs = resolveStaticPath(uiDir, pathname);
    if (abs === null) {
        send(res, 404, 'not found\n');
        return;
    }
    sendFile(req, res, abs);
}
const BODY_LIMIT = 4096;
/** Read a body up to the limit; null when it is larger. */
function readBody(req) {
    return new Promise((ok) => {
        const chunks = [];
        let size = 0;
        let over = false;
        req.on('data', (c) => {
            size += c.length;
            if (size > BODY_LIMIT)
                over = true;
            else
                chunks.push(c);
        });
        req.on('end', () => ok(over ? null : Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => ok(null));
    });
}
const json = (res, status, value) => send(res, status, JSON.stringify(value) + '\n', 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
/** POST /api/resolve: record a human resolution. // [guard-serve:R4.1][guard-serve:R4.2][guard-serve:R4.3] */
function handleResolve(req, res, root, port) {
    if (!isLoopback(req.socket.remoteAddress) || !isAllowedOrigin(req.headers.origin, port)) {
        json(res, 403, { error: 'forbidden' });
        return;
    }
    void readBody(req).then((text) => {
        let body;
        try {
            if (text === null)
                throw new Error('too large');
            body = JSON.parse(text);
        }
        catch {
            json(res, 400, { error: 'body must be JSON of at most 4KB' });
            return;
        }
        const b = body;
        if (typeof b !== 'object' || b === null || Array.isArray(b) || !isChoice(b.choice) || (b.requirement !== undefined && (typeof b.requirement !== 'string' || b.requirement === ''))) {
            json(res, 400, { error: 'expected {"choice":"revert-code"|"edit-spec","requirement":"<id>"}' });
            return;
        }
        try {
            const r = recordResolution(root, b.requirement === undefined ? undefined : [b.requirement], b.choice);
            json(res, 200, r.resolution);
        }
        catch (e) {
            if (e instanceof ResolveError)
                json(res, e.status, { error: e.message });
            else
                json(res, 500, { error: 'internal error' });
        }
    });
}
/** Start the server on 127.0.0.1; rejects when the port cannot be used. // [guard-serve:R1.1] */
export function startServe(o, onReady) {
    const root = resolve(o.root);
    const uiDir = resolve(o.uiDir ?? defaultUiDir());
    return new Promise((ok, fail) => {
        let port = o.port;
        const hub = new StreamHub(root, o.pingMs);
        const stopWatch = o.humanWatch === false ? () => undefined : startHumanWatch({ root, cliFile: join(dirname(fileURLToPath(import.meta.url)), 'cli.js') });
        const routes = new Map();
        routes.set('/api/resolve', { method: 'POST', handler: (req, res, ctx) => handleResolve(req, res, ctx.root, ctx.port) });
        routes.set('/api/stream', { method: 'GET', handler: (_req, res) => hub.connect(res) });
        const server = createServer((req, res) => {
            try {
                handle(req, res, routes, root, uiDir, port);
            }
            catch {
                if (!res.headersSent)
                    send(res, 500, 'internal error\n');
                else
                    res.destroy();
            }
        });
        server.once('error', (e) => {
            hub.close();
            stopWatch();
            fail(e);
        });
        server.listen(o.port, '127.0.0.1', () => {
            port = server.address().port;
            server.removeAllListeners('error');
            server.on('error', () => undefined);
            onReady?.(port);
            ok({
                server,
                port,
                uiDir,
                close: () => new Promise((done) => {
                    hub.close();
                    stopWatch();
                    server.closeAllConnections();
                    server.close(() => done());
                }),
            });
        });
    });
}
