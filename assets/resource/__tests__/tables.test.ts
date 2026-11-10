import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tablesDir = fileURLToPath(new URL('../tables/', import.meta.url));
const generatedDir = fileURLToPath(new URL('../generated/', import.meta.url));
const TABLE_NAME = /^[a-z][a-z0-9_]*\.xlsx$/;

describe('resource table contract', () => {
  it('has a tables directory with the authoring README', () => {
    expect(existsSync(tablesDir)).toBe(true);
    expect(existsSync(`${tablesDir}README.md`)).toBe(true);
  });

  it('accepts only lowercase snake_case .xlsx source tables', () => {
    const files = readdirSync(tablesDir).filter((f) => f !== 'README.md');
    expect(files.every((f) => TABLE_NAME.test(f))).toBe(true);
    expect(new Set(files).size).toBe(files.length);
  });

  it('never ships a generated artifact without its source table', () => {
    if (!existsSync(generatedDir)) return;
    const sources = new Set(
      readdirSync(tablesDir).filter((f) => f.endsWith('.xlsx')).map((f) => f.replace(/\.xlsx$/, '')),
    );
    for (const out of readdirSync(generatedDir)) {
      expect(sources.has(out.replace(/\.[^.]+$/, ''))).toBe(true);
    }
  });
});
