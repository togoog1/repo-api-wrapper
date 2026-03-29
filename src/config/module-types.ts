import type { TargetEnvironment } from "../lib/target-environment.js";

export interface ModuleEnvironmentDefinition {
  baseUrl: string;
}

export interface ModuleAuthDefinition {
  mode: "jwt";
  secretEnvVar: string;
  legacySecretEnvVar?: string;
  secretEnvVarByEnvironment?: Partial<Record<TargetEnvironment, string>>;
  jwt: {
    email: string;
    subject?: string;
    issuer?: string;
    audience?: string;
    expiresInSeconds: number;
  };
}

export interface ModuleEndpointDefinition {
  slug: string;
  action: string;
  label: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
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
  endpoints: ModuleEndpointDefinition[];
}
