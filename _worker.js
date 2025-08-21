export class RoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map(); // id -> {ws, lastSeen, state}
    this.state.blockConcurrencyWhile(async () => {
      // nothing to restore for this simple relay
    });
  }

  broadcast(payload, exceptId = null) {
    const text = JSON.stringify(payload);
    for (const [id, c] of this.clients) {
      if (id === exceptId) continue;
      try { c.ws.send(text); } catch {}
    }
  }

  prune() {
    const now = Date.now();
    for (const [id, c] of [...this.clients]) {
      if (now - c.lastSeen > 20000) { // 20s idle
        try { c.ws.close(1001, 'timeout'); } catch {}
        this.clients.delete(id);
        this.broadcast({type:'goodbye', id});
      }
    }
  }

  // Periodic broadcast of world state for late joiners / smoothing
  snapshotTick() {
    const clients = [];
    for (const [id, c] of this.clients) {
      if (c.state) clients.push(c.state);
    }
    const payload = {type:'state', clients};
    this.broadcast(payload);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/durable') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', {status:426});
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      let clientId = null;

      const heartbeat = setInterval(() => {
        try { server.send('{"type":"ping"}'); } catch {}
        this.prune();
        this.snapshotTick();
      }, 5000);

      server.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'hello' && msg.id) {
            clientId = String(msg.id);
            this.clients.set(clientId, {ws: server, lastSeen: Date.now(), state: null});
            // Immediately send current snapshot to the new client
            const clients = [];
            for (const [id, c] of this.clients) if (c.state) clients.push(c.state);
            server.send(JSON.stringify({type:'state', clients}));
          } else if (msg.type === 'update' && clientId && msg.state) {
            const c = this.clients.get(clientId);
            if (c) {
              c.lastSeen = Date.now();
              c.state = msg.state; // store latest state
              // Relay to others
              this.broadcast({type:'state', clients:[msg.state]}, clientId);
            }
          }
        } catch {}
      });

      server.addEventListener('close', () => {
        clearInterval(heartbeat);
        if (clientId && this.clients.has(clientId)) {
          this.clients.delete(clientId);
          this.broadcast({type:'goodbye', id: clientId});
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // Fallback
    return new Response('Room DO ready', {status:200});
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const id = env.ROOM_DO.idFromName('global-room');
      const stub = env.ROOM_DO.get(id);
      return stub.fetch(new Request(new URL('/durable', url).toString(), request));
    }
    return env.ASSETS.fetch(request); // Pages injects this
  }
};

export const durable_object = { RoomDurableObject };

export const onRequest = undefined; // ensure Pages Functions use module syntax
