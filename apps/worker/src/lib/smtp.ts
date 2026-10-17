import { connect } from 'cloudflare:sockets';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls: () => SmtpSocket;
  close: () => Promise<void>;
}

// BE-R1: Per-operation read/write timeout so a non-responsive SMTP server can't
// hang the Worker until the platform kills the request.
const SMTP_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SMTP: operation timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Send an HTML email via a custom SMTP server.
// Supports implicit TLS (port 465) and STARTTLS (port 587 / others).
export async function sendViaSMTP(
  config: SmtpConfig,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const isImplicitTls = config.port === 465;

  const socket = connect({ hostname: config.host, port: config.port }, {
    secureTransport: isImplicitTls ? 'on' : 'off',
    allowHalfOpen: true,
  } as const) as SmtpSocket;

  const session = new SmtpSession(socket);
  try {
    // Read server greeting (220)
    await session.expect(220);

    // Send initial EHLO
    await session.cmd('EHLO shortlink');
    await session.expect(250);

    // Upgrade to TLS for non-implicit-TLS connections
    if (!isImplicitTls) {
      await session.tryStartTls();
    }

    // Authenticate if credentials are provided
    if (config.user) {
      await session.authLogin(config.user, config.pass);
    }

    await session.sendMessage(config.from, to, subject, html);
    await session.quit();
  } finally {
    await socket.close().catch(() => {});
  }
}

class SmtpSession {
  private buf = '';
  private readonly dec = new TextDecoder();
  private socket: SmtpSocket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(socket: SmtpSocket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  // Send STARTTLS and upgrade the socket to TLS in-place.
  // BE-S2: If the server declines STARTTLS (non-220), abort — never fall back to
  // sending credentials (AUTH LOGIN) over a plaintext channel.
  async tryStartTls(): Promise<void> {
    await this.cmd('STARTTLS');
    const resp = await this.readResponse();
    if (resp.code !== 220) {
      throw new Error(
        `SMTP: server declined STARTTLS (${resp.code} ${resp.message}); refusing to send credentials in plaintext`,
      );
    }

    // Release stream locks before handing the socket to startTls()
    this.reader.releaseLock();
    this.writer.releaseLock();

    const tls = this.socket.startTls();
    this.socket = tls;
    this.reader = tls.readable.getReader();
    this.writer = tls.writable.getWriter();
    this.buf = ''; // discard any buffered plain-text data

    // Re-issue EHLO on the now-TLS channel
    await this.cmd('EHLO shortlink');
    await this.expect(250);
  }

  async authLogin(user: string, pass: string): Promise<void> {
    await this.cmd('AUTH LOGIN');
    await this.expect(334); // server prompt: "Username:"
    await this.cmd(btoa(user));
    await this.expect(334); // server prompt: "Password:"
    await this.cmd(btoa(pass));
    await this.expect(235); // authenticated
  }

  async sendMessage(
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    await this.cmd(`MAIL FROM:<${from}>`);
    await this.expect(250);
    await this.cmd(`RCPT TO:<${to}>`);
    await this.expect(250);
    await this.cmd('DATA');
    await this.expect(354);

    const date = new Date().toUTCString();
    const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@shortlink>`;

    // Encode body as base64 — safe for all character sets without 8BITMIME negotiation
    const b64Body = wrapBase64(encodeUtf8Base64(html));

    const message =
      `From: ${from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Message-ID: ${msgId}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      `${b64Body}\r\n` +
      `.\r\n`; // end-of-data marker

    await withTimeout(
      this.writer.write(new TextEncoder().encode(message)),
      SMTP_TIMEOUT_MS,
    );
    await this.expect(250);
  }

  async quit(): Promise<void> {
    await this.cmd('QUIT').catch(() => {});
  }

  async cmd(text: string): Promise<void> {
    await withTimeout(
      this.writer.write(new TextEncoder().encode(`${text}\r\n`)),
      SMTP_TIMEOUT_MS,
    );
  }

  async expect(code: number): Promise<void> {
    const resp = await this.readResponse();
    if (resp.code !== code) {
      throw new Error(
        `SMTP: expected ${code}, got ${resp.code} — ${resp.message}`,
      );
    }
  }

  async readResponse(): Promise<{ code: number; message: string }> {
    const lines: string[] = [];
    for (;;) {
      // Buffer until we have at least one complete line
      while (!this.buf.includes('\r\n')) {
        const { value, done } = await withTimeout(
          this.reader.read(),
          SMTP_TIMEOUT_MS,
        );
        if (done) throw new Error('SMTP: connection closed unexpectedly');
        this.buf += this.dec.decode(value);
      }

      const eol = this.buf.indexOf('\r\n');
      const line = this.buf.slice(0, eol);
      this.buf = this.buf.slice(eol + 2);
      lines.push(line);

      // RFC 5321: last line has a space at position 3; continuation lines have '-'
      if (line.length <= 3 || line[3] === ' ') {
        const code = parseInt(line.slice(0, 3), 10);
        if (Number.isNaN(code))
          throw new Error(`SMTP: invalid response line: ${line}`);
        return { code, message: lines.map((l) => l.slice(4)).join('\n') };
      }
    }
  }
}

// Encode a UTF-8 string to base64 using the Workers runtime (btoa only handles latin-1).
function encodeUtf8Base64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// RFC 2045: base64 lines must not exceed 76 characters.
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
}
