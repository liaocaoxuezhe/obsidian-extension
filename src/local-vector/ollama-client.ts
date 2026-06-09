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

  async pullModel(model: string, onProgress?: (progress: OllamaPullProgress) => void): Promise<void> {
    const response = await this.request("POST", "/api/pull", { model, stream: true });
    const text = await response.text();
    for (const line of text.split(/\n+/).filter(Boolean)) {
      const event = JSON.parse(line) as OllamaPullProgress;
      onProgress?.(event);
    }
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
    const response = await this.request(method, path, body);
    return response.json();
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
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
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}
