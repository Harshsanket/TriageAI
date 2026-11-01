/**
 * ChatModel adapters (Phase 14, ADR-0028). One interface over local and hosted
 * providers; every adapter maps upstream failures to the 10C taxonomy.
 */
import {
  fetchFailure,
  httpFailure,
  policyBlocked,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  type ChatMessage,
  type EgressCapability,
} from '@triageai/kernel';

export interface ChatModelOptions {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  hosted: boolean;
  contextWindow: number;
  maxOutput: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  headers?: Record<string, string>;
  egress?: EgressCapability;
}

type Raw = Record<string, unknown>;

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
  hosted: boolean,
  egress?: EgressCapability,
): Promise<Raw> {
  let response: Response;
  try {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(120_000),
    };
    if (hosted) {
      if (!egress) {
        throw new Error('an egress client is required for hosted model calls');
      }
      response = await egress.fetch(url, init, { purpose: `chatmodel:${label}` });
    } else {
      // Local runtimes (Ollama, LM Studio) are config-bound loopback/private
      // services; the egress allowlist is for hosted egress only (R9).
      // eslint-disable-next-line no-restricted-syntax
      response = await fetch(url, init);
    }
  } catch (err) {
    throw fetchFailure({ codePrefix: 'chatmodel', label, cause: err });
  }
  const text = await response.text();
  if (!response.ok) {
    throw httpFailure({
      codePrefix: 'chatmodel',
      label,
      status: response.status,
      body: text,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    });
  }
  try {
    return JSON.parse(text) as Raw;
  } catch {
    throw fetchFailure({
      codePrefix: 'chatmodel',
      label,
      cause: new Error('provider returned invalid JSON'),
    });
  }
}

function toStop(reason: unknown): ChatResponse['stopReason'] {
  const value = String(reason ?? 'stop');
  if (value === 'length' || value === 'max_tokens') return 'max_tokens';
  if (value === 'tool_calls' || value === 'tool_use') return 'tool_use';
  if (value === 'content_filter' || value === 'safety') return 'content_filter';
  if (value === 'error') return 'error';
  return 'end';
}

/** OpenAI-compatible: OpenAI, LM Studio, vLLM, OpenRouter, Groq, … */
export class OpenAiCompatibleChatModel implements ChatModel {
  constructor(protected readonly options: ChatModelOptions) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.2,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    const raw = await postJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
      body,
      this.options.headers ??
        (this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      request.signal,
      `${this.options.provider} chat`,
      this.options.hosted,
      this.options.egress,
    );
    const choices = (raw.choices as Array<Raw> | undefined) ?? [];
    const choice = choices[0] ?? {};
    const message = (choice.message as Raw | undefined) ?? {};
    const toolCalls = ((message.tool_calls as Array<Raw> | undefined) ?? []).map((call) => {
      const fn = (call.function as Raw | undefined) ?? {};
      return {
        id: String(call.id ?? ''),
        name: String(fn.name ?? ''),
        arguments: fn.arguments ? safeJson(fn.arguments) : {},
      };
    });
    const usage = (raw.usage as Raw | undefined) ?? {};
    return {
      message: {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : '',
      },
      toolCalls,
      usage: {
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        cachedTokens:
          Number(
            (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
              0,
          ) || undefined,
      },
      stopReason: toStop(choice.finish_reason),
      modelVersion: String(raw.model ?? this.options.model),
    };
  }

  describe() {
    return {
      provider: this.options.provider,
      model: this.options.model,
      hosted: this.options.hosted,
      contextWindow: this.options.contextWindow,
      maxOutput: this.options.maxOutput,
      supportsTools: this.options.supportsTools ?? true,
      supportsStreaming: this.options.supportsStreaming ?? true,
    };
  }
}

/** Ollama native `/api/chat`. */
export class OllamaChatModel implements ChatModel {
  constructor(protected readonly options: ChatModelOptions) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const raw = await postJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/api/chat`,
      {
        model: this.options.model,
        messages: request.messages,
        stream: false,
        options: {
          num_predict: request.maxTokens,
          temperature: request.temperature ?? 0.2,
        },
      },
      this.options.headers ?? {},
      request.signal,
      'ollama chat',
      this.options.hosted,
      this.options.egress,
    );
    const message = (raw.message as Raw | undefined) ?? {};
    return {
      message: {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : '',
      },
      toolCalls: [],
      usage: {
        inputTokens: Number(raw.prompt_eval_count ?? 0),
        outputTokens: Number(raw.eval_count ?? 0),
      },
      stopReason: toStop(raw.done_reason),
      modelVersion: String(raw.model ?? this.options.model),
    };
  }

  describe() {
    return {
      provider: 'ollama',
      model: this.options.model,
      hosted: false,
      contextWindow: this.options.contextWindow,
      maxOutput: this.options.maxOutput,
      supportsTools: false,
      supportsStreaming: true,
    };
  }
}

/** Anthropic Messages API. */
export class AnthropicChatModel implements ChatModel {
  constructor(private readonly options: ChatModelOptions) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));
    const raw = await postJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/v1/messages`,
      {
        model: this.options.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        ...(system ? { system } : {}),
        messages,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      },
      {
        'x-api-key': this.options.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      request.signal,
      'anthropic chat',
      this.options.hosted,
      this.options.egress,
    );
    const content = ((raw.content as Array<Raw> | undefined) ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('');
    const toolCalls = ((raw.content as Array<Raw> | undefined) ?? [])
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: block.input ?? {},
      }));
    const usage = (raw.usage as Raw | undefined) ?? {};
    return {
      message: { role: 'assistant', content },
      toolCalls,
      usage: {
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
      },
      stopReason: toStop(raw.stop_reason),
      modelVersion: String(raw.model ?? this.options.model),
    };
  }

  describe() {
    return {
      provider: 'anthropic',
      model: this.options.model,
      hosted: true,
      contextWindow: this.options.contextWindow,
      maxOutput: this.options.maxOutput,
      supportsTools: true,
      supportsStreaming: true,
    };
  }
}

/** Google Gemini generateContent. */
export class GoogleChatModel implements ChatModel {
  constructor(private readonly options: ChatModelOptions) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const raw = await postJson(
      `${this.options.baseUrl.replace(/\/$/, '')}/v1beta/models/${this.options.model}:generateContent?key=${encodeURIComponent(this.options.apiKey ?? '')}`,
      {
        contents: request.messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
        generationConfig: {
          maxOutputTokens: request.maxTokens,
          temperature: request.temperature ?? 0.2,
        },
      },
      {},
      request.signal,
      'google chat',
      this.options.hosted,
      this.options.egress,
    );
    const candidates = (raw.candidates as Array<Raw> | undefined) ?? [];
    const candidate = candidates[0] ?? {};
    const parts = ((candidate.content as Raw | undefined)?.parts as Array<Raw> | undefined) ?? [];
    const usage = (raw.usageMetadata as Raw | undefined) ?? {};
    return {
      message: {
        role: 'assistant',
        content: parts.map((part) => String(part.text ?? '')).join(''),
      },
      toolCalls: [],
      usage: {
        inputTokens: Number(usage.promptTokenCount ?? 0),
        outputTokens: Number(usage.candidatesTokenCount ?? 0),
        cachedTokens: Number(usage.cachedContentTokenCount ?? 0) || undefined,
      },
      stopReason: toStop(candidate.finishReason),
      modelVersion: String(raw.modelVersion ?? this.options.model),
    };
  }

  describe() {
    return {
      provider: 'google',
      model: this.options.model,
      hosted: true,
      contextWindow: this.options.contextWindow,
      maxOutput: this.options.maxOutput,
      supportsTools: true,
      supportsStreaming: true,
    };
  }
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function buildChatModel(args: {
  adapter: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  maxOutput?: number;
  egress?: EgressCapability;
}): ChatModel {
  const hosted = ['anthropic', 'openai', 'google', 'openai_compatible'].includes(args.adapter);
  const common: ChatModelOptions = {
    provider: args.adapter,
    model: args.model,
    baseUrl: args.baseUrl ?? '',
    apiKey: args.apiKey,
    hosted,
    contextWindow: args.contextWindow ?? 8192,
    maxOutput: args.maxOutput ?? 4096,
    ...(args.egress && hosted ? { egress: args.egress } : {}),
  };
  switch (args.adapter) {
    case 'ollama':
      return new OllamaChatModel({ ...common, baseUrl: args.baseUrl ?? 'http://localhost:11434' });
    case 'lmstudio':
    case 'openai_compatible_local':
      return new OpenAiCompatibleChatModel({
        ...common,
        hosted: false,
        baseUrl: args.baseUrl ?? 'http://localhost:1234/v1',
      });
    case 'openai_compatible':
      return new OpenAiCompatibleChatModel(common);
    case 'openai':
      return new OpenAiCompatibleChatModel({
        ...common,
        hosted: true,
        baseUrl: args.baseUrl ?? 'https://api.openai.com/v1',
      });
    case 'anthropic':
      return new AnthropicChatModel({
        ...common,
        hosted: true,
        baseUrl: args.baseUrl ?? 'https://api.anthropic.com',
      });
    case 'google':
      return new GoogleChatModel({
        ...common,
        hosted: true,
        baseUrl: args.baseUrl ?? 'https://generativelanguage.googleapis.com',
      });
    default:
      throw policyBlocked(`unsupported chat model adapter "${args.adapter}"`);
  }
}

export function assertHostedAllowed(args: {
  adapter: string;
  hosted: { enabled: boolean; allowedProviders: string[] };
}): void {
  const hostedAdapters = new Set(['anthropic', 'openai', 'google', 'openai_compatible']);
  if (!hostedAdapters.has(args.adapter)) return;
  if (!args.hosted.enabled) {
    throw policyBlocked(
      `hosted model adapter "${args.adapter}" is disabled (hosted.enabled=false)`,
    );
  }
  if (!args.hosted.allowedProviders.includes(args.adapter)) {
    throw policyBlocked(`hosted provider "${args.adapter}" is not in hosted.allowedProviders`);
  }
}

export type { ChatRequest, ChatResponse, ChatMessage };
