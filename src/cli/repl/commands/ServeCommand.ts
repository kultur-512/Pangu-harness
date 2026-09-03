// src/cli/repl/commands/ServeCommand.ts
// Start the optional SSE agent server so a frontend can stream runs.

import type { Command, CommandContext } from '../types.js';
import { createAgentServer } from '../../../server/agentServer.js';

const command: Command = {
  name: 'serve',
  description: 'Start SSE agent server for frontend streaming (POST /api/run)',
  category: 'system',
  usage: 'serve [--port 3456] [--host 127.0.0.1] [--serve-token <token>]',
  execute: async (ctx: CommandContext, args: string[]) => {
    let port = 3456;
    let host = '127.0.0.1';
    let serveToken: string | undefined;

    // naive arg parse (keep it simple, no heavy deps)
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--port' || a === '-p') {
        port = parseInt(args[i + 1] || '3456', 10) || 3456;
        i++;
      } else if (a === '--host' || a === '-h') {
        host = args[i + 1] || '127.0.0.1';
        i++;
      } else if (a === '--serve-token' || a === '-t') {
        serveToken = args[i + 1] || '';
        i++;
      }
    }

    // S4: token may come from the flag, the env var, or be absent (localhost-only).
    if (!serveToken && process.env.ZORGE_SERVE_TOKEN) {
      serveToken = process.env.ZORGE_SERVE_TOKEN;
    }

    ctx.renderer.info(`Starting Zorge SSE agent server on http://${host}:${port} ...`);
    ctx.renderer.writeLine('Endpoints:');
    ctx.renderer.writeLine(`  POST /api/run   { task, tier?, workspace?, model?, simulate? } → SSE stream`);
    ctx.renderer.writeLine(`  GET  /health`);
    ctx.renderer.writeLine('');
    if (serveToken) {
      ctx.renderer.writeLine('鉴权: Bearer token 已启用（请求头 Authorization: Bearer <token>）');
    } else {
      ctx.renderer.writeLine('鉴权: 未配置 token → 仅允许 localhost 来源（ZORGE_SERVE_TOKEN 或 --serve-token 开启）');
    }
    ctx.renderer.writeLine('');
    ctx.renderer.writeLine('Press Ctrl+C to stop the server.');

    const server = createAgentServer({
      port,
      host,
      provider: ctx.provider,
      defaultTier: ctx.session.tier,
      defaultWorkspace: ctx.session.workspace,
      serveToken,
    });

    await server.listen();

    // Keep the process alive until user interrupts
    return new Promise((resolve) => {
      const stop = () => {
        ctx.renderer.writeLine('\nStopping server...');
        server.close();
        resolve({ message: 'Server stopped.' });
      };

      // Handle Ctrl+C inside this command
      process.once('SIGINT', stop);

      // If the whole REPL is exiting, clean up
      const origRunning = (ctx.repl as any).running;
      // Best-effort: if REPL shuts down, close server
      setTimeout(() => {
        if (!(ctx.repl as any).running && origRunning) {
          server.close();
        }
      }, 100);
    });
  },
};

export default command;
