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
# the box is a rectangle; these corners are outside the area we cover (Chehalis/Centralia, Hood Canal)
function In-Area($lat, $lon) {
    if (-not (In-Box ([pscustomobject]@{ Latitude = $lat; Longitude = $lon }))) { return $false }
    if ($lon -gt -123.05 -and $lat -lt 46.76) { return $false }
    if ($lon -gt -123.30 -and $lat -gt 47.25) { return $false }
    return $true
}
function Loc-In-Area($loc) { return $loc -and $loc.Latitude -ne 0 -and (In-Area $loc.Latitude $loc.Longitude) }
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
    if (-not ((Loc-In-Area $s) -or (Loc-In-Area $e))) { continue }
    $p = if (Loc-In-Area $s) { $s } else { $e }
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

# ---------- road paths for alert stretches ----------
# WSDOT gives a start and end point; to draw the stretch along the highway we ask the public OSRM router once
# per stretch and keep the answer in data/paths.json, so each stretch is looked up only once.
$pathFile = Join-Path $dataDir 'paths.json'
$paths = @{}
if (Test-Path $pathFile) { (Get-Content $pathFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $paths[$_.Name] = $_.Value } }
function Km($lat1, $lon1, $lat2, $lon2) {
    $r = [math]::PI / 180; $dLat = ($lat2 - $lat1) * $r; $dLon = ($lon2 - $lon1) * $r
    $h = [math]::Pow([math]::Sin($dLat / 2), 2) + [math]::Cos($lat1 * $r) * [math]::Cos($lat2 * $r) * [math]::Pow([math]::Sin($dLon / 2), 2)
    return 12742 * [math]::Asin([math]::Sqrt($h))
}
$usedKeys = @{}
foreach ($al in $alerts) {
    if (-not $al.lat2 -or $al.lat2 -eq 0) { continue }
    $straight = Km $al.lat $al.lon $al.lat2 $al.lon2
    if ($straight -lt 0.15 -or $straight -gt 80) { continue }
    $key = '{0:F4},{1:F4};{2:F4},{3:F4}' -f $al.lon, $al.lat, $al.lon2, $al.lat2
    $usedKeys[$key] = $true
    if (-not $paths.ContainsKey($key)) {
        try {
            Start-Sleep -Milliseconds 1100   # the public router asks for at most one request a second
            $rt = Invoke-RestMethod "https://router.project-osrm.org/route/v1/driving/$($key)?overview=full&geometries=geojson" -TimeoutSec 30
            $route = $rt.routes[0]
            # a route much longer than the straight line means it detoured (e.g. wrong side of a divided highway)
            if ($route -and ($route.distance / 1000) -lt ($straight * 2 + 2)) {
                $pts = @($route.geometry.coordinates)
                $step = [math]::Max(1, [math]::Floor($pts.Count / 150))
                $keep = for ($i = 0; $i -lt $pts.Count; $i += $step) { , @([math]::Round($pts[$i][0], 5), [math]::Round($pts[$i][1], 5)) }
                $last = $pts[$pts.Count - 1]
                $paths[$key] = @($keep) + , @([math]::Round($last[0], 5), [math]::Round($last[1], 5))
            } else { $paths[$key] = @(@($al.lon, $al.lat), @($al.lon2, $al.lat2)) }
        } catch { "path lookup failed: $($_.Exception.Message)" }
    }
    if ($paths.ContainsKey($key)) { $al.path = $paths[$key] }
}
# forget stretches whose alerts are gone
$kept = [ordered]@{}; foreach ($k in $usedKeys.Keys) { if ($paths.ContainsKey($k)) { $kept[$k] = $paths[$k] } }
[IO.File]::WriteAllText($pathFile, ($kept | ConvertTo-Json -Depth 5 -Compress), $utf8)

function Save($name, $obj) {
    [IO.File]::WriteAllText((Join-Path $dataDir $name), ($obj | ConvertTo-Json -Depth 6), $utf8)
}
Save 'wsdot-alerts.json' ([ordered]@{ updated = $now.ToString('o'); source = 'WSDOT Highway Alerts'; alerts = @($alerts) })
"$($alerts.Count) alerts in region ($(@($raw).Count) statewide)"

# ---------- the other WSDOT feeds; one failing never stops the rest ----------
$base = 'https://wsdot.wa.gov/Traffic/api'
function Wsdot($path) { $x = Invoke-RestMethod -Uri "$base/$($path)?AccessCode=$code" -TimeoutSec 60; foreach ($i in $x) { $i } }

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

# ---------- marine: Grays Harbor wave buoy, NWS bar forecast, marine alerts (no key needed) ----------
try {
    $marine = [ordered]@{ updated = $now.ToString('o') }
    $nwsHeaders = @{ 'User-Agent' = 'harbor-traffic (traffic.harborevents.org)'; Accept = 'application/ld+json' }
    # NDBC 46211 (Grays Harbor, CDIP 036): newest line with a wave height. MM = missing.
    try {
        $lines = (Invoke-WebRequest -UseBasicParsing 'https://www.ndbc.noaa.gov/data/realtime2/46211.txt' -TimeoutSec 30).Content -split "`n" | Where-Object { $_ -and $_ -notmatch '^#' }
        foreach ($ln in $lines) {
            $f = $ln -split '\s+'
            if ($f[8] -eq 'MM') { continue }
            $num = { param($v) if ($v -eq 'MM') { $null } else { [double]$v } }
            $wt = & $num $f[14]
            $marine.buoy = [ordered]@{
                station = '46211'; name = 'Grays Harbor buoy'
                time    = ([DateTimeOffset]::new([int]$f[0], [int]$f[1], [int]$f[2], [int]$f[3], [int]$f[4], 0, [TimeSpan]::Zero)).ToString('o')
                waveFt  = [math]::Round((& $num $f[8]) * 3.28084, 1)
                periodS = & $num $f[9]
                dirDeg  = & $num $f[11]
                waterF  = if ($wt -ne $null) { [math]::Round($wt * 9 / 5 + 32, 1) } else { $null }
            }
            break
        }
    } catch { "buoy failed: $($_.Exception.Message)" }
    # NWS Coastal Waters Forecast (Seattle office): the Grays Harbor Bar section
    try {
        $list = Invoke-RestMethod 'https://api.weather.gov/products/types/CWF/locations/SEW' -Headers $nwsHeaders -TimeoutSec 30
        $prod = Invoke-RestMethod "https://api.weather.gov/products/$($list.'@graph'[0].id)" -Headers $nwsHeaders -TimeoutSec 30
        $txt = $prod.productText -replace "`r", ''
        if ($txt -match '(?s)Grays Harbor Bar-\n[^\n]*\n\n(.*?)\n\$\$') {
            $body = ($Matches[1] -replace '\s*\n\s*', ' ').Trim()
            $marine.bar = [ordered]@{
                issued = $prod.issuanceTime
                text   = $body
                conditions = if ($body -match '(?i)Bar conditions ([^.]+)\.') { $Matches[1].Trim() } else { $null }
                seas   = if ($body -match '(?i)Combined seas ([^.]+)\.') { $Matches[1].Trim() } else { $null }
                ebb    = if ($body -match '(?i)((?:The )?(?:morning|afternoon|evening|night)? ?ebb[^.]*(?:very strong|strong)[^.]*)\.') { $Matches[1].Trim() } else { $null }
            }
        }
    } catch { "bar forecast failed: $($_.Exception.Message)" }
    # marine alerts touching our stretch of coast
    try {
        $ma = Invoke-RestMethod 'https://api.weather.gov/alerts/active?area=PZ' -Headers @{ 'User-Agent' = $nwsHeaders.'User-Agent'; Accept = 'application/geo+json' } -TimeoutSec 30
        $marine.alerts = @($ma.features | Where-Object { $_.properties.areaDesc -match 'Grays Harbor|Point Grenville|Cape Shoalwater|Destruction Island|Willapa' } | ForEach-Object {
            [ordered]@{ event = $_.properties.event; area = $_.properties.areaDesc; ends = $_.properties.ends; headline = $_.properties.headline }
        })
    } catch { "marine alerts failed: $($_.Exception.Message)" }
    Save 'marine.json' $marine
    "marine: waves $($marine.buoy.waveFt) ft, bar $($marine.bar.conditions)"
} catch { "marine failed: $($_.Exception.Message)" }

# ---------- ships (AIS via aisstream.io): listen to the live stream for a bit, keep ships heard in the last 3 hours ----------
$aisKey = $env:AISSTREAM_KEY
if (-not $aisKey) { $kf = Join-Path $root 'aisstream-key.txt'; if (Test-Path $kf) { $aisKey = (Get-Content $kf -Raw).Trim() } }
if ($aisKey) {
    $shipFile = Join-Path $dataDir 'ships.json'
    $ships = @{}
    if (Test-Path $shipFile) {
        try { foreach ($s in (Get-Content $shipFile -Raw | ConvertFrom-Json).ships) { $ships["$($s.mmsi)"] = $s } } catch {}
    }
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $heard = 0
    try {
        $cts = New-Object System.Threading.CancellationTokenSource
        $cts.CancelAfter([TimeSpan]::FromSeconds(80))
        $ws.ConnectAsync([Uri]'wss://stream.aisstream.io/v0/stream', $cts.Token).Wait()
        # a little offshore plus Grays Harbor and Willapa Bay (about 15 nm out from the entrances): [[lat, lon], [lat, lon]]
        $sub = @{ APIKey = $aisKey; BoundingBoxes = @(, @(@(46.35, -124.5), @(47.2, -123.7)));
            FilterMessageTypes = @('PositionReport', 'StandardClassBPositionReport', 'ShipStaticData') } | ConvertTo-Json -Depth 6 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($sub)
        $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait()
        $buf = New-Object byte[] 65536
        $until = (Get-Date).AddSeconds(70)
        while ((Get-Date) -lt $until -and $ws.State -eq 'Open') {
            $ms = New-Object System.IO.MemoryStream
            do {
                $t = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token)
                if (-not $t.Wait(15000)) { throw 'quiet' }
                $ms.Write($buf, 0, $t.Result.Count)
            } until ($t.Result.EndOfMessage)
            $m = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
            $meta = $m.MetaData; if (-not $meta) { continue }
            $id = "$($meta.MMSI)"; $heard++
            $s = $ships[$id]; if (-not $s) { $s = [pscustomobject]@{ mmsi = $meta.MMSI } ; $ships[$id] = $s }
            $set = { param($k, $v) if ($null -ne $v -and "$v" -ne '') { $s | Add-Member -NotePropertyName $k -NotePropertyValue $v -Force } }
            & $set 'name' ("$($meta.ShipName)".Trim())
            if ($m.MessageType -eq 'ShipStaticData') {
                $d = $m.Message.ShipStaticData
                & $set 'type' $d.Type; & $set 'dest' ("$($d.Destination)".Trim()); & $set 'callsign' ("$($d.CallSign)".Trim())
                if ([int64]$d.ImoNumber -ge 1000000) { & $set 'imo' ([int64]$d.ImoNumber) }
                if ($d.Dimension) { & $set 'lengthM' ([int]$d.Dimension.A + [int]$d.Dimension.B); if ([int]$d.Dimension.C + [int]$d.Dimension.D -gt 0) { & $set 'beamM' ([int]$d.Dimension.C + [int]$d.Dimension.D) } }
                # how deep it sits (deeper = loaded): with size, a way to learn which ships here mean trains
                if ([double]$d.MaximumStaticDraught -gt 0) { & $set 'draughtM' ([double]$d.MaximumStaticDraught) }
            } else {
                $p = if ($m.MessageType -eq 'PositionReport') { $m.Message.PositionReport } else { $m.Message.StandardClassBPositionReport }
                & $set 'lat' ([math]::Round([double]$meta.latitude, 5)); & $set 'lon' ([math]::Round([double]$meta.longitude, 5))
                & $set 'sog' $p.Sog; & $set 'cog' $p.Cog
                & $set 'heading' $(if ($p.TrueHeading -ne $null -and $p.TrueHeading -lt 360) { $p.TrueHeading } else { $null })
                & $set 'status' $p.NavigationalStatus
                & $set 'classB' ($m.MessageType -ne 'PositionReport')
                & $set 'seen' $now.ToString('o')
            }
        }
    } catch { if ("$_" -notmatch 'quiet') { "ships: $($_.Exception.Message.Split("`n")[0])" } }
    finally { try { $ws.Dispose() } catch {} }
    $cutoff = $now.AddHours(-3)
    $keep = @($ships.Values | Where-Object { $_.lat -and $_.seen -and [DateTimeOffset]::Parse($_.seen) -gt $cutoff })
    Save 'ships.json' ([ordered]@{ updated = $now.ToString('o'); source = 'AIS via aisstream.io'; ships = $keep })
    "ships: $($keep.Count) on the map ($heard messages this run)"

    # every boat ever heard here, kept for good (for naming your own photos, and finding free photos of each)
    $regFile = Join-Path $dataDir 'ship-registry.json'
    $reg = [ordered]@{}
    if (Test-Path $regFile) { try { foreach ($p in (Get-Content $regFile -Raw | ConvertFrom-Json).ships.PSObject.Properties) { $reg[$p.Name] = $p.Value } } catch {} }
    foreach ($s in $ships.Values) {
        if (-not $s.name) { continue }
        $id = "$($s.mmsi)"; $r = $reg[$id]
        if (-not $r) { $r = [pscustomobject]@{ name = $s.name; first = $now.ToString('o') }; $reg[$id] = $r }
        foreach ($k in 'name', 'type', 'callsign', 'imo', 'lengthM', 'beamM', 'draughtM') { if ($null -ne $s.$k -and "$($s.$k)" -ne '') { $r | Add-Member -NotePropertyName $k -NotePropertyValue $s.$k -Force } }
        if ($s.seen) { $r | Add-Member -NotePropertyName 'last' -NotePropertyValue $s.seen -Force }
    }
    Save 'ship-registry.json' ([ordered]@{ updated = $now.ToString('o'); source = 'AIS via aisstream.io'; ships = $reg })

    # free photos of those boats from Wikimedia Commons, a few boats a run, each looked up again monthly. Commons
    # files ships under "IMO 1234567" (big ships) and "Name (tugboat, 1966)" style categories, which are reliable;
    # a plain name search finds too much else. Nothing shows on the map until it's approved on the stats page.
    $candFile = Join-Path $dataDir 'ship-photo-candidates.json'
    $cand = [ordered]@{ looked = [ordered]@{}; candidates = @() }
    if (Test-Path $candFile) { try { $c = Get-Content $candFile -Raw | ConvertFrom-Json
        foreach ($p in $c.looked.PSObject.Properties) { $cand.looked[$p.Name] = $p.Value }; $cand.candidates = @($c.candidates) } catch {} }
    $wm = @{ 'User-Agent' = 'harbor-traffic/1.0 (traffic.harborevents.org; ship photos)' }
    $wmApi = 'https://commons.wikimedia.org/w/api.php?format=json&'
    $due = @($reg.Keys | Where-Object { $l = $cand.looked[$_]; -not $l -or ($now - [DateTimeOffset]::Parse($l)).TotalDays -gt 30 } |
        Sort-Object { $r = $reg[$_]; if ($r.last) { [DateTimeOffset]::Parse($r.last).UtcTicks } else { 0 } } -Descending | Select-Object -First 3)
    foreach ($id in $due) {
        $r = $reg[$id]
        try {
            $cats = @()
            # "IMO 1234567" usually holds the ship's own category ("Emma Mærsk (ship, 2006)", spelled properly), sometimes files
            if ($r.imo) { $imoCat = "Category:IMO $($r.imo)"
                $q = Invoke-RestMethod "$($wmApi)action=query&list=categorymembers&cmtype=subcat|file&cmlimit=20&cmtitle=$([uri]::EscapeDataString($imoCat))" -Headers $wm -TimeoutSec 20
                $mem = @($q.query.categorymembers)
                if ($mem | Where-Object { $_.ns -eq 6 }) { $cats += $imoCat }
                $cats += @($mem | Where-Object { $_.ns -eq 14 -and $_.title -match '\((ship|tugboat|tug|towboat|boat|vessel)\b' } | ForEach-Object { $_.title }) }
            # a name category for a vessel: exactly its name, then "(ship, ...)", "(tugboat, ...)" and so on
            $nm = ("$($r.name)" -replace '\s+', ' ').Trim()
            if (($nm -replace '[^A-Za-z]', '').Length -ge 5) {
                $srch = [uri]::EscapeDataString('intitle:"' + $nm + '"')
                $q = Invoke-RestMethod "$($wmApi)action=query&list=search&srnamespace=14&srlimit=10&srsearch=$srch" -Headers $wm -TimeoutSec 20
                $pat = '^Category:' + [regex]::Escape($nm) + ' \((ship|tugboat|tug|towboat|boat|vessel|fishing vessel|trawler|ferry|barge|dredger|research vessel|yacht)\b[^)]*\)$'
                $cats += @($q.query.search | ForEach-Object { $_.title } | Where-Object { $_ -match $pat })
            }
            $titles = @()
            foreach ($cat in ($cats | Select-Object -Unique)) {
                $q = Invoke-RestMethod "$($wmApi)action=query&list=categorymembers&cmtype=file&cmlimit=12&cmtitle=$([uri]::EscapeDataString($cat))" -Headers $wm -TimeoutSec 20
                $titles += @($q.query.categorymembers | ForEach-Object { $_.title })
            }
            $titles = @($titles | Select-Object -Unique | Where-Object { $t = $_; -not ($cand.candidates | Where-Object { $_.file -eq $t -and "$($_.mmsi)" -eq $id }) } | Select-Object -First 8)
            if ($titles.Count) {
                $q = Invoke-RestMethod "$($wmApi)action=query&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=1280&titles=$([uri]::EscapeDataString($titles -join '|'))" -Headers $wm -TimeoutSec 30
                foreach ($p in $q.query.pages.PSObject.Properties.Value) {
                    $i = $p.imageinfo[0]; if (-not $i -or $i.mime -notmatch '^image/(jpeg|png|webp)$') { continue }
                    $m = $i.extmetadata; $strip = { param($v) (("$v" -replace '<[^>]+>', ' ') -replace '\s+', ' ').Trim() }
                    $desc = & $strip $m.ImageDescription.value; if ($desc.Length -gt 220) { $desc = $desc.Substring(0, 217) + '...' }
                    $cand.candidates += [pscustomobject]@{ mmsi = $id; ship = $r.name; file = $p.title; page = $i.descriptionurl; thumb = $i.thumburl
                        w = [int]$i.thumbwidth; h = [int]$i.thumbheight; author = (& $strip $m.Artist.value); license = "$($m.LicenseShortName.value)"
                        licenseUrl = "$($m.LicenseUrl.value)"; date = (& $strip $m.DateTimeOriginal.value) -replace 'date QS:.*$', ''; caption = $desc; found = $now.ToString('o') }
                }
            }
            $cand.looked[$id] = $now.ToString('o')
        } catch {
            "ship photos for $($r.name): $($_.Exception.Message.Split("`n")[0])"
            if ("$($_.Exception.Message)" -match '429|Too Many') { break } # Commons asked us to slow down: try again next run
        }
        Start-Sleep -Milliseconds 400 # (gentle on Commons)
    }
    $cand.updated = $now.ToString('o')
    Save 'ship-photo-candidates.json' $cand
    if ($due.Count) { "ship photos: looked up $($due.Count) boat(s); $(@($cand.candidates).Count) photo(s) found so far" }
}

# ---------- Grays Harbor Transit service alerts (their Service Alerts page, via its WordPress API) ----------
try {
    # their API is closed to outside requests, so this reads the page itself
    $html = (Invoke-WebRequest -UseBasicParsing 'https://ghtransit.com/alerts/' -TimeoutSec 30).Content -replace '<script[\s\S]*?</script>', '' -replace '<style[\s\S]*?</style>', ''
    $plain = ($html -replace '<(br|/p|/h\d|/li|/div)[^>]*>', "`n" -replace '<[^>]+>', '' -replace '&#8217;', "'" -replace '&#8211;', '-' -replace '&amp;', '&' -replace '&nbsp;', ' ')
    $lines = @($plain -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $status = @($lines | Where-Object { $_ -match '(?i)operating normally|detour|suspended|cancel' } | Select-Object -First 1)
    # the notices sit between the boilerplate intro and the "Find your ride" section
    $start = [array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -match '(?i)real-time notices' })
    $end = [array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -match '(?i)^Find your ride' })
    $notice = if ($start -ge 0) { @($lines[($start + 1)..($(if ($end -gt $start) { $end - 1 } else { $lines.Count - 1 }))]) } else { @() }
    $alerts = @()
    if ($notice.Count) {
        $route = if ($notice[0] -match '^\d+[A-Z]?$') { $notice[0] } else { $null }
        $name = if ($route -and $notice.Count -gt 1) { $notice[1] } else { $null }
        $body = @($notice | Select-Object -Skip $(if ($route) { 2 } else { 0 })) -join ' '
        $alerts += [ordered]@{ route = $route; name = $name; text = ($body -replace '\s+\.', '.' -replace '\s{2,}', ' ').Trim() }
    }
    Save 'bus-alerts.json' ([ordered]@{ updated = $now.ToString('o'); status = "$($status[0])"; alerts = $alerts; source = 'https://ghtransit.com/alerts/' })
    "bus alerts: $($alerts.Count) ($($status[0]))"
} catch { "bus alerts failed: $($_.Exception.Message.Split("`n")[0])" }

# ---------- bus routes and stops from GHT's schedule data: once a week ----------
$busRoutes = Join-Path $dataDir 'bus-routes.json'
# (judged by the date inside the file: a fresh checkout makes every file look new, so it never ran here before)
$busOld = $true
if (Test-Path $busRoutes) { try { $u = (Get-Content $busRoutes -Raw | ConvertFrom-Json).updated; if ($u) { $busOld = ((Get-Date) - [datetime]$u).TotalDays -gt 7 } } catch {} }
if ($busOld) {
    try { & (Join-Path $PSScriptRoot 'build-gtfs.ps1') } catch { "bus routes failed: $($_.Exception.Message.Split("`n")[0])" }
}

# ---------- aircraft (ADS-B via adsb.lol, no key): low and local only; airliners at cruise don't matter here ----------
try {
    $ac = Invoke-RestMethod 'https://api.adsb.lol/v2/point/47.2/-123.65/55' -UserAgent 'harbor-traffic/1.0 (traffic.harborevents.org)' -TimeoutSec 30
    $planes = @($ac.ac | Where-Object {
        $_.lat -and $_.lon -and $_.lat -gt 46.5 -and $_.lat -lt 48.0 -and $_.lon -gt -124.6 -and $_.lon -lt -122.7 -and
        ($_.alt_baro -eq 'ground' -or ([double]$_.alt_baro) -le 15000)
    } | ForEach-Object { [ordered]@{
        hex = $_.hex; flight = "$($_.flight)".Trim(); reg = $_.r; type = $_.t; cat = $_.category
        alt = if ($_.alt_baro -eq 'ground') { 0 } else { [int]$_.alt_baro }; gs = $_.gs; track = $_.track; rate = $_.baro_rate
        lat = [math]::Round($_.lat, 5); lon = [math]::Round($_.lon, 5); squawk = $_.squawk; emergency = $_.emergency
        mil = [bool](([int]$_.dbFlags) -band 1)
    } })
    Save 'aircraft.json' ([ordered]@{ updated = $now.ToString('o'); source = 'ADS-B via adsb.lol'; aircraft = $planes })
    "aircraft: $($planes.Count) low and local"
} catch { "aircraft failed: $($_.Exception.Message.Split("`n")[0])" }

# ---------- rail crossings from OpenStreetMap: once a week is plenty (they rarely change) ----------
$crossFile = Join-Path $dataDir 'crossings.json'
$crossOld = -not (Test-Path $crossFile) -or ((Get-Date) - (Get-Item $crossFile).LastWriteTime).TotalDays -gt 7 -or
    ((Get-Content $crossFile -Raw) -match '"crossings":\s*\[\s*\]')
if ($crossOld) {
    $q = '[out:json][timeout:90];node["railway"="level_crossing"](46.6,-124.45,47.2,-122.8)->.c;.c out body;way(bn.c)[highway];out body;'
    foreach ($server in 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter') {
        try {
            $r = Invoke-RestMethod -Method Post -Uri $server -Body @{ data = $q } -UserAgent 'harbor-traffic/1.0 (traffic.harborevents.org)' -Headers @{ Accept = 'application/json' } -TimeoutSec 120
            $roadOf = @{}
            foreach ($w in @($r.elements | Where-Object type -eq 'way')) {
                $nm = if ($w.tags.name) { $w.tags.name } elseif ($w.tags.ref) { $w.tags.ref } else { $null }
                if ($nm) { foreach ($nd in $w.nodes) { if (-not $roadOf["$nd"]) { $roadOf["$nd"] = $nm } } }
            }
            $cx = @($r.elements | Where-Object type -eq 'node' | ForEach-Object {
                [ordered]@{ id = $_.id; lat = [math]::Round($_.lat, 6); lon = [math]::Round($_.lon, 6); road = $roadOf["$($_.id)"]; kind = 'level_crossing' } })
            if ($cx.Count) { Save 'crossings.json' ([ordered]@{ source = 'OpenStreetMap contributors (ODbL)'; updated = $now.ToString('o'); crossings = $cx }); "$($cx.Count) rail crossings"; break }
        } catch { "crossings from $server failed: $($_.Exception.Message.Split("`n")[0])" }
    }
}

# ---------- traffic signals from OpenStreetMap, for the bus chase view: once a week ----------
# (judged by the date inside the file: a fresh checkout makes every file look new)
$sigFile = Join-Path $dataDir 'signals.json'
$sigOld = $true
if (Test-Path $sigFile) { try { $sigOld = ((Get-Date) - [datetime](Get-Content $sigFile -Raw | ConvertFrom-Json).updated).TotalDays -gt 7 } catch {} }
if ($sigOld) {
    $q = '[out:json][timeout:90];node["highway"="traffic_signals"](46.6,-124.45,47.92,-122.8);out skel;'
    foreach ($server in 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter') {
        try {
            $r = Invoke-RestMethod -Method Post -Uri $server -Body @{ data = $q } -UserAgent 'harbor-traffic/1.0 (traffic.harborevents.org)' -Headers @{ Accept = 'application/json' } -TimeoutSec 120
            $sg = @($r.elements | Where-Object type -eq 'node' | ForEach-Object { , @([math]::Round($_.lon, 5), [math]::Round($_.lat, 5)) })
            if ($sg.Count) { Save 'signals.json' ([ordered]@{ source = 'OpenStreetMap contributors (ODbL)'; updated = $now.ToString('o'); signals = $sg }); "$($sg.Count) traffic signals"; break }
        } catch { "signals from $server failed: $($_.Exception.Message.Split("`n")[0])" }
    }
}

# compact history line for the "worst times" report:
# a = active alerts, f = I-5 sensors per level [open, moderate, heavy, stop-and-go] by direction, tt = travel minutes by route id
$line = [ordered]@{
    t  = $now.ToString('o')
    a  = @($alerts | ForEach-Object { [ordered]@{ id = $_.id; k = $_.kind; r = $_.roadLabel; mp = $_.milepost; p = $_.priority } })
    f  = $flowSummary
    tt = $ttSummary
} | ConvertTo-Json -Depth 5 -Compress
[IO.File]::AppendAllText((Join-Path $histDir ($now.ToString('yyyy-MM') + '.jsonl')), $line + "`n", $utf8)
