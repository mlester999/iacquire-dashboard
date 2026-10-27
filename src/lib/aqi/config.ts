import { z } from "zod";

export const aqiConfigSchema = z.object({
  identity: z.string().trim().min(1).max(40).default("AQi"),
  description: z.string().trim().min(1).max(200).default("The official iAcquireOS platform assistant."),
  tone: z.string().trim().min(1).max(200).default("friendly, professional and plain-English"),
  greeting: z.string().trim().min(1).max(500).default("Hi, I'm AQi. What can I help you with?"),
  instructions: z.string().trim().min(1).max(4000).default("Answer from the approved iAcquireOS knowledge supplied for this request."),
  maxTokens: z.number().int().min(128).max(2000).default(700),
  complexMaxTokens: z.number().int().min(512).max(2000).default(1400),
  maxContextTokens: z.number().int().min(1000).max(64000).default(6000),
  knowledgeFreshnessDays: z.number().int().min(7).max(3650).default(90),
  temperature: z.number().min(0).max(1).default(0.3),
  model: z.string().trim().min(1).max(120).default("deepseek-chat"),
  modelOverride: z.boolean().default(false),
  responseVerbosity: z.enum(["adaptive", "concise", "balanced", "detailed"]).default("adaptive"),
  greetingBehavior: z.enum(["warm", "brief", "professional"]).default("warm"),
  navigationBehavior: z.enum(["link_when_relevant", "explain_inline"]).default("link_when_relevant"),
  followUpBehavior: z.enum(["when_useful", "always", "never"]).default("when_useful"),
  citationBehavior: z.enum(["when_relevant", "always", "never"]).default("when_relevant"),
  fallbackInstructions: z.string().trim().max(1500).default("If you cannot verify an answer, say so briefly and point to Support or the authorized administrator."),
  roleGuidance: z.string().trim().max(1500).default("Answer from the signed-in person's actual permissions. Never imply access to a page or data they cannot access."),
  attachments: z.object({
    imagesEnabled: z.boolean().default(true),
    imageMaxMb: z.number().int().min(1).max(10).default(10),
    maxImages: z.number().int().min(1).max(5).default(5),
    documentsEnabled: z.boolean().default(true),
    documentMaxMb: z.number().int().min(1).max(20).default(20),
    maxDocuments: z.number().int().min(1).max(5).default(5),
    videosEnabled: z.boolean().default(true),
    videoMaxMb: z.number().int().min(1).max(50).default(50),
    maxVideos: z.number().int().min(1).max(1).default(1),
    videoMaxSeconds: z.number().int().min(1).max(60).default(60),
    visionEnabled: z.boolean().default(false),
    videoAnalysisEnabled: z.boolean().default(false),
    attachmentContextTokens: z.number().int().min(500).max(16000).default(4000),
    storageQuotaMb: z.number().int().min(1).max(100000).default(500),
    retentionDays: z.number().int().min(1).max(3650).default(90),
  }).default({
    imagesEnabled: true, imageMaxMb: 10, maxImages: 5,
    documentsEnabled: true, documentMaxMb: 20, maxDocuments: 5,
    videosEnabled: true, videoMaxMb: 50, maxVideos: 1, videoMaxSeconds: 60,
    visionEnabled: false, videoAnalysisEnabled: false, attachmentContextTokens: 4000,
    storageQuotaMb: 500, retentionDays: 90,
  }),
});

export type AqiConfig = z.infer<typeof aqiConfigSchema>;
export const DEFAULT_AQI_CONFIG = aqiConfigSchema.parse({});

export interface AqiConfigView {
  versionId: string | null;
  version: number;
  config: AqiConfig;
}

/** The verified integration model is authoritative unless a Super Admin deliberately overrides it. */
export function effectiveAqiModel(config: AqiConfig, integrationModel: string | null | undefined): string {
  return (config.modelOverride && config.model.trim()) || integrationModel || config.model;
}
