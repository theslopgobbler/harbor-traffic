<#
  data/route-cells.json -> data/route-cells-packed.json: the same squares, packed small for the relay (Cloudflare's
  free plan gives each once-a-minute run about 10 ms of computing, and turning 12,000+ squares written as text into
  lookup tables took a good part of it; on Oct 5 runs at busy times went over and the bus log went dark for hours).
  Each square (i = floor(lat / 0.0005), j = floor(lon / 0.00073)) becomes one number, (i - 90000) * 20000 + (j + 180000),
  sorted, as 4-byte little-endian integers in base64, so the relay can search it as it is.
  Run by build-gtfs.ps1; safe to run by hand.
#>
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'data\route-cells.json'
$j = Get-Content $src -Raw | ConvertFrom-Json
$out = foreach ($p in $j.routes.PSObject.Properties) {
    $keys = New-Object System.Collections.Generic.List[int]
    foreach ($c in $p.Value) { $ij = "$c".Split(','); $keys.Add(([int]$ij[0] - 90000) * 20000 + ([int]$ij[1] + 180000)) }
    $keys.Sort()
    $bytes = New-Object byte[] ($keys.Count * 4)
    for ($k = 0; $k -lt $keys.Count; $k++) { [BitConverter]::GetBytes([int]$keys[$k]).CopyTo($bytes, $k * 4) }
    "`"$($p.Name)`":`"$([Convert]::ToBase64String($bytes))`""
}
[IO.File]::WriteAllText((Join-Path $root 'data\route-cells-packed.json'), "{`"lat`":0.0005,`"lon`":0.00073,`"routes`":{$($out -join ',')}}", (New-Object System.Text.UTF8Encoding($false)))
"packed route squares: $([math]::Round((Get-Item (Join-Path $root 'data\route-cells-packed.json')).Length / 1KB)) KB"
