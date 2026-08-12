import { BadRequestException } from '@nestjs/common';
import { ALLOWED_PROMPT_VARIABLES } from '../prompt-strategies.constants';

const ALLOWED = new Set<string>(ALLOWED_PROMPT_VARIABLES);
const VARIABLE_PATTERN = /{{([^{}]*)}}/g;

export function validateAndExtractPromptVariables(values: string[]): string[] {
  const variables = new Set<string>();

  for (const value of values) {
    VARIABLE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    let sanitized = value;

    while ((match = VARIABLE_PATTERN.exec(value)) !== null) {
      const variable = match[1].trim();
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(variable) || !ALLOWED.has(variable)) {
        throwInvalidVariables();
      }
      variables.add(variable);
      sanitized = sanitized.replace(match[0], '');
    }

    if (sanitized.includes('{{') || sanitized.includes('}}')) {
      throwInvalidVariables();
    }
  }

  return [...variables];
}

function throwInvalidVariables(): never {
  throw new BadRequestException(
    'Промпт содержит неизвестные или некорректные переменные',
  );
}
