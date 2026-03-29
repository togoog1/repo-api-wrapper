import { z } from "zod";

import { syncOnboardingConfigSchema } from "./sync-onboarding.js";

export const syncOnboardingInputSchema = syncOnboardingConfigSchema.extend({
  label: z.string().trim().min(1).max(120).optional()
}).partial({
  targetEnvironment: true,
  pathTemplate: true
});

export type SyncOnboardingInput = z.infer<typeof syncOnboardingInputSchema>;
