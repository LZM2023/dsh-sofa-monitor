$ErrorActionPreference = 'Stop'
try {
  $sofaImagePath = [Environment]::GetEnvironmentVariable('SOFA_MONITOR_IMAGE')
  if (![IO.File]::Exists($sofaImagePath)) { throw 'Image does not exist' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public static class SofaMonitorFolder {
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint mode);
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint mask, out uint attributes);
  [DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr pidl, uint count, IntPtr items, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  public static void Focus(long handle) {
    IntPtr window=new IntPtr(handle);
    ShowWindowAsync(window,9);
    BringWindowToTop(window);
    SetForegroundWindow(window);
  }
  public static bool Visible(long handle) { IntPtr window=new IntPtr(handle); return IsWindowVisible(window) && !IsIconic(window); }
  public static bool Foreground(long handle) { return GetForegroundWindow()==new IntPtr(handle); }
  public static void OpenNewWindow(string path) {
    Process.Start(new ProcessStartInfo {
      FileName=System.IO.Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"),"explorer.exe"),
      Arguments="/n,/select,\""+path+"\"",
      UseShellExecute=true,
      WindowStyle=ProcessWindowStyle.Normal
    });
  }
  public static void Reveal(string path) {
    int initialized=CoInitializeEx(IntPtr.Zero,2);
    Marshal.ThrowExceptionForHR(initialized);
    IntPtr pidl=IntPtr.Zero;
    try {
      uint attributes;
      Marshal.ThrowExceptionForHR(SHParseDisplayName(path,IntPtr.Zero,out pidl,0,out attributes));
      // With count=0 the absolute item PIDL opens its parent and selects the file.
      Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(pidl,0,IntPtr.Zero,0));
    } finally {
      if(pidl!=IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
      CoUninitialize();
    }
  }
}
'@
  [SofaMonitorFolder]::Reveal($sofaImagePath)
  # Shell acceptance alone can leave the existing Explorer window hidden or
  # minimized. Verify the actual folder/selection and restore that exact window.
  $sofaDirectory = [IO.Path]::GetDirectoryName($sofaImagePath)
  $sofaFilename = [IO.Path]::GetFileName($sofaImagePath)
  $sofaShell = New-Object -ComObject Shell.Application
  $sofaTimer = [Diagnostics.Stopwatch]::StartNew()
  $sofaSelected = $false
  $sofaVisible = $false
  $sofaForeground = $false
  $sofaOpenedNewWindow = $false
  while ($sofaTimer.ElapsedMilliseconds -lt 10000) {
    foreach ($sofaWindow in @($sofaShell.Windows())) {
      try {
        if (![String]::Equals($sofaWindow.Document.Folder.Self.Path, $sofaDirectory, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $sofaItem = $sofaWindow.Document.Folder.ParseName($sofaFilename)
        if ($null -eq $sofaItem) { continue }
        $sofaWindow.Document.SelectItem($sofaItem, 29)
        $sofaSelection = @($sofaWindow.Document.SelectedItems())
        $sofaSelected = $sofaSelection.Count -eq 1 -and [String]::Equals($sofaSelection[0].Path, $sofaImagePath, [StringComparison]::OrdinalIgnoreCase)
        if (!$sofaSelected) { continue }
        $sofaHandle = [long]$sofaWindow.HWND
        [SofaMonitorFolder]::Focus($sofaHandle)
        Start-Sleep -Milliseconds 100
        $sofaVisible = [SofaMonitorFolder]::Visible($sofaHandle)
        $sofaForeground = [SofaMonitorFolder]::Foreground($sofaHandle)
        if ($sofaVisible -and $sofaForeground) { break }
      } catch { }
    }
    if ($sofaSelected -and $sofaVisible -and $sofaForeground) { break }
    # A stale Explorer tab or a window on another desktop may accept the PIDL
    # without surfacing. One explicit visible Explorer launch is allowed here.
    if (!$sofaOpenedNewWindow -and $sofaTimer.ElapsedMilliseconds -ge 2000) {
      [SofaMonitorFolder]::OpenNewWindow($sofaImagePath)
      $sofaOpenedNewWindow = $true
    }
    Start-Sleep -Milliseconds 100
  }
  $sofaReceipt = @{revealed=($sofaSelected -and $sofaVisible -and $sofaForeground);selected=$sofaSelected;visible=$sofaVisible;foreground=$sofaForeground}
  [Console]::Out.Write(($sofaReceipt | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine('Windows folder selection failed. HRESULT=' + $_.Exception.HResult)
  exit 1
}
