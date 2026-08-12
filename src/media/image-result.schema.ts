import { z } from 'zod';

export const ImageUnderstandingResultSchema = z.object({
  summary: z.string().min(1).max(2000),
  visibleText: z.string().max(4000).nullable(),
  detectedProductOrCrm: z.string().max(300).nullable(),
  relevantToConversation: z.boolean(),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});

export type ImageUnderstandingResult = z.infer<
  typeof ImageUnderstandingResultSchema
>;
