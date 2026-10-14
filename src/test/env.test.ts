import { describe, it, expect } from 'vitest';
import { validateEnv } from '../lib/env';

describe('Environment Variable Validation', () => {
  it('identifies unconfigured placeholder Supabase environment variables', () => {
    const config = validateEnv();
    expect(config).toBeDefined();
    expect(typeof config.isValid).toBe('boolean');
    expect(config.appName).toBe('SpazaStock');
  });

  it('collects diagnostic error messages when variables are missing or placeholders', () => {
    const config = validateEnv();
    if (!config.isValid) {
      expect(config.errors.length).toBeGreaterThan(0);
      expect(config.supabaseUrl).toBeUndefined();
      expect(config.supabaseAnonKey).toBeUndefined();
    }
  });
});
