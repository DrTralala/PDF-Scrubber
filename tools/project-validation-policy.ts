export type ProjectBashAction = 'allow' | 'ask' | 'deny';

export const PROJECT_VALIDATION_BASH_ENTRIES = Object.freeze([
  ['*', 'ask'],
  ['**', 'ask'],
  ['node --version', 'allow'],
  ['npm --version', 'allow'],
  ['npm ls --depth=0', 'allow'],
  ["ss -ltnp '( sport = :5173 )'", 'allow'],
  ["ss -ltn '( sport = :5173 )'", 'allow'],
  ['npm run build:fixtures', 'allow'],
  ['npm run typecheck', 'allow'],
  ['npm run test:web:unit', 'allow'],
  ['npm run test:web:unit -- *', 'allow'],
  ['npm run build:web', 'allow'],
  ['npm run test:web', 'allow'],
  ['npm run test:web -- *', 'allow'],
  ['npm run test:web -- --full', 'allow'],
  ['npm run test:web -- --full *', 'allow'],
  ['npm run test:m0', 'allow'],
  ['npm start -- --host 127.0.0.1', 'allow'],
  ['npm start -- --host 127.0.0.1 --strictPort', 'allow'],
  ['npm start -- --host ::1', 'allow'],
  ['npm start -- --host ::1 --strictPort', 'allow'],
  ['npm start -- --host 0.0.0.0', 'allow'],
  ['npm start -- --host 0.0.0.0 --strictPort', 'allow'],
  ['sha256sum tests/*/document.pdf', 'allow'],
  ['file tests/*/document.pdf', 'allow'],
  ['pdfinfo tests/*/document.pdf', 'allow'],
  ['pdffonts tests/*/document.pdf', 'allow'],
  ['pdftotext tests/*/document.pdf -', 'allow'],
  ['opencode debug config', 'allow'],
  ['*<*', 'ask'],
  ['*>*', 'ask'],
] as const satisfies readonly (readonly [string, ProjectBashAction])[]);

type ConfigWithPermission = {
  permission?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyProjectValidationBashPolicy(config: ConfigWithPermission): void {
  const permission = config.permission;
  if (!isRecord(permission)) {
    throw new Error('Resolved OpenCode permission must be an object');
  }
  config.permission = {
    ...permission,
    bash: Object.fromEntries(PROJECT_VALIDATION_BASH_ENTRIES),
  };
}
