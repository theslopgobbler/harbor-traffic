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
$dl = Invoke-WebRequest -UseBasicParsing 'http://mjcaction.com/MJC_GTFS_Public/graysharbor_google_transit.zip' -OutFile $zip -TimeoutSec 120 -PassThru
Expand-Archive $zip -DestinationPath $tmp -Force
$csv = { param($n) Import-Csv (Join-Path $tmp "$n.txt") }
# data/schedule-status.json: which version of GHT's file this is (its date on their server: the collector rebuilds when
# that changes) and the last day it covers (the stats page warns as that gets close)
$feedEnd = $null
if (Test-Path (Join-Path $tmp 'feed_info.txt')) { $feedEnd = (& $csv 'feed_info' | Select-Object -First 1).feed_end_date }
if (-not $feedEnd) { $feedEnd = (& $csv 'calendar' | ForEach-Object { $_.end_date } | Sort-Object | Select-Object -Last 1) }
# (fixes: which version of routes/route-fixes.json went in, so the collector rebuilds when it changes)
$fixPath = Join-Path $root 'routes/route-fixes.json'
$fixHash = if (Test-Path $fixPath) { (Get-FileHash $fixPath -Algorithm SHA1).Hash } else { '' }
[IO.File]::WriteAllText((Join-Path $dataDir 'schedule-status.json'), ([ordered]@{ built = [DateTimeOffset]::UtcNow.ToString('o')
    fileModified = "$($dl.Headers['Last-Modified'])"; feedEnd = "$feedEnd"; fixes = $fixHash } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

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
# Clean a route line: GHT's shapes have little out-and-back jabs and tiny loops (pulling into a stop bay or a
# parking lot and back out) that look like scribbles on the map and make the predicted bus jerk around. Those go,
# so the line follows the road.
function Get-M($a, $b) { $dx = ($b[0] - $a[0]) * 76000; $dy = ($b[1] - $a[1]) * 111000; [math]::Sqrt($dx * $dx + $dy * $dy) }
function Get-Brg($a, $b) { ([math]::Atan2(($b[0] - $a[0]) * 0.68, $b[1] - $a[1]) * 180 / [math]::PI + 360) % 360 }
function Get-Turn($a, $b, $c) { $t = [math]::Abs(((Get-Brg $b $c) - (Get-Brg $a $b) + 540) % 360 - 180); $t }
function Get-CleanLine($line, [switch]$Quick) {
    $changed = $true; $guard = 0
    # (-Quick, for a line already following the streets: one pass for jabs, no loop search; those lines are long)
    $maxPass = if ($Quick) { 1 } else { 50 }
    while ($changed -and $guard -lt $maxPass) {
        $changed = $false; $guard++
        # a jab: the line goes out and comes straight back the same way (turns more than 150°, and the points either
        # side of the tip end up within 20 m of each other): drop the tip. A tight U around a block isn't one:
        # its two sides are a block apart.
        for ($i = 1; $i -lt $line.Count - 1; $i++) {
            $legA = Get-M $line[$i - 1] $line[$i]; $legB = Get-M $line[$i] $line[$i + 1]
            if ([math]::Min($legA, $legB) -lt 80 -and (Get-M $line[$i - 1] $line[$i + 1]) -lt 20 -and
                (Get-Turn $line[$i - 1] $line[$i] $line[$i + 1]) -gt 150) { $line.RemoveAt($i); $changed = $true; $i-- }
        }
        # a small loop: the line comes back within 15 m of where it was after under 200 m: cut the loop out
        if ($Quick) { continue }
        for ($i = 0; $i -lt $line.Count - 3; $i++) {
            $run = 0.0
            for ($j = $i + 1; $j -lt [math]::Min($line.Count, $i + 14); $j++) {
                $run += Get-M $line[$j - 1] $line[$j]
                if ($run -gt 200) { break }
                if ($j -ge $i + 3 -and (Get-M $line[$i] $line[$j]) -lt 15) { $line.RemoveRange($i + 1, $j - $i - 1); $changed = $true; break }
            }
        }
    }
    # a removed jab leaves the same point twice in a row (and a line with no length between them confuses which
    # way it's going): keep one
    for ($i = $line.Count - 1; $i -ge 1; $i--) { if ((Get-M $line[$i - 1] $line[$i]) -lt 1) { $line.RemoveAt($i) } }
    # (cleans the list in place; returns nothing, since PowerShell would unroll a returned list)
}

# Follow the streets: GHT's lines are sparse in places (points up to 1 km apart), so drawn straight they cut across
# blocks. Each line's points go to the public OSRM router as waypoints and come back as the path along the
# streets between them. A leg that comes back much longer than the straight line (the router went around
# something) keeps the straight line. Answers are kept in data/route-snap.json by the line's points, so the router
# is only asked again when GHT changes a route.
$snapFile = Join-Path $dataDir 'route-snap.json'
$snapCache = @{}
if (Test-Path $snapFile) { try { foreach ($p in (Get-Content $snapFile -Raw | ConvertFrom-Json).PSObject.Properties) { $snapCache[$p.Name] = $p.Value } } catch {} }
$snapUsed = @{}
$script:newSnaps = 0
# (written by hand to keep the nested lists intact in Windows PowerShell)
function Save-Snaps($table) {
    $parts = foreach ($k in $table.Keys) { "`"$k`":[" + ((@($table[$k]) | ForEach-Object { "[$($_[0]),$($_[1])]" }) -join ',') + ']' }
    [IO.File]::WriteAllText($snapFile, "{$($parts -join ',')}", (New-Object System.Text.UTF8Encoding($false)))
}
$sha = [Security.Cryptography.SHA1]::Create()
function Get-SnapKey($line) {
    $txt = ($line | ForEach-Object { "$($_[0]),$($_[1])" }) -join ';'
    ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($txt))) -replace '-', '').Substring(0, 20)
}
function Set-Snapped($line) {
    $gap = $false; for ($i = 1; $i -lt $line.Count; $i++) { if ((Get-M $line[$i - 1] $line[$i]) -gt 120) { $gap = $true; break } }
    if (-not $gap) { return }
    $key = Get-SnapKey $line
    if ($snapCache.ContainsKey($key)) { $res = $snapCache[$key] }
    else {
        $acc = New-Object System.Collections.Generic.List[object]
        $ok = $true
        # 40 waypoints per request (the next request starts where this one ended)
        for ($s = 0; $s -lt $line.Count - 1; $s += 39) {
            $wp = @($line.GetRange($s, [math]::Min(40, $line.Count - $s)))
            $coords = ($wp | ForEach-Object { "$($_[0]),$($_[1])" }) -join ';'
            try {
                Start-Sleep -Milliseconds 1100   # the public router asks for at most one request a second
                $rt = Invoke-RestMethod "https://router.project-osrm.org/route/v1/driving/$($coords)?overview=false&steps=true&geometries=geojson" -TimeoutSec 60
            } catch { $ok = $false; break }
            $legs = @($rt.routes[0].legs)
            if ($legs.Count -ne $wp.Count - 1) { $ok = $false; break }
            for ($k = 0; $k -lt $legs.Count; $k++) {
                $straight = Get-M $wp[$k] $wp[$k + 1]
                $pts2 = New-Object System.Collections.Generic.List[object]
                foreach ($st in $legs[$k].steps) { foreach ($c in $st.geometry.coordinates) { $pts2.Add(@([math]::Round([double]$c[0], 5), [math]::Round([double]$c[1], 5))) } }
                if ($pts2.Count -lt 2 -or $legs[$k].distance -gt $straight * 1.8 + 150) { $pts2 = [System.Collections.Generic.List[object]]@($wp[$k], $wp[$k + 1]) }
                foreach ($c in $pts2) {
                    # one point every 15 m or more is plenty (the router's paths are dense)
                    if ($acc.Count -and (Get-M $acc[$acc.Count - 1] $c) -lt 15) { continue }
                    $acc.Add($c)
                }
            }
        }
        if (-not $ok) { return }   # the router didn't answer: keep the line as it was this time
        $res = $acc.ToArray()
        $snapCache[$key] = $res
        # save as it goes, so a build that's stopped partway doesn't have to ask the router again
        $script:newSnaps++
        if ($script:newSnaps % 5 -eq 0) { Save-Snaps $snapCache }
    }
    $snapUsed[$key] = $res
    $line.Clear(); foreach ($c in $res) { $line.Add(@([double]$c[0], [double]$c[1])) }
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
    Get-CleanLine $line
    if ($line.Count -lt 2) { continue }
    Set-Snapped $line
    Get-CleanLine $line -Quick   # (a waypoint just off the road can leave a little out-and-back of its own)
    # length along the cleaned line (what the bus is drawn moving along)
    $len = 0.0; for ($i = 1; $i -lt $line.Count; $i++) { $len += Get-M $line[$i - 1] $line[$i] }
    # typical speed along this shape, stops included (meters per second), for arrival estimates
    $mps = $null
    if ($shapeMins[$sid]) { $ms = @($shapeMins[$sid] | Sort-Object); $mps = [math]::Round($len / ($ms[[int][math]::Floor($ms.Count / 2)] * 60), 2) }
    [ordered]@{ type = 'Feature'; properties = [ordered]@{ route = $r.route_short_name; name = $r.route_long_name; color = "#$($r.route_color)"; shape = $sid; mps = $mps }
        geometry = [ordered]@{ type = 'LineString'; coordinates = $line.ToArray() } }
}
$features = @($features)

# Where buses really drive (routes/route-fixes.json, from Harbor Traffic's own bus log): GHT's lines have stretches
# no bus takes (a dead end where buses loop around a block, a road buses skip). Each fix is a path; in each of GHT's
# lines that runs this way, the stretch between where the path leaves the line and where it rejoins is swapped for
# it ("replace": buses on those trips practically never take GHT's stretch), or a second copy of the line with the
# path swapped in is added beside it ("add": buses take both ways). Only lines going the path's way (or either way,
# "both") are touched. When no line lines up, the path is added as a short line of its own. Lines then carry on as
# usual: the map holds buses to them and the relay's off-route squares (route-cells, below) include them.
function Get-SegDist($p, $a, $b) {
    $ax = ($a[0] - $p[0]) * 76000; $ay = ($a[1] - $p[1]) * 111000; $dx = ($b[0] - $a[0]) * 76000; $dy = ($b[1] - $a[1]) * 111000
    $L = $dx * $dx + $dy * $dy; $t = if ($L) { [math]::Max(0, [math]::Min(1, - ($ax * $dx + $ay * $dy) / $L)) } else { 0 }
    [math]::Sqrt([math]::Pow($ax + $t * $dx, 2) + [math]::Pow($ay + $t * $dy, 2))
}
function Get-LineDist($p, $line) { $best = 1e9; for ($i = 0; $i -lt $line.Count - 1; $i++) { $d = Get-SegDist $p $line[$i] $line[$i + 1]; if ($d -lt $best) { $best = $d } }; $best }
function Get-Len($line, $i, $j) { $s = 0.0; for ($k = $i; $k -lt $j; $k++) { $s += Get-M $line[$k] $line[$k + 1] }; $s }
function Get-Splice($line, $B) {
    # where the path leaves this line (A) and rejoins it (Z): its points within 25 m of the line at either end are shared
    $kA = 0; while ($kA -lt $B.Count - 1 -and (Get-LineDist $B[$kA + 1] $line) -le 25) { $kA++ }
    $kZ = $B.Count - 1; while ($kZ -gt $kA -and (Get-LineDist $B[$kZ - 1] $line) -le 25) { $kZ-- }
    if ($kZ - $kA -lt 1) { return $null }
    $A = $B[$kA]; $Z = $B[$kZ]; $dA = Get-LineDist $A $line; $dZ = Get-LineDist $Z $line
    if ($dA -gt 60 -or $dZ -gt 60) { return $null }
    # each time the line comes by A (or Z): the closest point of that pass
    $passes = { param($P, $tol)
        $out = New-Object System.Collections.Generic.List[object]; $cur = $null
        for ($i = 0; $i -lt $line.Count; $i++) {
            $d = Get-M $line[$i] $P
            if ($d -le $tol) { if ($cur -and $i - $cur.last -le 3) { $cur.last = $i; if ($d -lt $cur.d) { $cur.d = $d; $cur.i = $i } } else { $cur = @{ i = $i; d = $d; last = $i }; $out.Add($cur) } }
        }
        , $out
    }
    $pa = & $passes $A ([math]::Max(35, $dA + 20)); $pz = & $passes $Z ([math]::Max(35, $dZ + 20))
    $mid = [System.Collections.Generic.List[object]]@($B[$kA..$kZ]); $lb = Get-Len $mid 0 ($mid.Count - 1)
    $best = $null
    foreach ($a in $pa) { foreach ($z in $pz) {
        if ($z.i -le $a.i + 1) { continue }   # (A before Z along the line: it runs the path's way)
        $L = Get-Len $line $a.i $z.i
        if ($L -gt 3 * $lb + 1500) { continue }   # (not the line coming back around much later)
        $far = 0.0; for ($k = $a.i; $k -le $z.i; $k++) { $far = [math]::Max($far, (Get-LineDist $line[$k] $mid)) }
        if ($far -gt [math]::Max(500, 0.6 * $lb)) { continue }   # (a stretch that wanders off elsewhere isn't this one)
        if ($far -lt 30) { continue }   # (the line already goes the path's way)
        if (-not $best -or $L -lt $best.L) { $best = @{ ia = $a.i; iz = $z.i; L = $L } }
    } }
    if (-not $best) { return $null }
    $new = New-Object System.Collections.Generic.List[object]
    for ($k = 0; $k -le $best.ia; $k++) { $new.Add($line[$k]) }
    foreach ($c in $mid) { $new.Add(@([double]$c[0], [double]$c[1])) }
    for ($k = $best.iz; $k -lt $line.Count; $k++) { $new.Add($line[$k]) }
    # (where the path meets the line it can overshoot by a few meters: those little out-and-backs go, as above)
    Get-CleanLine $new -Quick
    , $new
}
$fixFile = Join-Path $root 'routes/route-fixes.json'
if (Test-Path $fixFile) {
    $fixed = 0; $added = 0; $alone = 0
    foreach ($fx in (Get-Content $fixFile -Raw | ConvertFrom-Json).fixes) {
        $path = [System.Collections.Generic.List[object]]@($fx.path | ForEach-Object { , @([double]$_[0], [double]$_[1]) })
        $ways = @(, $path); if ($fx.both) { $rev = [System.Collections.Generic.List[object]]@($path); $rev.Reverse(); $ways += , $rev }
        $lons = $path | ForEach-Object { $_[0] }; $lats = $path | ForEach-Object { $_[1] }
        $box = @((($lons | Measure-Object -Minimum).Minimum - 0.01), (($lats | Measure-Object -Minimum).Minimum - 0.007), (($lons | Measure-Object -Maximum).Maximum + 0.01), (($lats | Measure-Object -Maximum).Maximum + 0.007))
        $hits = 0; $extra = New-Object System.Collections.Generic.List[object]
        # (GHT's own lines only, with any earlier fix already swapped in; not the copies added for other fixes)
        foreach ($f in @($features | Where-Object { $_.properties.route -eq $fx.route -and -not $_.properties.fix })) {
            $line = [System.Collections.Generic.List[object]]@($f.geometry.coordinates)
            if (-not ($line | Where-Object { $_[0] -ge $box[0] -and $_[0] -le $box[2] -and $_[1] -ge $box[1] -and $_[1] -le $box[3] } | Select-Object -First 1)) { continue }
            foreach ($way in $ways) {
                $new = Get-Splice $line $way
                if (-not $new) { continue }
                $hits++
                if ($fx.mode -eq 'replace') { $f.geometry.coordinates = $new.ToArray(); $line = $new; $fixed++ }
                else { $p2 = [ordered]@{}; foreach ($k in $f.properties.Keys) { $p2[$k] = $f.properties[$k] }; $p2.shape = "$($p2.shape)+fix$($fx.id)"; $p2.fix = $fx.id
                    $extra.Add([ordered]@{ type = 'Feature'; properties = $p2; geometry = [ordered]@{ type = 'LineString'; coordinates = $new.ToArray() } }); $added++ }
            }
        }
        if (-not $hits) {
            # lined up with none of GHT's lines: the path on its own (and backwards too, for both ways)
            $r0 = @($features | Where-Object { $_.properties.route -eq $fx.route })[0]
            if ($r0) { foreach ($way in $ways) {
                $extra.Add([ordered]@{ type = 'Feature'; properties = [ordered]@{ route = $fx.route; name = $r0.properties.name; color = $r0.properties.color
                    shape = "fix$($fx.id)"; mps = $r0.properties.mps; fix = $fx.id }; geometry = [ordered]@{ type = 'LineString'; coordinates = $way.ToArray() } }); $alone++ } }
        }
        $features += $extra
    }
    "route fixes: $fixed lines corrected, $added corrected copies added, $alone paths on their own"
}

$stops = foreach ($s in & $csv 'stops') {
    if ($s.location_type -and $s.location_type -ne '0') { continue }
    $served = if ($stopRoutes[$s.stop_id]) { @($stopRoutes[$s.stop_id]) | Sort-Object } else { @() }
    if (-not $served.Count) { continue }
    [ordered]@{ type = 'Feature'; properties = [ordered]@{ id = $s.stop_id; name = $s.stop_name; routes = ($served -join ' ') }
        geometry = [ordered]@{ type = 'Point'; coordinates = @([math]::Round([double]$s.stop_lon, 5), [math]::Round([double]$s.stop_lat, 5)) } }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
# (with the date it was built inside, for the collector's once-a-week check: a fresh checkout makes every file look new)
[IO.File]::WriteAllText((Join-Path $dataDir 'bus-routes.json'), ([ordered]@{ type = 'FeatureCollection'; updated = [DateTimeOffset]::UtcNow.ToString('o'); features = @($features) } | ConvertTo-Json -Depth 8 -Compress), $utf8)
# the street paths, kept for next time (only the ones still in use)
Save-Snaps $snapUsed
# data/route-cells.json: which ~55 m squares each route's lines pass through, so the relay can tell cheaply when
# a bus is off its route (it logs those spots for the stats page). Square = floor(lat / 0.0005), floor(lon / 0.00073).
$cellsByRoute = @{}
foreach ($f in @($features)) {
    $rt = $f.properties.route -replace 'P$', ''
    if (-not $cellsByRoute[$rt]) { $cellsByRoute[$rt] = New-Object System.Collections.Generic.HashSet[string] }
    $set = $cellsByRoute[$rt]; $cs = $f.geometry.coordinates
    for ($i = 0; $i -lt $cs.Count; $i++) {
        $a = $cs[$i]; [void]$set.Add("$([math]::Floor($a[1] / 0.0005)),$([math]::Floor($a[0] / 0.00073))")
        if ($i -lt $cs.Count - 1) {
            $b = $cs[$i + 1]; $steps = [math]::Ceiling((Get-M $a $b) / 20)
            for ($k = 1; $k -lt $steps; $k++) {
                $lon = $a[0] + ($b[0] - $a[0]) * $k / $steps; $lat = $a[1] + ($b[1] - $a[1]) * $k / $steps
                [void]$set.Add("$([math]::Floor($lat / 0.0005)),$([math]::Floor($lon / 0.00073))")
            }
        }
    }
}
$cellJson = foreach ($rt in $cellsByRoute.Keys) { "`"$rt`":[" + ((@($cellsByRoute[$rt]) | ForEach-Object { "`"$_`"" }) -join ',') + ']' }
[IO.File]::WriteAllText((Join-Path $dataDir 'route-cells.json'), "{`"lat`":0.0005,`"lon`":0.00073,`"routes`":{$($cellJson -join ',')}}", $utf8)
& (Join-Path $PSScriptRoot 'pack-route-cells.ps1')
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
