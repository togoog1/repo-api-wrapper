import type { TargetEnvironment } from "../lib/target-environment.js";

export interface ModuleEnvironmentDefinition {
  baseUrl: string;
}

export interface ModuleAuthDefinition {
  mode: "jwt" | "apikey" | "bearer" | "none";
  // JWT mode
  secretEnvVar?: string;
  legacySecretEnvVar?: string;
  secretEnvVarByEnvironment?: Partial<Record<TargetEnvironment, string>>;
  jwt?: {
    email: string;
    subject?: string;
    issuer?: string;
    audience?: string;
    expiresInSeconds: number;
  };
  // API Key mode
  apikey?: {
    headerName: string;
    valueEnvVar: string;
  };
  // Bearer token mode
  bearer?: {
    tokenEnvVar: string;
  };
}

export interface ModuleEndpointDefinition {
  slug: string;
  action: string;
  label: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  folder?: string[];
  defaultHeaders?: Record<string, string>;
  requestBodyDescription?: string;
  notes?: string;
  defaultRunLabel?: string;
  defaultRunConfig?: Record<string, unknown>;
}

export interface ModuleDefinition {
  slug: string;
  serviceName: string;
  label: string;
  description: string;
  defaultTargetEnvironment: TargetEnvironment;
  environments: Record<TargetEnvironment, ModuleEnvironmentDefinition>;
  auth: ModuleAuthDefinition;
  defaultHeaders?: Record<string, string>;
  endpoints: ModuleEndpointDefinition[];
}
