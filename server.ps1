# Tiny static file server (built into Windows PowerShell - no installs needed).
$root = $PSScriptRoot
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}

$listener = $null
foreach ($port in 8000..8030) {
  $l = New-Object System.Net.HttpListener
  $l.Prefixes.Add("http://localhost:$port/")
  try { $l.Start(); $listener = $l; break } catch { $l.Close() }
}
if (-not $listener) { Write-Host 'Could not find a free port (8000-8030).'; Read-Host 'Press Enter to exit'; exit 1 }

$url = "http://localhost:$port/"
Write-Host "Serving $root"
Write-Host "Open $url  -  close this window (or Ctrl+C) to stop."
Start-Process $url

try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    while (-not $task.AsyncWaitHandle.WaitOne(200)) { }   # polling keeps Ctrl+C responsive
    $ctx = $task.Result
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
      if (Test-Path $full -PathType Container) { $full = Join-Path $full 'index.html' }
      if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        $ctx.Response.StatusCode = 403
      } elseif (Test-Path $full -PathType Leaf) {
        $bytes = [IO.File]::ReadAllBytes($full)
        $ext = [IO.Path]::GetExtension($full).ToLower()
        $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $ctx.Response.Headers.Add('Cache-Control', 'no-store')
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.StatusCode = 404
      }
    } catch { $ctx.Response.StatusCode = 500 }
    finally { $ctx.Response.Close() }
  }
} finally { $listener.Stop() }
