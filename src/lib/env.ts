import { SignJWT } from "jose";

import { appConfig } from "../config/app.js";
import { getSupportedModules } from "../config/module-loader.js";
import { getSupportedModule } from "../config/services.js";
import {
  targetEnvironmentSchema,
  type TargetEnvironment
} from "./target-environment.js";

type AuthMode = "jwt";
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

function getAuthMode(): AuthMode {
  const moduleDefinition = getSupportedModule();
  const secretNames = [moduleDefinition.auth.secretEnvVar];

  if (moduleDefinition.auth.legacySecretEnvVar) {
    secretNames.push(moduleDefinition.auth.legacySecretEnvVar);
  }

  if (getFirstDefinedEnv(...secretNames)) {
    return "jwt";
  }

  throw new Error(
    `Missing auth configuration. Set ${moduleDefinition.auth.secretEnvVar} to enable JWT auth.`
  );
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
  secretNames.push(moduleDefinition.auth.secretEnvVar);
  if (moduleDefinition.auth.legacySecretEnvVar) {
    secretNames.push(moduleDefinition.auth.legacySecretEnvVar);
  }

  const secret =
    getFirstDefinedEnv(...secretNames) ?? requiredEnv(moduleDefinition.auth.secretEnvVar);
  const jwtConfig = moduleDefinition.auth.jwt;
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
    Date.now() + moduleDefinition.auth.jwt.expiresInSeconds * 1_000;

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
  getApiBearerToken(targetEnvironment?: TargetEnvironment): Promise<string>;
  resolveApiBaseUrl(targetEnvironment: TargetEnvironment): string;
}

export function getEnv(moduleSlug?: string): EnvConfig {
  const moduleDefinition = getSupportedModule(moduleSlug);

  return {
    apiTimeoutMs: appConfig.requests.timeoutMs,
    authMode: getAuthMode(),
    defaultTargetEnvironment: moduleDefinition.defaultTargetEnvironment,
    jwtEmail: moduleDefinition.auth.jwt.email,
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
  const secretNames = [defaultModule.auth.secretEnvVar];

  if (defaultModule.auth.legacySecretEnvVar) {
    secretNames.push(defaultModule.auth.legacySecretEnvVar);
  }

  return {
    defaultTargetEnvironment: defaultModule.defaultTargetEnvironment,
    availableTargetEnvironments: [...targetEnvironmentSchema.options],
    authMode: getFirstDefinedEnv(...secretNames) ? "jwt" : "unconfigured",
    jwtEmail: defaultModule.auth.jwt.email,
    serviceName: defaultModule.serviceName,
    tokenCacheStrategy: "memory",
    targetBaseUrls: {
      staging: defaultModule.environments.staging.baseUrl,
      prod: defaultModule.environments.prod.baseUrl
    },
    modules: getSupportedModules()
  };
}
