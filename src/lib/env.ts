import { SignJWT } from "jose";

import { appConfig } from "../config/app.js";
import { getSupportedModules } from "../config/module-loader.js";
import { getSupportedModule } from "../config/services.js";
import {
  targetEnvironmentSchema,
  type TargetEnvironment
} from "./target-environment.js";

type AuthMode = "jwt" | "apikey" | "bearer" | "none";
type CachedToken = {
  value: string;
  expiresAt: number;
};

const TOKEN_REFRESH_BUFFER_MS = 30_000;
const cachedJwtTokens = new Map<string, CachedToken>();

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getFirstDefinedEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = optionalEnv(name);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function getAuthMode(moduleSlug?: string): AuthMode {
  return getSupportedModule(moduleSlug).auth.mode;
}

function resolveApiBaseUrl(
  moduleSlug: string | undefined,
  targetEnvironment: TargetEnvironment
): string {
  const moduleDefinition = getSupportedModule(moduleSlug);
  return moduleDefinition.environments[targetEnvironment].baseUrl;
}

async function generateJwtToken(
  moduleSlug?: string,
  targetEnvironment?: TargetEnvironment
): Promise<string> {
  const moduleDefinition = getSupportedModule(moduleSlug);

  const envSpecificVar =
    targetEnvironment && moduleDefinition.auth.secretEnvVarByEnvironment?.[targetEnvironment];

  const secretNames: string[] = [];
  if (envSpecificVar) {
    secretNames.push(envSpecificVar);
  }
  if (moduleDefinition.auth.secretEnvVar) {
    secretNames.push(moduleDefinition.auth.secretEnvVar);
  }

  const secret =
    getFirstDefinedEnv(...secretNames) ?? requiredEnv(moduleDefinition.auth.secretEnvVar ?? "JWT_SECRET");
  const jwtConfig = moduleDefinition.auth.jwt;
  if (!jwtConfig) {
    throw new Error(`Module ${moduleDefinition.slug} is configured for JWT auth but is missing jwt settings.`);
  }
  const subject = jwtConfig.subject ?? jwtConfig.email;

  let token = new SignJWT({
    email: jwtConfig.email
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "JWT"
    })
    .setIssuedAt()
    .setSubject(subject)
    .setExpirationTime(`${jwtConfig.expiresInSeconds}s`);

  if (jwtConfig.issuer) {
    token = token.setIssuer(jwtConfig.issuer);
  }

  if (jwtConfig.audience) {
    token = token.setAudience(jwtConfig.audience);
  }

  return token.sign(new TextEncoder().encode(secret));
}

async function getCachedJwtToken(
  moduleSlug?: string,
  targetEnvironment?: TargetEnvironment
): Promise<string> {
  const moduleDefinition = getSupportedModule(moduleSlug);
  const cacheKey = targetEnvironment
    ? `${moduleDefinition.slug}:${targetEnvironment}`
    : moduleDefinition.slug;
  const cachedJwtToken = cachedJwtTokens.get(cacheKey);
  const expiresAt =
    Date.now() + (moduleDefinition.auth.jwt?.expiresInSeconds ?? 300) * 1_000;

  if (
    cachedJwtToken &&
    Date.now() < cachedJwtToken.expiresAt - TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedJwtToken.value;
  }

  const value = await generateJwtToken(moduleDefinition.slug, targetEnvironment);
  cachedJwtTokens.set(cacheKey, {
    value,
    expiresAt
  });
  return value;
}

export interface EnvConfig {
  apiTimeoutMs: number;
  authMode: AuthMode;
  defaultTargetEnvironment: TargetEnvironment;
  jwtEmail?: string;
  getAuthHeaders(targetEnvironment?: TargetEnvironment): Promise<Record<string, string>>;
  getApiBearerToken(targetEnvironment?: TargetEnvironment): Promise<string>;
  resolveApiBaseUrl(targetEnvironment: TargetEnvironment): string;
}

export function getEnv(moduleSlug?: string): EnvConfig {
  const moduleDefinition = getSupportedModule(moduleSlug);

  return {
    apiTimeoutMs: appConfig.requests.timeoutMs,
    authMode: getAuthMode(moduleSlug),
    defaultTargetEnvironment: moduleDefinition.defaultTargetEnvironment,
    jwtEmail: moduleDefinition.auth.jwt?.email,
    async getAuthHeaders(targetEnvironment?) {
      switch (moduleDefinition.auth.mode) {
        case "jwt": {
          const token = await getCachedJwtToken(moduleDefinition.slug, targetEnvironment);
          return { authorization: `Bearer ${token}` };
        }
        case "apikey": {
          const apikey = moduleDefinition.auth.apikey;
          if (!apikey) return {};
          const value = optionalEnv(apikey.valueEnvVar);
          return value ? { [apikey.headerName]: value } : {};
        }
        case "bearer": {
          const bearer = moduleDefinition.auth.bearer;
          if (!bearer) return {};
          const token = optionalEnv(bearer.tokenEnvVar);
          return token ? { authorization: `Bearer ${token}` } : {};
        }
        case "none":
        default:
          return {};
      }
    },
    async getApiBearerToken(targetEnvironment?) {
      return getCachedJwtToken(moduleDefinition.slug, targetEnvironment);
    },
    resolveApiBaseUrl(targetEnvironment) {
      return resolveApiBaseUrl(
        moduleDefinition.slug,
        targetEnvironmentSchema.parse(targetEnvironment)
      );
    }
  };
}

function isAuthConfigured(mod: import("../config/module-types.js").ModuleDefinition): boolean {
  switch (mod.auth.mode) {
    case "jwt": {
      const names = [mod.auth.secretEnvVar].filter(Boolean) as string[];
      return names.length > 0 && Boolean(getFirstDefinedEnv(...names));
    }
    case "apikey":
      return Boolean(mod.auth.apikey?.valueEnvVar && optionalEnv(mod.auth.apikey.valueEnvVar));
    case "bearer":
      return Boolean(mod.auth.bearer?.tokenEnvVar && optionalEnv(mod.auth.bearer.tokenEnvVar));
    case "none":
      return true;
    default:
      return false;
  }
}

export interface PublicRuntimeConfig {
  defaultTargetEnvironment: TargetEnvironment;
  availableTargetEnvironments: TargetEnvironment[];
  authMode: AuthMode | "unconfigured";
  jwtEmail: string | null;
  serviceName: string;
  tokenCacheStrategy: "memory";
  targetBaseUrls: Record<TargetEnvironment, string>;
  modules: readonly import("../config/module-types.js").ModuleDefinition[];
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  const defaultModule = getSupportedModule();

  return {
    defaultTargetEnvironment: defaultModule.defaultTargetEnvironment,
    availableTargetEnvironments: [...targetEnvironmentSchema.options],
    authMode: isAuthConfigured(defaultModule) ? defaultModule.auth.mode : "unconfigured",
    jwtEmail: defaultModule.auth.jwt?.email ?? null,
    serviceName: defaultModule.serviceName,
    tokenCacheStrategy: "memory",
    targetBaseUrls: {
      staging: defaultModule.environments.staging.baseUrl,
      prod: defaultModule.environments.prod.baseUrl
    },
    modules: getSupportedModules()
  };
}
