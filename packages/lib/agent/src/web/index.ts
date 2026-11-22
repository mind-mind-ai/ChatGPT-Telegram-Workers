import type { Tool, ToolRegistry } from '../tools';
import { WEB_TOOL_PERMISSION } from './constants';
import { createWebFetchTool, type WebFetchToolOptions } from './fetch';
import { createWebSearchTool, type WebSearchToolOptions } from './search';

export * from './constants';
export * from './fetch';
export * from './html';
export * from './http';
export * from './search';
export * from './untrusted';
export * from './url';
export * from './util';

export interface WebToolsOptions {
    search?: WebSearchToolOptions;
    fetch?: WebFetchToolOptions;
    /** Permission required by both tools. Defaults to `web`. */
    permission?: string;
}

export function createWebTools(options: WebToolsOptions = {}): Tool[] {
    const permission = options.permission ?? WEB_TOOL_PERMISSION;
    const requiredPermissions = permission ? [permission] : [];

    return [
        createWebSearchTool({
            ...options.search,
            requiredPermissions: options.search?.requiredPermissions ?? requiredPermissions,
        }),
        createWebFetchTool({
            ...options.fetch,
            requiredPermissions: options.fetch?.requiredPermissions ?? requiredPermissions,
        }),
    ];
}

export function registerWebTools(registry: ToolRegistry, options: WebToolsOptions = {}): ToolRegistry {
    registry.registerAll(createWebTools(options));
    return registry;
}
