/** Minimal SMTP client (no dependency): plain, STARTTLS or implicit TLS. */
import { connect as netConnect } from 'node:net';

import { dependencyUnavailable } from '@triageai/kernel';
import { connect as tlsConnect } from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

function readReply(socket: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines.at(-1) ?? '';
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData);
        socket.off('error', onError);
        resolve(buffer);
      }
    };
    const onError = (error: Error) => {
      socket.off('data', onData);
      reject(error);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(
  socket: NodeJS.ReadWriteStream,
  line: string,
  expect = /^[23]/,
): Promise<string> {
  socket.write(`${line}\r\n`);
  const reply = await readReply(socket);
  if (!expect.test(reply.trim()))
    throw dependencyUnavailable(`SMTP rejected ${line.split(' ')[0]}: ${reply}`);
  return reply;
}

export async function sendMail(
  config: SmtpConfig,
  message: { to: string; subject: string; body: string; inReplyTo?: string; messageId: string },
): Promise<void> {
  const socket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  try {
    const greeting = await readReply(socket);
    if (!/^220/.test(greeting)) throw dependencyUnavailable(`SMTP greeting: ${greeting}`);
    await command(socket, `EHLO ${config.host}`);
    if (config.user && config.pass) {
      await command(socket, 'AUTH LOGIN', /^334/);
      await command(socket, Buffer.from(config.user).toString('base64'), /^334/);
      await command(socket, Buffer.from(config.pass).toString('base64'), /^235/);
    }
    await command(socket, `MAIL FROM:<${config.from}>`, /^250/);
    await command(socket, `RCPT TO:<${message.to}>`, /^25/);
    await command(socket, 'DATA', /^354/);
    const headers = [
      `From: ${config.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject.replace(/[\r\n]/g, ' ')}`,
      `Message-ID: <${message.messageId}>`,
      ...(message.inReplyTo
        ? [`In-Reply-To: <${message.inReplyTo}>`, `References: <${message.inReplyTo}>`]
        : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ];
    const body = message.body.replace(/\n\./g, '\n..');
    socket.write(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.\r\n`);
    const accepted = await readReply(socket);
    if (!/^250/.test(accepted)) throw dependencyUnavailable(`SMTP DATA rejected: ${accepted}`);
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}
