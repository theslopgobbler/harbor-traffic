<#
  Grays Harbor Transit's published schedule data (GTFS) -> map files:
    data/bus-routes.json  one line per route shape, with the route's number, name and official color
    data/bus-stops.json   every stop, with the routes that serve it
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
$shapeRoute = @{}; $tripRoute = @{}
foreach ($t in & $csv 'trips') { $tripRoute[$t.trip_id] = $t.route_id; if ($t.shape_id) { $shapeRoute[$t.shape_id] = $t.route_id } }
$stopRoutes = @{}
foreach ($st in & $csv 'stop_times') {
    $rid = $tripRoute[$st.trip_id]; if (-not $rid) { continue }
    if (-not $stopRoutes[$st.stop_id]) { $stopRoutes[$st.stop_id] = New-Object System.Collections.Generic.HashSet[string] }
    [void]$stopRoutes[$st.stop_id].Add($routes[$rid].route_short_name)
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
    $last = $null
    foreach ($q in $sorted) {
        if ($last) {
            $dx = ($q[1] - $last[1]) * 76000; $dy = ($q[2] - $last[2]) * 111000   # meters, near 47°N
            if ([math]::Sqrt($dx * $dx + $dy * $dy) -lt 15) { continue }
        }
        $line.Add(@([math]::Round($q[1], 5), [math]::Round($q[2], 5))); $last = $q
    }
    $end = $sorted[-1]; $line.Add(@([math]::Round($end[1], 5), [math]::Round($end[2], 5)))
    if ($line.Count -lt 2) { continue }
    [ordered]@{ type = 'Feature'; properties = [ordered]@{ route = $r.route_short_name; name = $r.route_long_name; color = "#$($r.route_color)"; shape = $sid }
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
"bus routes: $(@($features).Count) shapes, stops: $(@($stops).Count)"
