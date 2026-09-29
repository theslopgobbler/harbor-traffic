<#
  Pulls WSDOT highway alerts for the Harbor Traffic region into data\wsdot-alerts.json
  and appends one line per run to data\history\YYYY-MM.jsonl (for the "worst times" report).
  Access code: $env:WSDOT_ACCESS_CODE (GitHub secret), or wsdot-key.txt next to this repo (local runs; never committed).
  Runs in Windows PowerShell 5.1 and pwsh 7.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$code = $env:WSDOT_ACCESS_CODE
if (-not $code) {
    $keyFile = Join-Path $root 'wsdot-key.txt'
    if (Test-Path $keyFile) { $code = (Get-Content $keyFile -Raw).Trim() }
}
if (-not $code) {
    # on GitHub, a missing secret shouldn't fail (and email) every 10 minutes
    if ($env:GITHUB_ACTIONS) { '::warning::WSDOT_ACCESS_CODE secret is not set; skipping.'; exit 0 }
    throw 'No WSDOT access code: set WSDOT_ACCESS_CODE or create wsdot-key.txt'
}

# region box with a little margin: [west, south, east, north]
$W = -124.55; $S = 46.50; $E = -122.70; $N = 48.00

$url = "https://wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson?AccessCode=$code"
$raw = Invoke-RestMethod -Uri $url -TimeoutSec 60

function To-Iso($s) {
    if ($s -and "$s" -match '(-?\d{10,})') { return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Matches[1]).ToString('o') }
    return $null
}
function In-Box($loc) {
    return $loc -and $loc.Latitude -ne 0 -and $loc.Longitude -ge $W -and $loc.Longitude -le $E -and $loc.Latitude -ge $S -and $loc.Latitude -le $N
}
function Kind($a) {
    $txt = "$($a.EventCategory) $($a.HeadlineDescription)"
    if ($txt -match '(?i)collision|crash|disabled vehicle|incident') { return 'collision' }
    if ($txt -match '(?i)\bclos(ed|ure)\b|blocked') { return 'closure' }
    if ($txt -match '(?i)construction|maintenance|road work|paving|lane') { return 'work' }
    return 'other'
}
function Road-Label($name) {
    $n = ("$name" -replace '\D', '').TrimStart('0')
    if (-not $n) { return "$name" }
    if ($n -eq '5') { return 'I-5' }
    if ($n -in @('12', '101')) { return "US $n" }
    return "SR $n"
}

$alerts = @()
foreach ($a in $raw) {
    $s = $a.StartRoadwayLocation; $e = $a.EndRoadwayLocation
    if (-not ((In-Box $s) -or (In-Box $e))) { continue }
    $p = if (In-Box $s) { $s } else { $e }
    $alerts += [ordered]@{
        id          = $a.AlertID
        kind        = Kind $a
        category    = $a.EventCategory
        priority    = $a.Priority
        headline    = $a.HeadlineDescription
        description = $a.ExtendedDescription
        road        = $s.RoadName
        roadLabel   = Road-Label $s.RoadName
        direction   = $s.Direction
        milepost    = $s.MilePost
        lat         = $p.Latitude
        lon         = $p.Longitude
        lat2        = $e.Latitude
        lon2        = $e.Longitude
        county      = $a.County
        start       = To-Iso $a.StartTime
        end         = To-Iso $a.EndTime
        updated     = To-Iso $a.LastUpdatedTime
    }
}

$now = [DateTimeOffset]::UtcNow
$dataDir = Join-Path $root 'data'
$histDir = Join-Path $dataDir 'history'
New-Item -ItemType Directory -Force $histDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

$out = [ordered]@{ updated = $now.ToString('o'); source = 'WSDOT Highway Alerts'; alerts = @($alerts) }
[IO.File]::WriteAllText((Join-Path $dataDir 'wsdot-alerts.json'), ($out | ConvertTo-Json -Depth 6), $utf8)

# compact history line: when, and what was active where
$line = [ordered]@{
    t = $now.ToString('o')
    a = @($alerts | ForEach-Object { [ordered]@{ id = $_.id; k = $_.kind; r = $_.roadLabel; mp = $_.milepost; p = $_.priority } })
} | ConvertTo-Json -Depth 4 -Compress
[IO.File]::AppendAllText((Join-Path $histDir ($now.ToString('yyyy-MM') + '.jsonl')), $line + "`n", $utf8)

"$($alerts.Count) alerts in region ($(@($raw).Count) statewide)"
