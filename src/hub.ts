import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

interface SocketAttachment {
  role: 'teacher' | 'student';
  sessionId?: string;
  classId?: string;
  seat?: number;
}

export class ClassroomHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const role = url.searchParams.get('role') === 'teacher' ? 'teacher' : 'student';
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const classId = url.searchParams.get('classId') || undefined;
      const seatParam = url.searchParams.get('seat');
      const seat = seatParam ? Number(seatParam) : undefined;

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const attachment: SocketAttachment = { role, sessionId, classId, seat };
      const tags: string[] = [role];
      if (sessionId) tags.push(`session:${sessionId}`);
      if (classId) tags.push(`class:${classId}`);

      this.ctx.acceptWebSocket(server, tags);
      server.serializeAttachment(attachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/online') {
      const classId = url.searchParams.get('classId');
      const seats = new Set<number>();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          const att = ws.deserializeAttachment() as SocketAttachment | null;
          if (att?.role === 'student' && att.seat && (!classId || att.classId === classId)) {
            seats.add(att.seat);
          }
        } catch {
          // ignore closed socket
        }
      }
      return Response.json({ seats: [...seats].sort((a, b) => a - b) });
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = (await request.json()) as {
        sessionId: string;
        classId: string;
        teacherView: unknown;
        studentViews: Record<string, unknown>;
      };

      const teacherMsg = JSON.stringify({ type: 'view', view: body.teacherView });

      for (const ws of this.ctx.getWebSockets()) {
        try {
          const att = ws.deserializeAttachment() as SocketAttachment | null;
          if (!att) continue;
          if (att.role === 'teacher' && att.sessionId === body.sessionId) {
            ws.send(teacherMsg);
          } else if (att.role === 'student' && att.classId === body.classId && att.seat) {
            const sv = body.studentViews[String(att.seat)];
            if (sv) {
              ws.send(JSON.stringify({ type: 'view', view: sv }));
            }
          }
        } catch {
          // ignore stale socket
        }
      }
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') {
      try {
        ws.send('pong');
      } catch {
        // ignore
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // ignore
    }
  }
}
