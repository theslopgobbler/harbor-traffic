<#
  Your own ship photos, ready for the map. Put pictures in harbor-traffic\photos\ (never published: phone photos
  carry the GPS spot they were taken from), named for the boat: its name ("MARY ROSE BRUSCO.jpg", "Mary Rose
  Brusco 2.jpg") or its MMSI ("367324840.jpg"). Then run this, then publish.ps1.

  For each photo it finds the boat (by MMSI, or by name among every boat the collector has heard: data/ship-registry.json
  on the site), turns it upright, shrinks it to at most 1280 px, saves it as a plain JPEG with nothing hidden in it
  (no location, no camera details) in ships\, and lists it in ships\photos.json, which the map reads.

  Credit: "harborevents.org" unless photos\credit.txt says otherwise (one line, e.g. "Jessi"). A text file next to a
  photo with the same name ("MARY ROSE BRUSCO.txt") can set "caption: ..." and "credit: ..." for that one.
  Photos from elsewhere that are already in ships\photos.json (Wikimedia Commons) are kept as they are.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$inDir = Join-Path $root 'photos'; $outDir = Join-Path $root 'ships'; $listFile = Join-Path $outDir 'photos.json'
New-Item -ItemType Directory -Force $inDir, $outDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

# every boat the collector has heard (name -> MMSI), plus the ones on the map now
$names = @{}
$norm = { param($s) ("$s".ToUpper() -replace '[^A-Z0-9]', '') }
foreach ($url in 'https://traffic.harborevents.org/data/ship-registry.json', 'https://traffic.harborevents.org/data/ships.json') {
    try {
        $j = Invoke-RestMethod "$url`?t=$([DateTime]::UtcNow.Ticks)" -TimeoutSec 30
        if ($j.ships -is [array]) { foreach ($s in $j.ships) { if ($s.name) { $names[(& $norm $s.name)] = "$($s.mmsi)" } } }
        elseif ($j.ships) { foreach ($p in $j.ships.PSObject.Properties) { if ($p.Value.name) { $names[(& $norm $p.Value.name)] = $p.Name } } }
    } catch { }
}

$defaultCredit = 'harborevents.org'
$cf = Join-Path $inDir 'credit.txt'
if (Test-Path $cf) { $c = (Get-Content $cf -Raw).Trim(); if ($c) { $defaultCredit = $c } }

# keep photos from elsewhere (Commons) as they are; rebuild your own from the folder
$photos = [ordered]@{}
if (Test-Path $listFile) {
    $old = Get-Content $listFile -Raw | ConvertFrom-Json
    foreach ($p in $old.photos.PSObject.Properties) {
        $keep = @($p.Value | Where-Object { $_.source -ne 'own' })
        if ($keep.Count) { $photos[$p.Name] = [System.Collections.ArrayList]@($keep) }
    }
}

# turn a photo upright (phones save it sideways plus a note saying which way is up), shrink it, save it clean
function Save-Clean($src, $dest) {
    $img = [System.Drawing.Image]::FromFile($src)
    try {
        if ($img.PropertyIdList -contains 0x0112) {
            switch ([int]$img.GetPropertyItem(0x0112).Value[0]) {
                3 { $img.RotateFlip('Rotate180FlipNone') } 6 { $img.RotateFlip('Rotate90FlipNone') } 8 { $img.RotateFlip('Rotate270FlipNone') }
                2 { $img.RotateFlip('RotateNoneFlipX') } 4 { $img.RotateFlip('RotateNoneFlipY') }
                5 { $img.RotateFlip('Rotate90FlipX') } 7 { $img.RotateFlip('Rotate270FlipX') }
            }
        }
        $k = [Math]::Min([double]1, 1280.0 / [Math]::Max($img.Width, $img.Height)) # (both decimal: a whole-number 1 makes the result 0)
        $w = [int][Math]::Round($img.Width * $k); $h = [int][Math]::Round($img.Height * $k)
        # drawn onto a new blank picture: none of the original's hidden details (location, camera) come along
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
        $g.DrawImage($img, 0, 0, $w, $h); $g.Dispose()
        $jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
        $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 82L
        $bmp.Save($dest, $jpeg, $ep); $bmp.Dispose()
        return @($w, $h)
    } finally { $img.Dispose() }
}

$used = @{}
$files = Get-ChildItem $inDir -File | Where-Object { $_.Extension -match '^\.(jpe?g|png)$' }
foreach ($f in $files) {
    $base = $f.BaseName
    $mmsi = if ($base -match '^(\d{9})') { $Matches[1] } else { $names[(& $norm ($base -replace '\s*(\(\d+\)|[-_ ]\d{1,2})$', ''))] }
    if (-not $mmsi) { "?? $($f.Name): no boat by that name has been heard yet (name it by MMSI, or wait until the collector has heard it)"; continue }
    $hash = (Get-FileHash $f.FullName -Algorithm SHA1).Hash.Substring(0, 8).ToLower()
    $name = "$mmsi-$hash.jpg"; $dest = Join-Path $outDir $name
    $wh = if (Test-Path $dest) { $i = [System.Drawing.Image]::FromFile($dest); $r = @($i.Width, $i.Height); $i.Dispose(); $r } else { Save-Clean $f.FullName $dest }
    $caption = ''; $credit = $defaultCredit
    $side = Join-Path $inDir "$base.txt"
    if (Test-Path $side) { foreach ($l in Get-Content $side) { if ($l -match '^\s*caption\s*:\s*(.+)$') { $caption = $Matches[1].Trim() } elseif ($l -match '^\s*credit\s*:\s*(.+)$') { $credit = $Matches[1].Trim() } } }
    if (-not $photos.Contains($mmsi)) { $photos[$mmsi] = [System.Collections.ArrayList]@() }
    # your own photos first
    $photos[$mmsi].Insert(0, [ordered]@{ src = "ships/$name"; w = $wh[0]; h = $wh[1]; caption = $caption; credit = $credit; source = 'own' })
    $used[$name] = $true
    "ok $($f.Name) -> boat $mmsi ($($wh[0])x$($wh[1]))"
}
# shrunken copies of photos no longer in the folder
Get-ChildItem $outDir -File | Where-Object { $_.Name -match '^\d{9}-[0-9a-f]{8}\.jpg$' -and -not $used[$_.Name] } | ForEach-Object { Remove-Item $_.FullName; "removed $($_.Name) (its photo is gone from the folder)" }

$json = [ordered]@{ updated = [DateTimeOffset]::UtcNow.ToString('o'); photos = $photos } | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($listFile, $json, $utf8)
"$($files.Count) photo(s) in the folder; $(@($photos.Keys).Count) boat(s) with photos. Now run publish.ps1."
