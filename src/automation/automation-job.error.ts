export type AutomationFailureKind = 'RETRYABLE' | 'TERMINAL';

export class AutomationJobError extends Error {
  constructor(
    readonly code: string,
    readonly kind: AutomationFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AutomationJobError';
  }
}
