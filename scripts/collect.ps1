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
$boxW = -124.55; $boxS = 46.60; $boxE = -122.78; $boxN = 48.00

$url = "https://wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson?AccessCode=$code"
$raw = Invoke-RestMethod -Uri $url -TimeoutSec 60

function To-Iso($s) {
    # Windows PowerShell turns the date strings into DateTime by itself; pwsh leaves them as text
    if ($s -is [datetime]) { return ([DateTimeOffset]$s.ToUniversalTime()).ToString('o') }
    if ($s -and "$s" -match '(-?\d{10,})') { return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Matches[1]).ToString('o') }
    return $null
}
function In-Box($loc) {
    return $loc -and $loc.Latitude -ne 0 -and $loc.Longitude -ge $boxW -and $loc.Longitude -le $boxE -and $loc.Latitude -ge $boxS -and $loc.Latitude -le $boxN
}
function Kind($a) {
    $txt = "$($a.EventCategory) $($a.HeadlineDescription)"
    if ($txt -match '(?i)collision|crash|disabled vehicle|incident') { return 'collision' }
    # a lane or shoulder closure is road work; the road itself being shut is a closure
    if ($txt -match '(?i)\b(lane|shoulder|ramp)s?\b[^.]{0,60}\bclos'){ return 'work' }
    if ($txt -match '(?i)\b(is|are|will be) closed\b|fully? clos|around-the-clock closures|road closed|blocked|detour') { return 'closure' }
    if ($txt -match '(?i)construction|maintenance|road work|paving|lane') { return 'work' }
    return 'other'
}
function Plain($html) {
    $t = "$html" -replace '<[^>]+>', '' -replace '&nbsp;', ' ' -replace '&amp;', '&' -replace '\s*\r?\n\s*', ' '
    return $t.Trim()
}
function First-Link($html) {
    if ("$html" -match 'href="([^"]+)"') { return $Matches[1] }
    return $null
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
        headline    = Plain $a.HeadlineDescription
        description = Plain $a.ExtendedDescription
        link        = First-Link "$($a.HeadlineDescription) $($a.ExtendedDescription)"
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

function Save($name, $obj) {
    [IO.File]::WriteAllText((Join-Path $dataDir $name), ($obj | ConvertTo-Json -Depth 6), $utf8)
}
Save 'wsdot-alerts.json' ([ordered]@{ updated = $now.ToString('o'); source = 'WSDOT Highway Alerts'; alerts = @($alerts) })
"$($alerts.Count) alerts in region ($(@($raw).Count) statewide)"

# ---------- the other WSDOT feeds; one failing never stops the rest ----------
$base = 'https://wsdot.wa.gov/Traffic/api'
function Wsdot($path) { $x = Invoke-RestMethod -Uri "$base/$($path)?AccessCode=$code" -TimeoutSec 60; foreach ($i in $x) { $i } }
# the box is a rectangle; these corners are outside the area we cover (Chehalis/Centralia, Hood Canal)
function In-Area($lat, $lon) {
    if (-not (In-Box ([pscustomobject]@{ Latitude = $lat; Longitude = $lon }))) { return $false }
    if ($lon -gt -123.05 -and $lat -lt 46.76) { return $false }
    if ($lon -gt -123.30 -and $lat -gt 47.25) { return $false }
    return $true
}

# cameras: just the list; the page loads an image only when someone clicks it
$flowSummary = $null
try {
    $cams = @(Wsdot 'HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson' | Where-Object {
        $_.IsActive -and $_.CameraOwner -notmatch 'Aviation' -and $_.Title -notmatch 'Airport' -and
        (In-Area $_.CameraLocation.Latitude $_.CameraLocation.Longitude)
    } | Sort-Object CameraID | ForEach-Object { [ordered]@{
        id = $_.CameraID; title = $_.Title; img = $_.ImageURL
        road = Road-Label $_.CameraLocation.RoadName; mp = $_.CameraLocation.MilePost
        lat = $_.CameraLocation.Latitude; lon = $_.CameraLocation.Longitude
    } })
    # rewrite only when the list changes, so the repo doesn't get a new copy every 10 minutes
    $json = ([ordered]@{ source = 'WSDOT Highway Cameras'; cameras = $cams } | ConvertTo-Json -Depth 6)
    $f = Join-Path $dataDir 'cameras.json'
    if (-not (Test-Path $f) -or [IO.File]::ReadAllText($f) -ne $json) { [IO.File]::WriteAllText($f, $json, $utf8) }
    "$($cams.Count) cameras"
} catch { "cameras failed: $($_.Exception.Message)" }

# roadside weather stations (actual readings on the highway, e.g. Cosmopolis Hill)
try {
    $st = @(Wsdot 'WeatherInformation/WeatherInformationREST.svc/GetCurrentWeatherInformationAsJson' |
        Where-Object { In-Area $_.Latitude $_.Longitude } | ForEach-Object { [ordered]@{
            id = $_.StationID; name = ($_.StationName -replace ' at mp [\d.]+$', ''); lat = $_.Latitude; lon = $_.Longitude
            temp = $_.TemperatureInFahrenheit; wind = $_.WindSpeedInMPH; gust = $_.WindGustSpeedInMPH; dir = $_.WindDirectionCardinal
            vis = $_.Visibility; precip = $_.PrecipitationInInches; humidity = $_.RelativeHumidity; time = To-Iso $_.ReadingTime
        } })
    Save 'road-weather.json' ([ordered]@{ updated = $now.ToString('o'); source = 'WSDOT Weather Stations'; stations = $st })
    "$($st.Count) road weather stations"
} catch { "road weather failed: $($_.Exception.Message)" }

# live traffic sensors (only I-5 has them here). value: 0 no data, 1 wide open, 2 moderate, 3 heavy, 4 stop and go
try {
    $fl = @(Wsdot 'TrafficFlow/TrafficFlowREST.svc/GetTrafficFlowsAsJson' |
        Where-Object { In-Area $_.FlowStationLocation.Latitude $_.FlowStationLocation.Longitude } | ForEach-Object {
            $l = $_.FlowStationLocation
            , @([math]::Round($l.Latitude, 5), [math]::Round($l.Longitude, 5), [int]$_.FlowReadingValue, $l.MilePost, "$($l.Direction)", (Road-Label $l.RoadName))
        })
    Save 'flow.json' ([ordered]@{ updated = $now.ToString('o'); source = 'WSDOT Traffic Flow'; fields = 'lat,lon,level,milepost,direction,road'; stations = $fl })
    $flowSummary = [ordered]@{}
    foreach ($g in ($fl | Group-Object { "$($_[5]) $($_[4])" })) {
        $flowSummary[$g.Name] = @(1..4 | ForEach-Object { $lv = $_; @($g.Group | Where-Object { $_[2] -eq $lv }).Count })
    }
    "$($fl.Count) flow sensors"
} catch { "flow failed: $($_.Exception.Message)" }

# travel times touching the area (Olympia/Lacey/Tacoma)
$ttSummary = $null
try {
    $tt = @(Wsdot 'TravelTimes/TravelTimesREST.svc/GetTravelTimesAsJson' |
        Where-Object { (In-Area $_.StartPoint.Latitude $_.StartPoint.Longitude) -or (In-Area $_.EndPoint.Latitude $_.EndPoint.Longitude) } |
        ForEach-Object { [ordered]@{ id = $_.TravelTimeID; name = $_.Name; now = $_.CurrentTime; avg = $_.AverageTime; miles = $_.Distance; time = To-Iso $_.TimeUpdated } })
    Save 'travel-times.json' ([ordered]@{ updated = $now.ToString('o'); source = 'WSDOT Travel Times'; routes = $tt })
    $ttSummary = [ordered]@{}; foreach ($x in $tt) { $ttSummary["$($x.id)"] = $x.now }
    "$($tt.Count) travel times"
} catch { "travel times failed: $($_.Exception.Message)" }

# compact history line for the "worst times" report:
# a = active alerts, f = I-5 sensors per level [open, moderate, heavy, stop-and-go] by direction, tt = travel minutes by route id
$line = [ordered]@{
    t  = $now.ToString('o')
    a  = @($alerts | ForEach-Object { [ordered]@{ id = $_.id; k = $_.kind; r = $_.roadLabel; mp = $_.milepost; p = $_.priority } })
    f  = $flowSummary
    tt = $ttSummary
} | ConvertTo-Json -Depth 5 -Compress
[IO.File]::AppendAllText((Join-Path $histDir ($now.ToString('yyyy-MM') + '.jsonl')), $line + "`n", $utf8)
