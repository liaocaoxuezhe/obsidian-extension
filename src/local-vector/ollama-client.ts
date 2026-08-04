export interface OllamaClientOptions {
  host: string;
  timeoutMs: number;
}

export interface OllamaModelSummary {
  name: string;
  size?: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export class OllamaClient {
  private host: string;
  private timeoutMs: number;

  constructor(options: OllamaClientOptions) {
    this.host = (options.host || "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<OllamaModelSummary[]> {
    const json = await this.requestJson("GET", "/api/tags");
    return Array.isArray(json.models) ? json.models : [];
  }

  async showModel(model: string): Promise<unknown> {
    return this.requestJson("POST", "/api/show", { model });
  }

  async pullModel(
    model: string,
    onProgress?: (progress: OllamaPullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.consumeResponse("POST", "/api/pull", { model, stream: true }, signal, async (response) => {
      if (!response.body) throw new Error("Ollama pull response did not include a stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const publish = (line: string) => {
        const value = line.trim();
        if (!value) return;
        onProgress?.(JSON.parse(value) as OllamaPullProgress);
      };
      while (true) {
        const {done, value} = await reader.read();
        buffer += decoder.decode(value, {stream: !done});
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          publish(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
        if (done) break;
      }
      publish(buffer);
    });
  }

  async generate(input: { model: string; prompt: string; options?: Record<string, unknown> }): Promise<string> {
    const json = await this.requestJson("POST", "/api/generate", {
      model: input.model,
      prompt: input.prompt,
      stream: false,
      options: input.options ?? { temperature: 0.2 },
    });
    return String(json.response || "").trim();
  }

  private async requestJson(method: string, path: string, body?: unknown): Promise<any> {
    return this.consumeResponse(method, path, body, undefined, (response) => response.json());
  }

  private async consumeResponse<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.host}${path}`, {
        method,
        signal: controller.signal,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        throw new Error(`Ollama ${method} ${path} failed: HTTP ${response.status}`);
      }
      return await consume(response);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
