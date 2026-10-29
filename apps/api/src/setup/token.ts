/**
 * One-time setup token (ADR-0024). An unauthenticated first-run wizard would
 * let whoever reaches the port first configure the instance and create its
 * admin, so pending setup requires `Authorization: Setup <token>`. The token
 * is generated per boot, printed to the API log (like Jupyter), and stops
 * working once setup is applied.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export class SetupToken {
  private value: string | null = null;

  issue(): string {
    this.value = randomBytes(24).toString('base64url');
    return this.value;
  }

  revoke(): void {
    this.value = null;
  }

  get active(): boolean {
    return this.value !== null;
  }

  /** Test seam: the token is otherwise only visible in the log. */
  peek(): string | null {
    return this.value;
  }

  verify(header: string | undefined): boolean {
    if (!this.value || !header) return false;
    const [scheme, token] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'setup' || !token) return false;
    const expected = Buffer.from(this.value);
    const received = Buffer.from(token);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}
