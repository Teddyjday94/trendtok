// Best-effort desktop notification using whatever the OS already has, so it
// works even when the browser tab is closed. Text is passed as arguments or
// environment variables, never pasted into a command string.
import { execFile } from 'node:child_process';

export function desktopNotify(title, message) {
  const done = (err) => {
    if (err) console.warn(`Desktop notification failed: ${err.message}`);
  };
  if (process.platform === 'darwin') {
    execFile(
      'osascript',
      ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message],
      done,
    );
  } else if (process.platform === 'win32') {
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      $n = New-Object System.Windows.Forms.NotifyIcon
      $n.Icon = [System.Drawing.SystemIcons]::Information
      $n.Visible = $true
      $n.ShowBalloonTip(10000, $env:TT_TITLE, $env:TT_MESSAGE, 'Info')
      Start-Sleep -Seconds 10
      $n.Dispose()`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, TT_TITLE: title, TT_MESSAGE: message }, windowsHide: true },
      done,
    );
  } else {
    execFile('notify-send', ['--app-name=TrendTok', title, message], done);
  }
}
