import { z } from 'zod';

export const AiResultSchema = z
  .object({
    reply: z.string().min(1).max(1000),
    action: z.enum(['CONTINUE', 'QUALIFY', 'HANDOFF', 'STOP', 'WAIT']),
    leadDecision: z.enum(['NOT_READY', 'QUALIFIED', 'REJECTED', 'UNCERTAIN']),
    summary: z.string().max(1500).nullable(),
    qualificationReason: z.string().max(1500).nullable(),
    extractedData: z.object({
      decisionMaker: z.boolean().nullable(),
      mastersCount: z.number().int().min(0).max(10_000).nullable(),
      doctorsCount: z.number().int().min(0).max(10_000).nullable(),
      currentCrm: z.string().nullable(),
      currentProcess: z.string().nullable(),
      interestedInDemo: z.boolean().nullable(),
      preferredContactTime: z.string().nullable(),
      objections: z.array(z.string().max(300)).max(10),
      needs: z.array(z.string().max(300)).max(10),
    }),
    shouldCreateLead: z.boolean(),
    shouldCloseConversation: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.leadDecision === 'QUALIFIED' && !value.shouldCreateLead) {
      context.addIssue({
        code: 'custom',
        message: 'QUALIFIED requires a lead',
      });
    }
    if (value.leadDecision !== 'QUALIFIED' && value.shouldCreateLead) {
      context.addIssue({
        code: 'custom',
        message: 'Lead decision conflicts with lead creation',
      });
    }
    if (value.action === 'QUALIFY' && !value.shouldCreateLead) {
      context.addIssue({ code: 'custom', message: 'QUALIFY requires a lead' });
    }
    if (
      (value.leadDecision === 'REJECTED' || value.action === 'STOP') &&
      !value.shouldCloseConversation
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Result requires closing conversation',
      });
    }
  });

export type AiResult = z.infer<typeof AiResultSchema>;

export const MOCK_SCENARIOS = [
  'CONTINUE',
  'QUALIFIED',
  'REJECTED',
  'HANDOFF',
  'REFUSED',
  'INVALID_OUTPUT',
  'TIMEOUT',
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];
