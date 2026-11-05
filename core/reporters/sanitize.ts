import { collectSecrets, type Secret } from '../security/scan';
import { redactText } from '../security/scrub-trace';
import type { TcRunEntry } from './types';

/**
 * Lớp bảo vệ cuối cùng trước khi ghi kết quả/báo cáo: che mọi chuỗi trong 1 kết quả test case nếu chứa
 * cookie phiên, header Authorization hoặc giá trị bí mật đã biết (mật khẩu/cookie trong .env/.auth).
 * Báo cáo chia sẻ vì vậy không thể chứa bí mật, kể cả khi một test vô tình ghi chúng vào Actual hay lỗi.
 */
export function sanitizeValue<T>(value: T, secrets: Secret[]): T {
  if (typeof value === 'string') return redactText(value, secrets).text as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, secrets)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeValue(v, secrets)])) as T;
  }
  return value;
}

/** Không che đường dẫn evidence (chỉ là đường dẫn file, không chứa giá trị bí mật) để không làm hỏng liên kết. */
export function sanitizeEntry(entry: TcRunEntry, secrets: Secret[] = collectSecrets().secrets): TcRunEntry {
  const { evidence, ...rest } = entry;
  return { ...sanitizeValue(rest, secrets), evidence } as TcRunEntry;
}
