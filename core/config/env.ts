import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

export const env = {
  app: process.env.APP ?? '',
  headless: (process.env.HEADLESS ?? 'true') !== 'false',
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  allowWriteTests: process.env.ALLOW_WRITE_TESTS === 'true',
};

/** Trả về biến môi trường hoặc undefined nếu trống. */
export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Danh sách biến còn thiếu — dùng để BLOCK test thay vì giả lập kết quả. */
export function missingEnv(names: string[]): string[] {
  return names.filter((n) => !optionalEnv(n));
}
