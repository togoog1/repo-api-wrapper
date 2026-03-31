import { z } from "zod";

import { httpRequestConfigSchema } from "./http-request.js";

export const httpRequestInputSchema = httpRequestConfigSchema.extend({
  label: z.string().trim().min(1).max(120).optional()
}).partial({
  targetEnvironment: true,
  pathTemplate: true
});

export type HttpRequestInput = z.infer<typeof httpRequestInputSchema>;
