import { z } from "zod";

import { createRunSlug } from "../lib/slug.js";
import { prisma } from "../lib/prisma.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

export const inputListDataSchema = z.array(jsonValueSchema);

export async function listSavedInputLists(moduleSlug?: string) {
  return prisma.savedInputList.findMany({
    where: {
      moduleSlug: moduleSlug ?? undefined
    },
    orderBy: {
      createdAt: "desc"
    },
    take: 100,
    select: {
      id: true,
      slug: true,
      label: true,
      description: true,
      moduleSlug: true,
      itemType: true,
      itemCount: true,
      data: true,
      sourceRunId: true,
      createdAt: true,
      updatedAt: true
    }
  });
}

export async function createSavedInputList(input: {
  label: string;
  description?: string;
  moduleSlug?: string;
  itemType: string;
  data: JsonValue[];
  sourceRunId?: string;
}) {
  const data = inputListDataSchema.parse(input.data);

  return prisma.savedInputList.create({
    data: {
      slug: createRunSlug(input.label),
      label: input.label,
      description: input.description,
      moduleSlug: input.moduleSlug,
      itemType: input.itemType,
      data: data as never,
      itemCount: data.length,
      sourceRunId: input.sourceRunId
    },
    select: {
      id: true,
      slug: true,
      label: true,
      description: true,
      moduleSlug: true,
      itemType: true,
      itemCount: true,
      data: true,
      sourceRunId: true,
      createdAt: true,
      updatedAt: true
    }
  });
}

export async function deleteSavedInputList(id: string) {
  const existing = await prisma.savedInputList.findUnique({ where: { id } });
  if (!existing) {
    throw new Error(`Input list not found: ${id}`);
  }
  await prisma.savedInputList.delete({ where: { id } });
}

export async function createSavedInputListFromRunFailures(runId: string) {
  const [run, failedItems] = await Promise.all([
    prisma.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        label: true,
        moduleSlug: true
      }
    }),
    prisma.runItem.findMany({
      where: {
        runId,
        status: "FAILED"
      },
      orderBy: {
        sequence: "asc"
      },
      select: {
        masterId: true
      }
    })
  ]);

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (failedItems.length === 0) {
    throw new Error("Run has no failed items to save.");
  }

  return createSavedInputList({
    label: `${run.label ?? run.id} failures`,
    description: "Saved from failed run items",
    moduleSlug: run.moduleSlug ?? undefined,
    itemType: "master_id",
    data: failedItems.map((item) => item.masterId),
    sourceRunId: run.id
  });
}
