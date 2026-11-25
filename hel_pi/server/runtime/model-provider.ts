import {
  createProvider,
  type Api,
  type Model,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { ModelConfig, ProviderConfig } from "../config/model-schema";

export function configureProvider(
  id: string,
  config: ProviderConfig,
  builtin: Provider | undefined,
  env: Record<string, string | undefined>,
  storedKey?: string,
): Provider {
  const location = `models.json providers.${id}`;
  const resolveHeaders = (values?: Record<string, string>) =>
    values &&
    Object.fromEntries(
      Object.entries(values).map(([key, name]) => {
        const value = env[name];
        if (!value)
          throw new Error(
            `Missing environment variable ${name}, referenced by ${location}.headersEnv`,
          );
        return [key, value];
      }),
    );
  const catalog = new Map(
    (builtin?.getModels() ?? []).map((model) => [model.id, model]),
  );
  const requests = new Map<string, SimpleStreamOptions>();
  const decorate = (
    modelId: string,
    original: Model<Api> | undefined,
    value: ModelConfig,
  ): Model<Api> => {
    const { request: requestOptions, headersEnv, ...fields } = value;
    const api = fields.api ?? config.api ?? original?.api;
    const baseUrl = fields.baseUrl ?? config.baseUrl ?? original?.baseUrl;
    const contextWindow = fields.contextWindow ?? original?.contextWindow;
    const maxTokens = fields.maxTokens ?? original?.maxTokens;
    if (!api || (!baseUrl && !original) || !contextWindow || !maxTokens)
      throw new Error(
        `${location} model ${modelId}: api, baseUrl, contextWindow and maxTokens are required for new models`,
      );
    if (!original || fields.baseUrl || config.baseUrl) {
      try {
        const url = new URL(baseUrl!);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error(
          `${location} model ${modelId}: baseUrl must be an HTTP or HTTPS URL`,
        );
      }
    }
    if (requestOptions?.maxTokens && requestOptions.maxTokens > maxTokens)
      throw new Error(
        `${location} model ${modelId}: request.maxTokens exceeds the model maxTokens`,
      );
    requests.set(modelId, { ...config.request, ...requestOptions });
    return {
      name: modelId,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...original,
      ...fields,
      id: modelId,
      provider: id,
      api: api as Api,
      baseUrl,
      contextWindow,
      maxTokens,
      headers: {
        ...original?.headers,
        ...resolveHeaders(config.headersEnv),
        ...resolveHeaders(headersEnv),
      },
      compat: { ...original?.compat, ...config.compat, ...fields.compat },
      thinkingLevelMap: {
        ...original?.thinkingLevelMap,
        ...fields.thinkingLevelMap,
      },
      samplingParams: { ...original?.samplingParams, ...fields.samplingParams },
    } as Model<Api>;
  };
  for (const [modelId, model] of catalog)
    catalog.set(modelId, decorate(modelId, model, {}));
  const declared = new Set<string>();
  for (const { id: modelId, ...value } of config.models ?? []) {
    if (declared.has(modelId))
      throw new Error(`${location}: duplicate model ${modelId}`);
    declared.add(modelId);
    catalog.set(modelId, decorate(modelId, catalog.get(modelId), value));
  }
  for (const [modelId, value] of Object.entries(config.modelOverrides ?? {})) {
    if (!catalog.has(modelId))
      throw new Error(`${location}.modelOverrides: unknown model ${modelId}`);
    const inherited = requests.get(modelId);
    catalog.set(
      modelId,
      decorate(modelId, catalog.get(modelId), {
        ...value,
        request: { ...inherited, ...value.request },
      }),
    );
  }
  if (!catalog.size) throw new Error(`${location}: no models configured`);
  for (const model of catalog.values()) {
    const max = requests.get(model.id)?.maxTokens;
    if (max && max > model.maxTokens)
      throw new Error(
        `${location} model ${model.id}: request.maxTokens exceeds the model maxTokens`,
      );
  }
  if (config.keyless && config.apiKey)
    throw new Error(`${location}: choose either keyless or apiKey, not both`);
  const auth = config.keyless
    ? {
        apiKey: { name: "Local endpoint", resolve: async () => ({ auth: {} }) },
      }
    : storedKey
      ? {
          apiKey: {
            name: `${id} stored API key`,
            resolve: async () => ({ auth: { apiKey: storedKey } }),
          },
        }
      : config.apiKey
        ? {
            apiKey: {
              name: `${id} API key`,
              resolve: async () => ({ auth: { apiKey: config.apiKey } }),
            },
          }
        : { apiKey: { name: `${id} API key`, resolve: async () => undefined } };
  const configuredHeaders = {
    ...builtin?.headers,
    ...resolveHeaders(config.headersEnv),
  };
  let base: Provider;
  if (
    builtin &&
    !config.api &&
    !(config.models ?? []).some(
      (model) =>
        model.api &&
        !builtin.getModels().some((known) => known.api === model.api),
    ) &&
    !Object.values(config.modelOverrides ?? {}).some((model) => model.api)
  ) {
    base = {
      ...builtin,
      name: config.name ?? builtin.name,
      baseUrl: config.baseUrl ?? builtin.baseUrl,
      headers: configuredHeaders,
      auth,
      getModels: () => [...catalog.values()],
      getAllModels: undefined,
      refreshModels: undefined,
    };
  } else {
    const adapters: Record<string, ProviderStreams> = {};
    for (const model of catalog.values()) {
      if (adapters[model.api]) continue;
      switch (model.api) {
        case "openai-completions":
          adapters[model.api] = openAICompletionsApi();
          break;
        case "openai-responses":
          adapters[model.api] = openAIResponsesApi();
          break;
        case "anthropic-messages":
          adapters[model.api] = anthropicMessagesApi();
          break;
        default:
          throw new Error(
            `${location}: custom api ${model.api} is unsupported`,
          );
      }
    }
    base = createProvider({
      id,
      name: config.name,
      baseUrl: config.baseUrl,
      headers: configuredHeaders,
      auth,
      models: [...catalog.values()],
      api: adapters,
    });
  }
  const options = <T extends { maxTokens?: number; temperature?: number }>(
    model: Model<Api>,
    supplied?: T,
  ): T => {
    const defaults = requests.get(model.id);
    // Compaction supplies its own output budget. Respect that explicit cap.
    const result = { ...defaults, ...supplied };
    if (result.maxTokens !== undefined)
      result.maxTokens = Math.min(result.maxTokens, model.maxTokens);
    return result as T;
  };
  return {
    ...base,
    stream: (model, context, supplied) =>
      base.stream(model, context, options(model, supplied)),
    streamSimple: (model, context, supplied) =>
      base.streamSimple(model, context, options(model, supplied)),
  };
}
