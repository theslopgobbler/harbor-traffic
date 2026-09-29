# Local preview: serves the repo folder at http://localhost:8765/
param([int]$Port = 8765)
$root = Split-Path $PSScriptRoot -Parent
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8';
            '.json'='application/json; charset=utf-8'; '.svg'='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'; '.ico'='image/x-icon' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
"Serving $root at http://localhost:$Port/"
while ($l.IsListening) {
    $ctx = $l.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if (-not $path) { $path = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf) -and $path -notmatch 'key|token') {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ctx.Response.ContentType = $types[[IO.Path]::GetExtension($file)]
        $ctx.Response.Headers['Cache-Control'] = 'no-store'
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else { $ctx.Response.StatusCode = 404 }
    $ctx.Response.Close()
}
