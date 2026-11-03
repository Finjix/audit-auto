import type { Gateway } from './config.ts';
import { Blocked, messageOf, redact } from './errors.ts';

/*
 * Gemini through the internal AI gateway, over its REST API with plain fetch (one endpoint is all it takes, and the Gen AI SDK was most
 * of the bundle): generateContent under /v1/models, the key as x-goog-api-key. The gateway has no Files API, so media travels inline.
 * Every call here asks for one JSON answer in JSON mode, its shape described in the prompt. Not with a response schema: held to one, gemini-3.8-flash
 * got stuck repeating itself inside a long Chinese string and dropped most of the answer (tried 2026-11-02; the gateway also refuses
 * maxItems in a schema), while JSON mode gave the whole answer. So callers read the answer leniently. Safety filters are off: what is
 * reviewed is exactly the material that may break the rules (blood, gambling machines, revealing clothes), and a filtered answer would
 * hide the very problem.
 */

/** The parts of the Gemini API's Part this plugin sends. */
export interface Part { text?: string; inlineData?: { mimeType: string; data: string }; videoMetadata?: { fps: number } }
export type MediaResolution = 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH';
/** The fields of a generateContent response read here. */
export interface GenerateContentResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** maxOutputTokens bounds an answer that runs away. */
export interface JsonRequest { system: string; parts: Part[]; mediaResolution?: MediaResolution; maxOutputTokens?: number }
export interface Usage { input: number; output: number; thoughts: number }
export interface JsonReply { data: unknown; usage: Usage; ms: number; attempts: number }
/** What the plugin needs from a model: one answer, as JSON. Tests stand in for it. */
export interface Model { name: string; json(request: JsonRequest): Promise<JsonReply> }

/** An answer that came back unusable (cut off, not JSON, no candidate): asking again usually helps. */
class InvalidAnswer extends Error {}
/** The gateway answered with an HTTP error; message is the gateway's own. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** The gateway is down, busy or silent right now: the same request may well go through later (401, 400, a filtered answer will not). */
export class GatewayDown extends Blocked {}
/** The gateway refuses every request as it is set up now (the key, the model's name): nothing in this request is at fault. */
export class GatewayRefused extends Blocked {}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed/i;
/** No answer within the timeout: asked again, it would only make the user wait as long once more. */
const SILENT = /abort|time ?out|timed out|ETIMEDOUT|UND_ERR_.*TIMEOUT/i;
const FILTERED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);
const SAFETY_OFF = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map(category => ({ category, threshold: 'OFF' }));

/** Test seams: the waits between attempts, and the fetch the calls go out with. */
export interface ModelOptions { delays?: number[]; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; fetch?: typeof fetch }

export function gatewayModel(gateway: Gateway, options: ModelOptions = {}): Model {
  const url = `${gateway.baseUrl}/${gateway.apiVersion}/models/${encodeURIComponent(gateway.model)}:generateContent`;
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const delays = options.delays ?? [5_000, 20_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  return {
    name: gateway.model,
    async json(request) {
      const started = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await call(send, url, gateway.key, timeoutMs, {
            contents: [{ role: 'user', parts: request.parts }],
            systemInstruction: { parts: [{ text: request.system }] },
            generationConfig: {
              thinkingConfig: { thinkingLevel: gateway.thinkingLevel },
              ...(request.mediaResolution ? { mediaResolution: request.mediaResolution } : {}),
              ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
              responseMimeType: 'application/json',
            },
            safetySettings: SAFETY_OFF,
          });
          return { data: answerOf(response), usage: usageOf(response), ms: Date.now() - started, attempts: attempt };
        } catch (error) {
          if (error instanceof Blocked) throw error;
          if (!retryable(error) || attempt > delays.length) throw explain(error, gateway);
          await sleep(delays[attempt - 1]!);
        }
      }
    },
  };
}

/** One generateContent call; the body is read within the same timeout, since a large answer can be slow to arrive. */
async function call(send: typeof fetch, url: string, key: string, timeoutMs: number, body: unknown): Promise<GenerateContentResponse> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* not JSON: the text as it is */ }
    throw new HttpError(response.status, message || response.statusText);
  }
  try { return JSON.parse(text) as GenerateContentResponse; } catch { throw new InvalidAnswer('the reply is not JSON'); }
}

/** The JSON of an answer; a filtered one is a refusal the user is told about, a broken one is asked for again. */
export function answerOf(response: GenerateContentResponse): unknown {
  const block = response.promptFeedback?.blockReason;
  if (block) throw new Blocked(`AI 的安全策略拦下了这次请求（${block}）：这类内容大概率过不了审，请人工检查`);
  const candidate = response.candidates?.[0];
  if (!candidate) throw new InvalidAnswer('the answer has no candidate');
  const finish = String(candidate.finishReason ?? '');
  if (FILTERED.has(finish)) throw new Blocked(`AI 的安全策略拦下了这次回答（${finish}）：这类内容大概率过不了审，请人工检查`);
  if (finish === 'MAX_TOKENS') throw new InvalidAnswer('the answer was cut off');
  const text = (candidate.content?.parts ?? []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('').trim();
  // JSON mode answers bare JSON; a fenced block is taken too.
  const bare = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)?.[1] ?? text;
  try { return JSON.parse(bare); } catch { throw new InvalidAnswer('the answer is not JSON'); }
}

const usageOf = (response: GenerateContentResponse): Usage => ({
  input: response.usageMetadata?.promptTokenCount ?? 0,
  output: response.usageMetadata?.candidatesTokenCount ?? 0,
  thoughts: response.usageMetadata?.thoughtsTokenCount ?? 0,
});

function retryable(error: unknown): boolean {
  if (error instanceof InvalidAnswer) return true;
  if (error instanceof HttpError) return RETRY_STATUS.has(error.status);
  const cause = (error as { cause?: unknown })?.cause;
  return NETWORK.test(`${messageOf(error)} ${cause ? messageOf(cause) : ''} ${(cause as { code?: string })?.code ?? ''}`);
}

/** A failure the user (or the administrator) can act on, without the key. */
function explain(error: unknown, gateway: Gateway): Blocked {
  if (error instanceof InvalidAnswer) return new Blocked('AI 没有给出完整的结果，请再试一次');
  if (error instanceof HttpError) {
    const detail = redact(messageOf(error), [gateway.key]).slice(0, 300);
    switch (true) {
      case error.status === 401 || error.status === 403: return new GatewayRefused(`AI 网关不接受这个 key（HTTP ${error.status}），请联系管理员`);
      case error.status === 404: return new GatewayRefused(`AI 网关上找不到模型 ${gateway.model}（HTTP 404），请联系管理员`);
      case error.status === 408: return new GatewayDown('AI 网关超时（HTTP 408），稍后再试');
      case error.status === 413: return new Blocked('文件太大，AI 网关拒收（HTTP 413）：请压缩后再发');
      case error.status === 429: return new GatewayDown('AI 网关正在限流（HTTP 429），过几分钟再试');
      case error.status >= 500: return new GatewayDown(`AI 网关暂时不可用（HTTP ${error.status}），稍后再试`);
      default: return new Blocked(`AI 网关拒绝了这次请求（HTTP ${error.status}）：${detail}`);
    }
  }
  if (SILENT.test(`${messageOf(error)} ${messageOf((error as { cause?: unknown })?.cause ?? '')}`)) return new GatewayDown('AI 网关 10 分钟没有回应，稍后再试（视频很大的话先压缩再发）');
  if (retryable(error)) return new GatewayDown('连不上 AI 网关，稍后再试');
  return new Blocked(`调用 AI 网关失败：${redact(messageOf(error), [gateway.key]).slice(0, 300)}`);
}
