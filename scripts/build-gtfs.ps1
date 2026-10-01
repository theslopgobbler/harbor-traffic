<#
  Grays Harbor Transit's published schedule data (GTFS) -> map files:
    data/bus-routes.json  one line per route shape, with the route's number, name and official color
    data/bus-stops.json   every stop, with the routes that serve it
    data/bus-times.json   every scheduled departure from every stop (route, time, headed to, which days)
  Run by the collector once a week (schedules rarely change); safe to run by hand.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dataDir = Join-Path $root 'data'
$tmp = Join-Path ([IO.Path]::GetTempPath()) 'ght-gtfs'
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp 'ght.zip'
Invoke-WebRequest -UseBasicParsing 'http://mjcaction.com/MJC_GTFS_Public/graysharbor_google_transit.zip' -OutFile $zip -TimeoutSec 120
Expand-Archive $zip -DestinationPath $tmp -Force
$csv = { param($n) Import-Csv (Join-Path $tmp "$n.txt") }

$routes = @{}; foreach ($r in & $csv 'routes') { $routes[$r.route_id] = $r }
# which shapes and which stops belong to which route
$shapeRoute = @{}; $tripRoute = @{}; $trips = @{}
foreach ($t in & $csv 'trips') { $tripRoute[$t.trip_id] = $t.route_id; $trips[$t.trip_id] = $t; if ($t.shape_id) { $shapeRoute[$t.shape_id] = $t.route_id } }
# service days (weekday / weekend / every day), with holidays off
$services = New-Object System.Collections.Generic.List[object]; $svcIndex = @{}
foreach ($c in & $csv 'calendar') {
    $svcIndex[$c.service_id] = $services.Count
    $services.Add([ordered]@{ d = "$($c.monday)$($c.tuesday)$($c.wednesday)$($c.thursday)$($c.friday)$($c.saturday)$($c.sunday)"; s = $c.start_date; e = $c.end_date; x = @() })
}
if (Test-Path (Join-Path $tmp 'calendar_dates.txt')) {
    foreach ($cd in & $csv 'calendar_dates') { $i = $svcIndex[$cd.service_id]; if ($null -ne $i -and $cd.exception_type -eq '2') { $services[$i].x += $cd.date } }
}
$heads = New-Object System.Collections.Generic.List[string]; $headIndex = @{}
$stopRoutes = @{}; $stopTimes = @{}; $tripSpan = @{}
# Some stops have no time of their own (only the main stops do); those get one in between the stops around
# them on the same trip, in proportion to the distance along the route
$byTrip = @{}
foreach ($st in & $csv 'stop_times') {
    if (-not $byTrip[$st.trip_id]) { $byTrip[$st.trip_id] = New-Object System.Collections.Generic.List[object] }
    $byTrip[$st.trip_id].Add($st)
}
$toMin = { param($t) if (-not $t) { return $null }; $p = $t.Split(':'); [double]([int]$p[0] * 60 + [int]$p[1] + [int]$p[2] / 60) }
$filled = foreach ($tid in $byTrip.Keys) {
    $rows = @($byTrip[$tid] | Sort-Object { [int]$_.stop_sequence })
    $mins = @($rows | ForEach-Object { & $toMin $(if ($_.departure_time) { $_.departure_time } else { $_.arrival_time }) })
    $dist = @($rows | ForEach-Object { if ($_.shape_dist_traveled) { [double]$_.shape_dist_traveled } else { $null } })
    for ($i = 0; $i -lt $rows.Count; $i++) {
        if ($null -eq $mins[$i]) {
            $a = $i - 1; while ($a -ge 0 -and $null -eq $mins[$a]) { $a-- }
            $b = $i + 1; while ($b -lt $rows.Count -and $null -eq $mins[$b]) { $b++ }
            if ($a -ge 0 -and $b -lt $rows.Count) {
                $f = if ($null -ne $dist[$a] -and $null -ne $dist[$b] -and $null -ne $dist[$i] -and $dist[$b] -gt $dist[$a]) { ($dist[$i] - $dist[$a]) / ($dist[$b] - $dist[$a]) } else { ($i - $a) / ($b - $a) }
                $rows[$i] | Add-Member -NotePropertyName est -NotePropertyValue ($mins[$a] + ($mins[$b] - $mins[$a]) * $f) -Force
            }
        } else { $rows[$i] | Add-Member -NotePropertyName est -NotePropertyValue $mins[$i] -Force }
        $rows[$i]
    }
}
foreach ($st in $filled) {
    $rid = $tripRoute[$st.trip_id]; if (-not $rid) { continue }
    if (-not $stopRoutes[$st.stop_id]) { $stopRoutes[$st.stop_id] = New-Object System.Collections.Generic.HashSet[string] }
    [void]$stopRoutes[$st.stop_id].Add($routes[$rid].route_short_name)
    # each departure from each stop: route, minutes after midnight, where it's headed, which days
    if ($null -eq $st.est) { continue }
    $min = [int][math]::Round($st.est)
    $trip = $trips[$st.trip_id]
    $h = if ($st.stop_headsign) { $st.stop_headsign } else { $trip.trip_headsign }
    if ($null -eq $headIndex[$h]) { $headIndex[$h] = $heads.Count; $heads.Add($h) }
    $svc = $svcIndex[$trip.service_id]; if ($null -eq $svc) { continue }
    if (-not $stopTimes[$st.stop_id]) { $stopTimes[$st.stop_id] = New-Object System.Collections.Generic.List[object] }
    $stopTimes[$st.stop_id].Add(@($routes[$rid].route_short_name, $min, $headIndex[$h], $svc))
    # first and last time of each trip, for the route's typical speed
    $sp = $tripSpan[$st.trip_id]
    if (-not $sp) { $tripSpan[$st.trip_id] = @($min, $min) } else { if ($min -lt $sp[0]) { $sp[0] = $min }; if ($min -gt $sp[1]) { $sp[1] = $min } }
}
# per shape: the scheduled minutes a trip takes end to end (the middle value of its trips)
$shapeMins = @{}
foreach ($tid in $tripSpan.Keys) {
    $sid = $trips[$tid].shape_id; $m = $tripSpan[$tid][1] - $tripSpan[$tid][0]
    if ($sid -and $m -gt 0) { if (-not $shapeMins[$sid]) { $shapeMins[$sid] = New-Object System.Collections.Generic.List[int] }; $shapeMins[$sid].Add($m) }
}

# shapes: points in order, thinned to one about every 15 m so the file stays small
$pts = @{}
foreach ($p in & $csv 'shapes') {
    if (-not $pts[$p.shape_id]) { $pts[$p.shape_id] = New-Object System.Collections.Generic.List[object] }
    $pts[$p.shape_id].Add(@([int]$p.shape_pt_sequence, [double]$p.shape_pt_lon, [double]$p.shape_pt_lat))
}
$features = foreach ($sid in $pts.Keys) {
    $rid = $shapeRoute[$sid]; if (-not $rid) { continue }
    $r = $routes[$rid]
    $sorted = $pts[$sid] | Sort-Object { $_[0] }
    $line = New-Object System.Collections.Generic.List[object]
    $last = $null; $len = 0.0; $prev = $null
    foreach ($q in $sorted) {
        if ($prev) { $ddx = ($q[1] - $prev[1]) * 76000; $ddy = ($q[2] - $prev[2]) * 111000; $len += [math]::Sqrt($ddx * $ddx + $ddy * $ddy) }
        $prev = $q
        if ($last) {
            $dx = ($q[1] - $last[1]) * 76000; $dy = ($q[2] - $last[2]) * 111000   # meters, near 47°N
            if ([math]::Sqrt($dx * $dx + $dy * $dy) -lt 15) { continue }
        }
        $line.Add(@([math]::Round($q[1], 5), [math]::Round($q[2], 5))); $last = $q
    }
    $end = $sorted[-1]; $line.Add(@([math]::Round($end[1], 5), [math]::Round($end[2], 5)))
    if ($line.Count -lt 2) { continue }
    # typical speed along this shape, stops included (meters per second), for arrival estimates
    $mps = $null
    if ($shapeMins[$sid]) { $ms = @($shapeMins[$sid] | Sort-Object); $mps = [math]::Round($len / ($ms[[int][math]::Floor($ms.Count / 2)] * 60), 2) }
    [ordered]@{ type = 'Feature'; properties = [ordered]@{ route = $r.route_short_name; name = $r.route_long_name; color = "#$($r.route_color)"; shape = $sid; mps = $mps }
        geometry = [ordered]@{ type = 'LineString'; coordinates = $line.ToArray() } }
}
$stops = foreach ($s in & $csv 'stops') {
    if ($s.location_type -and $s.location_type -ne '0') { continue }
    $served = if ($stopRoutes[$s.stop_id]) { @($stopRoutes[$s.stop_id]) | Sort-Object } else { @() }
    if (-not $served.Count) { continue }
    [ordered]@{ type = 'Feature'; properties = [ordered]@{ id = $s.stop_id; name = $s.stop_name; routes = ($served -join ' ') }
        geometry = [ordered]@{ type = 'Point'; coordinates = @([math]::Round([double]$s.stop_lon, 5), [math]::Round([double]$s.stop_lat, 5)) } }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $dataDir 'bus-routes.json'), ([ordered]@{ type = 'FeatureCollection'; features = @($features) } | ConvertTo-Json -Depth 8 -Compress), $utf8)
[IO.File]::WriteAllText((Join-Path $dataDir 'bus-stops.json'), ([ordered]@{ type = 'FeatureCollection'; features = @($stops) } | ConvertTo-Json -Depth 6 -Compress), $utf8)
# data/bus-times.json: every scheduled departure from every stop, read when someone opens a stop
# (written by hand: ConvertTo-Json in Windows PowerShell wraps sorted arrays as {"value":...,"Count":...})
$stopJson = foreach ($sid in $stopTimes.Keys) {
    $rows = $stopTimes[$sid] | Sort-Object { $_[1] } | ForEach-Object { "[`"$($_[0])`",$($_[1]),$($_[2]),$($_[3])]" }
    "$($sid | ConvertTo-Json):[$($rows -join ',')]"
}
$timesJson = "{`"svc`":$(ConvertTo-Json @($services.ToArray()) -Depth 4 -Compress),`"heads`":$(ConvertTo-Json @($heads.ToArray()) -Compress),`"stops`":{$($stopJson -join ',')}}"
[IO.File]::WriteAllText((Join-Path $dataDir 'bus-times.json'), $timesJson, $utf8)
"bus routes: $(@($features).Count) shapes, stops: $(@($stops).Count), stop times: $(($stopTimes.Values | Measure-Object -Property Count -Sum).Sum)"
