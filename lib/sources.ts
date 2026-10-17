export interface SourceConfig {
  key: 'dev' | 'learn';
  listLabel: string;
  lensSkill: string;
}

export const SOURCES: SourceConfig[] = [
  { key: 'dev', listLabel: 'Dev', lensSkill: 'dev-lens.md' },
  { key: 'learn', listLabel: 'Learn', lensSkill: 'learn-lens.md' },
];
