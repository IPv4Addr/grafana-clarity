import { LiveChannelScope, isLiveChannelMessageEvent, isLiveChannelStatusEvent } from '@grafana/data';
import { getBackendSrv, getGrafanaLiveSrv } from '@grafana/runtime';
import { SYSTEM, context } from './prompt';
import { TOOLS, ToolOutcome, executeTool } from './tools';

// The model is reached through Grafana's LLM app (grafana-llm-app). The admin picks the provider there (OpenAI,
// Anthropic, Azure OpenAI, or any OpenAI-compatible API such as Ollama or OpenRouter), with its key and models, and
// Grafana makes the calls. Requests and answers use the Chat Completions format whatever the provider.

/** Plugin id of Grafana's LLM app. */
export const LLM_APP = 'grafana-llm-app';
const CHAT_PATH = 'llm/v1/chat/completions';

/** Most model calls per question. The user can Continue after that. */
export const MAX_STEPS = 25;

/** A message of the conversation, in the Chat Completions format. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** A tool call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** The parsed arguments, or an Error when they were not valid JSON (runTool reports it as the result). */
  input: unknown;
}

/** Token usage of one model call. */
export interface Usage {
  model: string;
  input: number; // all prompt tokens, cached ones included
  output: number;
  cached: number;
}

/** Callbacks through which a run streams into the chat. */
export interface AgentUI {
  usage(u: Usage): void; // once per model call
  text(delta: string): void;
  /** `newBlock`: first delta of a new progress note (the model's reasoning, where the provider streams it) */
  progress(delta: string, newBlock: boolean): void;
  toolCall(call: ToolCall): void;
  toolResult(call: ToolCall, outcome: ToolOutcome | Error): void;
}

/** Why a run ended without a normal answer. `resumable`: Continue can pick up from the history (not after a refusal). */
export interface Notice {
  text: string;
  resumable: boolean;
}
/** The model hit its output limit. */
export const CUT_OFF: Notice = { text: 'The answer was cut off (output limit reached).', resumable: true };

/** Whether the LLM app can be used; `error` says what the admin has to do. */
export interface LLMStatus {
  ok: boolean;
  error?: string;
}

const get = (path: string) =>
  getBackendSrv().get(`/api/plugins/${LLM_APP}/${path}`, undefined, undefined, { showErrorAlert: false });

const checkStatus = async (): Promise<LLMStatus> => {
  try {
    if (!(await get('settings')).enabled) {
      return { ok: false, error: 'The Grafana LLM app is not enabled.' };
    }
  } catch {
    return { ok: false, error: 'The Grafana LLM app is not installed.' };
  }
  try {
    // the LLM app tests its provider here and caches the result once it works
    const provider = (await get('health')).details?.llmProvider;
    return provider?.ok ? { ok: true } : { ok: false, error: provider?.error || 'No LLM provider is set up yet.' };
  } catch (e: any) {
    return { ok: false, error: `The Grafana LLM app health check failed: ${e?.data?.message ?? String(e)}` };
  }
};

let status: Promise<LLMStatus> | undefined;
/** Checks the LLM app once per page load (settings changes need a reload, like other plugin settings). */
export const llmStatus = () => (status ??= checkStatus());

/** A chunk of the LLM app's stream: a Chat Completions chunk, its `done` marker, or an error. */
interface Chunk {
  model?: string;
  choices?: Array<{
    delta: {
      done?: boolean;
      content?: string;
      reasoning_content?: string;
      refusal?: string;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: string;
}

interface Completion {
  content: string;
  refusal: string;
  toolCalls: NonNullable<Message['tool_calls']>;
  finish?: string;
}

const stopped = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });

/**
 * One model call over the LLM app's Grafana Live stream, the channel that @grafana/llm's streamChatCompletions
 * uses. Read directly because that helper drops the LLM app's `{error}` messages (the run would hang instead of
 * failing) and trips over the usage chunk that follows a tool call.
 */
const complete = (request: object, ui: AgentUI, signal: AbortSignal) =>
  new Promise<Completion>((resolve, reject) => {
    if (signal.aborted) {
      return reject(stopped());
    }
    const out: Completion = { content: '', refusal: '', toolCalls: [] };
    let reasoning = false;
    let model = '';
    let finished = false;
    let subscription: { unsubscribe(): void } | undefined;
    const end = (error?: unknown) => {
      finished = true;
      subscription?.unsubscribe();
      signal.removeEventListener('abort', abort);
      return error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(out);
    };
    const abort = () => end(stopped());
    subscription = getGrafanaLiveSrv()
      .getStream<Chunk>({
        scope: LiveChannelScope.Plugin,
        stream: LLM_APP,
        // a new channel per call: the request travels as the subscription's data
        path: `${CHAT_PATH}/${Date.now()}-${Math.random().toString(36).slice(2)}`,
        data: request,
      })
      .subscribe({
        next: (event) => {
          if (isLiveChannelStatusEvent(event) && event.error) {
            return end(event.error);
          }
          if (!isLiveChannelMessageEvent(event)) {
            return;
          }
          const chunk = event.message;
          if (chunk.error) {
            return end(chunk.error);
          }
          model = chunk.model || model;
          if (chunk.usage) {
            // asked for with stream_options; arrives after the last choice, with an empty choices list
            const u = chunk.usage;
            ui.usage({
              model,
              input: u.prompt_tokens,
              output: u.completion_tokens,
              cached: u.prompt_tokens_details?.cached_tokens ?? 0,
            });
          }
          const choice = chunk.choices?.[0];
          if (!choice) {
            return;
          }
          const { delta } = choice;
          if (delta.done) {
            return end();
          }
          out.finish = choice.finish_reason || out.finish;
          if (delta.content) {
            out.content += delta.content;
            ui.text(delta.content);
          }
          if (delta.reasoning_content) {
            ui.progress(delta.reasoning_content, !reasoning);
            reasoning = true;
          }
          out.refusal += delta.refusal ?? '';
          // a call's id and name come in its first piece, the arguments in pieces after it
          for (const piece of delta.tool_calls ?? []) {
            const i = piece.index ?? (piece.id ? out.toolCalls.length : out.toolCalls.length - 1);
            const call = (out.toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
            call.id ||= piece.id ?? '';
            call.function.name ||= piece.function?.name ?? '';
            call.function.arguments += piece.function?.arguments ?? '';
          }
        },
        error: (e) => end(e),
        complete: () => end(),
      });
    if (finished) {
      subscription.unsubscribe(); // it ended while subscribing
    } else {
      signal.addEventListener('abort', abort);
    }
  });

const parseArgs = (json: string): unknown => {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return new Error(`The tool arguments were not valid JSON: ${json.slice(0, 200)}`);
  }
};

/** Runs a tool call, reports the outcome to the UI and returns what goes back to the model. Never throws. */
export const runTool = async (call: ToolCall, ui: AgentUI, signal: AbortSignal) => {
  try {
    if (call.input instanceof Error) {
      throw call.input; // arguments that were not valid JSON
    }
    const out = await executeTool(call.name, call.input, signal);
    ui.toolResult(call, out);
    return { content: out.forModel, isError: false };
  } catch (e: any) {
    // getBackendSrv rejects with a plain {status, data: {message}} object, not an Error
    const err = new Error(
      signal.aborted
        ? 'Stopped by the user before this finished.'
        : e instanceof Error
          ? e.message
          : (e?.data?.message ?? e?.statusText ?? String(e))
    );
    ui.toolResult(call, err);
    return { content: err.message, isError: true };
  }
};

/**
 * Runs one question to completion: model calls and tool calls until the model answers, appending to `history`.
 * Resolves with a notice when the model declined or was cut off; rejects on errors, the step limit and abort
 * (see friendlyError). Everything that finished stays in the history, so a new question or Continue picks up there.
 */
export const ask = async (
  history: Message[],
  question: string,
  ui: AgentUI,
  signal: AbortSignal
): Promise<Notice | undefined> => {
  const mark = history.length;
  if (!history.length) {
    history.push({ role: 'system', content: SYSTEM });
  }
  history.push({ role: 'user', content: `<context>\n${context()}\n</context>\n\n${question}` });

  for (let step = 0; step < MAX_STEPS; step++) {
    const { content, refusal, toolCalls, finish } = await complete(
      // "large": the LLM app maps it to the provider's bigger model
      { model: 'large', messages: history, tools: TOOLS, stream_options: { include_usage: true } },
      ui,
      signal
    );
    if (refusal || finish === 'content_filter') {
      history.length = mark; // don't send the declined question again with every follow-up
      return { text: refusal || 'The model declined this request (content filter).', resumable: false };
    }
    if (finish === 'length' && toolCalls.length) {
      return CUT_OFF; // the arguments may be truncated: never run them
    }
    if (content || toolCalls.length) {
      // an empty assistant message (a model cut off while reasoning) gets every later request rejected
      history.push({ role: 'assistant', content: content || null, ...(toolCalls.length && { tool_calls: toolCalls }) });
    }
    if (!toolCalls.length) {
      return finish === 'length' ? CUT_OFF : undefined;
    }
    const calls: ToolCall[] = toolCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      input: parseArgs(c.function.arguments),
    }));
    calls.forEach(ui.toolCall);
    const results = await Promise.all(calls.map((c) => runTool(c, ui, signal)));
    // every tool call needs a tool message, or the next request is rejected
    results.forEach((r, n) => history.push({ role: 'tool', tool_call_id: calls[n].id, content: r.content }));
  }
  throw new Error(
    `Stopped after ${MAX_STEPS} steps without a final answer. Ask a narrower question or say "continue".`
  );
};

/**
 * The message the chat shows for an error from `ask`. The LLM app passes the provider's error on as text, e.g.
 * "error, status code: 401, status: 401 Unauthorized, message: invalid x-api-key".
 */
export const friendlyError = (e: unknown): string => {
  if ((e as Error)?.name === 'AbortError') {
    return 'Stopped.';
  }
  const text = e instanceof Error ? e.message : String(e);
  const status = Number(text.match(/status code: (\d{3})/)?.[1]);
  // the provider's own words without the Go client's wording around them
  const detail =
    text.match(/message: ([\s\S]*)$/)?.[1] ??
    text.match(/status: \d{3} ([^,]*)/)?.[1] ??
    text.replace(/^(establish chat completions stream: )?error, /, '');
  switch (status) {
    case 401:
    case 403:
      return `The model provider rejected the request (${status}): ${detail}. Check the API key in the Grafana LLM app.`;
    case 404:
      return `Model not found (404): ${detail}. Check the models set in the Grafana LLM app.`;
    case 429:
      return 'The model provider is rate limiting requests. Try again in a moment.';
  }
  if (/no such host|connection refused|dial tcp|deadline exceeded|timeout/i.test(text)) {
    return `The Grafana LLM app could not reach the model provider: ${text}`;
  }
  return status ? `Model API error ${status}: ${detail}` : detail;
};
