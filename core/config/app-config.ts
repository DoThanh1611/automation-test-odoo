import type { Page } from '@playwright/test';

export interface RoleConfig {
  /** Vai trò này đại diện cho ai/quyền gì (hiển thị trong report và trong lý do BLOCKED). */
  description: string;
  /**
   * true = role dùng để kiểm tra "người KHÔNG có quyền". Nếu tài khoản cấu hình cho role này lại có quyền quản trị
   * (đã phát hiện qua inspectSession) hoặc không chứng minh được là không có quyền, test bị BLOCKED để tránh kết luận sai về phân quyền.
   */
  mustBeUnprivileged?: boolean;
}

/** Kết quả kiểm tra phiên đăng nhập. Không chứa dữ liệu nhạy cảm. */
export interface SessionInfo {
  privileged: boolean;
  detail: string;
  /** Tên đăng nhập mà ứng dụng báo là đang đăng nhập (để đối chiếu với tài khoản đã cấu hình cho vai trò). */
  login?: string;
}

/** Thông tin đăng nhập của ĐÚNG môi trường + vai trò đang chạy (lấy từ .env qua environments/<app>.json). */
export interface LoginContext {
  baseUrl: string;
  user: string;
  pass: string;
  db?: string;
}

/**
 * Hợp đồng chung mỗi ứng dụng web phải cung cấp. Core không biết gì về Odoo/MISA.
 * URL, tài khoản, mật khẩu KHÔNG nằm ở đây: chúng thuộc từng môi trường (environments/<app>.json + .env).
 */
export interface AppConfig {
  name: string;
  /** Các vai trò mà ứng dụng này hỗ trợ; mỗi môi trường khai báo biến tài khoản riêng cho từng vai trò. */
  roles: Record<string, RoleConfig>;
  login(page: Page, role: string, ctx: LoginContext): Promise<void>;
  /** Tuỳ chọn: sau khi đăng nhập, cho biết tài khoản đang đăng nhập và có quyền quản trị không. */
  inspectSession?(page: Page): Promise<SessionInfo>;
  /** Tuỳ chọn: phiên bản ứng dụng thực tế (để đối chiếu với phiên bản kỳ vọng của môi trường). undefined = không đọc được. */
  inspectVersion?(page: Page): Promise<string | undefined>;
}
