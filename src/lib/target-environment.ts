import { z } from "zod";

export const targetEnvironmentSchema = z.enum(["staging", "prod"]);

export type TargetEnvironment = z.infer<typeof targetEnvironmentSchema>;
