import { spawn, spawnSync } from 'node:child_process';

/** Mở URL hoặc đường dẫn file bằng ứng dụng mặc định của hệ điều hành. Trả về false nếu không mở được (khi đó chỉ cần in đường dẫn). */
export function openInBrowser(target: string): boolean {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Hộp thoại hệ điều hành hỏi người dùng thật (mặc định chọn "Không"). Chỉ dùng cho APPROVE trên giao diện Web:
 * Claude gọi API không bấm được hộp thoại này. Nền tảng chưa hỗ trợ => false (dùng lệnh terminal dự phòng).
 */
export async function nativeConfirm(title: string, message: string, timeoutMs = 180_000): Promise<boolean> {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.WindowState = "Minimized"',
      '$r = [System.Windows.Forms.MessageBox]::Show($f, $env:QA_DLG_MSG, $env:QA_DLG_TITLE, [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)',
      'Write-Output $r',
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      env: { ...process.env, QA_DLG_MSG: message, QA_DLG_TITLE: title },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return r.status === 0 && r.stdout.trim() === 'Yes';
  }
  if (process.platform === 'darwin') {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const r = spawnSync('osascript', ['-e', `display dialog "${esc(message)}" with title "${esc(title)}" buttons {"Huy", "Duyet"} default button "Huy"`], { encoding: 'utf8', timeout: timeoutMs });
    return r.status === 0 && /button returned:Duyet/.test(r.stdout);
  }
  return false;
}
