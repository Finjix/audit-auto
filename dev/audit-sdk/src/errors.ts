/**
 * A refusal: the command cannot do what was asked, for a reason the user can be told as it is (in Chinese, like everything the user
 * reads). The command line prints it as {"status":"blocked","reason":…} and exits with 2.
 */
export class Blocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Blocked';
  }
}

export function need(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Blocked(reason);
}

/** Removes credentials from text that is about to leave the process (stdout, the host's logs). */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:x-goog-api-key|api[_-]?key|app_secret|tenant_access_token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]');
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  return out;
}

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
