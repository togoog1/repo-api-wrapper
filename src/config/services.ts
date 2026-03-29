import type { ModuleEndpointDefinition, ModuleDefinition } from "./module-types.js";
import { getSupportedModules } from "./module-loader.js";

export type { ModuleDefinition };

export function getSupportedModule(moduleSlug?: string): ModuleDefinition {
  const supportedModules = getSupportedModules();

  if (moduleSlug) {
    const match = supportedModules.find((m) => m.slug === moduleSlug);

    if (!match) {
      throw new Error(`Module not found: ${moduleSlug}`);
    }

    return match;
  }

  const defaultModule = supportedModules[0];

  if (!defaultModule) {
    throw new Error("No supported modules have been configured.");
  }

  return defaultModule;
}

export function getModuleEndpoint(
  moduleDefinition: ModuleDefinition,
  endpointSlug?: string
): ModuleEndpointDefinition {
  if (endpointSlug) {
    const match = moduleDefinition.endpoints.find((endpoint) => endpoint.slug === endpointSlug);

    if (!match) {
      throw new Error(`Endpoint not found: ${endpointSlug}`);
    }

    return match;
  }

  const defaultEndpoint = moduleDefinition.endpoints[0];

  if (!defaultEndpoint) {
    throw new Error(`Module ${moduleDefinition.slug} has no configured endpoints.`);
  }

  return defaultEndpoint;
}
