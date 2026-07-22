import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

function wasCancelled(error) {
  const output = `${error?.message || ''}\n${error?.stderr || ''}`;
  return /cancel|abgebrochen|canceled|cancelled|user canceled/i.test(output);
}

export async function chooseLocalFolder(platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const { stdout } = await runFile('osascript', [
        '-e', 'set selectedFolder to choose folder with prompt "OneDrive- oder Transkriptordner auswählen"',
        '-e', 'POSIX path of selectedFolder'
      ]);
      return { cancelled: false, folderPath: stdout.trim() };
    }

    if (platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$dialog.Description = "OneDrive- oder Transkriptordner auswählen"',
        '$dialog.ShowNewFolderButton = $false',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }'
      ].join('; ');
      const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
      const folderPath = stdout.trim();
      return { cancelled: !folderPath, folderPath };
    }

    if (platform === 'linux') {
      const { stdout } = await runFile('zenity', [
        '--file-selection',
        '--directory',
        '--title=OneDrive- oder Transkriptordner auswählen'
      ]);
      return { cancelled: false, folderPath: stdout.trim() };
    }

    throw Object.assign(new Error('Auf diesem Betriebssystem ist kein nativer Ordnerdialog verfügbar.'), { status: 501 });
  } catch (error) {
    if (wasCancelled(error) || error?.code === 1) return { cancelled: true, folderPath: '' };
    throw Object.assign(new Error(`Der Ordnerdialog konnte nicht geöffnet werden: ${error.message}`), { status: 500 });
  }
}
