'use strict';
// Minimal Server-Sent Events hub.

class SseHub {
  constructor({ heartbeatMs = 20000 } = {}) {
    this.clients = new Set();
    // Comment lines keep idle connections from being reaped and surface dead ones.
    this.heartbeat = setInterval(() => this.writeAll(': ping\n\n'), heartbeatMs);
    this.heartbeat.unref();
  }

  open(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    // The response closes when the client goes away; the request's own
    // 'close' can fire as soon as its (empty) body has been read.
    res.on('close', () => this.clients.delete(res));
  }

  send(res, event, data) {
    res.write(format(event, data));
  }

  broadcast(event, data) {
    this.writeAll(format(event, data));
  }

  writeAll(chunk) {
    for (const res of this.clients) res.write(chunk);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

// JSON.stringify escapes newlines, so the payload always fits one data: line.
function format(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

module.exports = { SseHub };
