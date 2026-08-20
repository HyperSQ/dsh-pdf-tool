import "@deepseek-ai/cordis";
import type { SettingsNamespace, SettingsScope } from "@deepseek-ai/dsh-settings";

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: {
      register(definition: unknown): () => void;
    };
    settings: {
      register<T>(
        ns: SettingsNamespace,
        schema: unknown,
        options?: { base?: Partial<T>; applies?: "live" | "restart" },
      ): SettingsScope<T>;
    };
    credentials?: {
      resolve(
        ref: string,
      ): Promise<{ value: string; source?: string } | undefined>;
    };
  }
}
