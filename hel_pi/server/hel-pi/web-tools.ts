import type { WorkspaceModelConfig } from '../runtime/model-config';
import { readPageTool, remotePageTool, type RemoteExtractor } from './page';
import { searchTool, type SearchProvider } from './search';

export type WebToolOptions = {
  web_search?: 'off' | SearchProvider;
  web_extract?: 'off' | 'built-in' | RemoteExtractor;
  read_web_pages?: boolean;
  brave_api_key?: string;
  exa_api_key?: string;
  tavily_api_key?: string;
  deepseek_api_key?: string;
  firecrawl_api_key?: string;
};

export function createWebTools(options: WebToolOptions, config: WorkspaceModelConfig) {
  const tools = [];
  const search = options.web_search ?? 'off';
  if (search !== 'off') tools.push(searchTool(search, search === 'chatgpt' ? undefined : options[`${search}_api_key`]?.trim(), config));
  // A saved read_web_pages: true continues to mean local extraction only.
  const extract = options.web_extract ?? (options.read_web_pages === true ? 'built-in' : 'off');
  if (extract === 'built-in') tools.push(readPageTool);
  else if (extract !== 'off') tools.push(remotePageTool(extract, options[`${extract}_api_key`]?.trim()));
  return tools;
}
