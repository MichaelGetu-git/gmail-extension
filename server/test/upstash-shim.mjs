// A local stand-in for Upstash's REST API, backed by a real redis-server, so
// the tests exercise real Redis semantics (NX locks, HSETNX, EVAL, ZSETs).
//   POST /           body ["CMD", ...args]      -> {result}
//   POST /pipeline   body [["CMD", ...], ...]   -> [{result}|{error}, ...]
import http from 'node:http';
import net from 'node:net';

function encode(args) {
  let s = `*${args.length}\r\n`;
  for (const a of args) { const b = Buffer.from(String(a)); s += `$${b.length}\r\n${b}\r\n`; }
  return s;
}

// A lost Redis connection (redis restarted, Docker stopped) fails the commands
// waiting on it with an error result, like Upstash would, and reconnects a
// second later, instead of an unhandled socket error ending the process.
class Resp {
  constructor(port) {
    this.port = port;
    this.queue = [];
    this.closed = false;
    this.connect();
  }
  connect() {
    this.buf = Buffer.alloc(0);
    this.sock = net.connect(this.port, '127.0.0.1');
    this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    this.sock.on('error', () => {});   // 'close' follows and handles it
    this.sock.on('close', () => {
      for (const resolve of this.queue.splice(0)) resolve({ error: 'ERR redis connection lost' });
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    });
  }
  send(args) {
    if (this.sock.destroyed) return Promise.resolve({ error: 'ERR redis not connected' });
    return new Promise((resolve) => { this.queue.push(resolve); this.sock.write(encode(args)); });
  }
  drain() {
    while (this.queue.length) {
      const r = this.parse(0);
      if (!r) return;
      this.buf = this.buf.subarray(r.end);
      this.queue.shift()(r.value);
    }
  }
  parse(i) {
    const nl = this.buf.indexOf('\r\n', i);
    if (nl < 0) return null;
    const type = String.fromCharCode(this.buf[i]);
    const line = this.buf.toString('utf8', i + 1, nl);
    const after = nl + 2;
    if (type === '+') return { value: { result: line }, end: after };
    if (type === '-') return { value: { error: line }, end: after };
    if (type === ':') return { value: { result: Number(line) }, end: after };
    if (type === '$') {
      const len = Number(line);
      if (len < 0) return { value: { result: null }, end: after };
      if (this.buf.length < after + len + 2) return null;
      return { value: { result: this.buf.toString('utf8', after, after + len) }, end: after + len + 2 };
    }
    if (type === '*') {
      const n = Number(line);
      if (n < 0) return { value: { result: null }, end: after };
      const out = [];
      let pos = after;
      for (let k = 0; k < n; k++) {
        const r = this.parse(pos);
        if (!r) return null;
        if (r.value.error) out.push(r.value.error); else out.push(r.value.result);
        pos = r.end;
      }
      return { value: { result: out }, end: pos };
    }
    throw new Error(`bad RESP type ${type}`);
  }
}

export function startShim({ redisPort, port = 0, token = 'test-token' }) {
  const pool = Array.from({ length: 8 }, () => new Resp(redisPort));
  let rr = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      try {
        const json = JSON.parse(body);
        const conn = pool[rr++ % pool.length];
        let out;
        if (req.url.startsWith('/pipeline')) out = await Promise.all(json.map((c) => conn.send(c)));
        else out = await conn.send(json);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port,
    close: () => { server.close(); pool.forEach((p) => { p.closed = true; p.sock.destroy(); }); }, flush: () => pool[0].send(['FLUSHDB']) })));
}
