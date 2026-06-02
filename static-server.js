import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8081;
const ROOT = __dirname;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.md': 'text/markdown',
    '.txt': 'text/plain'
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') {
        urlPath = '/index.html';
    }

    const filePath = path.join(ROOT, urlPath);

    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not Found: ' + urlPath);
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + err.message);
            }
            return;
        }

        const mimeType = getMimeType(filePath);
        res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Static server running at http://localhost:${PORT}`);
    console.log(`Serving files from: ${ROOT}`);
});
