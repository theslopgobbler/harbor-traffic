<#
  Uploads the site to GitHub (theslopgobbler/harbor-traffic) as one commit through the Git Data API,
  then makes sure GitHub Pages serves it at traffic.harborevents.org.
  Token: ..\events-watch\github-token.txt (fine-grained: Contents, Pages, Workflows = read/write on harbor-traffic).
  data\ is only uploaded the first time; after that the collector owns it. -Data names data files to upload
  anyway (e.g. -Data data/bus-times.json after rebuilding the bus schedule by hand).
#>
param([string]$Message = 'Update site', [string[]]$Data = @())
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$repo = 'theslopgobbler/harbor-traffic'
$domain = (Get-Content (Join-Path $root 'CNAME') -Raw).Trim()
$token = (Get-Content (Join-Path (Split-Path $root -Parent) 'events-watch\github-token.txt') -Raw).Trim()
$h = @{ Authorization = "Bearer $token"; 'User-Agent' = 'harbor-traffic'; Accept = 'application/vnd.github+json' }
$api = "https://api.github.com/repos/$repo"
function GH($method, $path, $body) {
    $p = @{ Method = $method; Uri = "$api$path"; Headers = $h }
    if ($body) { $p.Body = ($body | ConvertTo-Json -Depth 10 -Compress); $p.ContentType = 'application/json' }
    Invoke-RestMethod @p
}

# stamp this build: every ?v= in index.html gets the build time, and version.txt tells open pages to reload
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmm')
$indexFile = Join-Path $root 'index.html'
$html = [IO.File]::ReadAllText($indexFile) -replace '\?v=\w+"', "?v=$stamp`""
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($indexFile, $html, $utf8)
[IO.File]::WriteAllText((Join-Path $root 'version.txt'), $stamp, $utf8)

# files to publish: everything except secrets, local-only bits and anything .gitignore names
$skip = '^(notes/|wsdot-key\.txt|aisstream-key\.txt|github-token\.txt|\.git/|.*\.local\..*)'
$files = Get-ChildItem $root -Recurse -File -Force | ForEach-Object {
    $_.FullName.Substring($root.Length + 1).Replace('\', '/')
} | Where-Object { $_ -notmatch $skip }

# an empty repo has no branch yet; the Contents API can make the first commit
$head = $null
try { $head = (GH Get '/git/ref/heads/main').object.sha } catch {
    if ("$($_.ErrorDetails.Message)" -notmatch 'empty') { throw }
    GH Put '/contents/README.md' @{ message = 'Start'; content = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'README.md'))) } | Out-Null
    $head = (GH Get '/git/ref/heads/main').object.sha
}
$baseTree = (GH Get "/git/commits/$head").tree.sha
$remote = (GH Get "/git/trees/$($baseTree)?recursive=1").tree | ForEach-Object { $_.path }
# the collector owns data/: only seed files GitHub doesn't have yet, and never local test history
$files = $files | Where-Object { $_ -notmatch '^data/history/' -and -not ($_ -match '^data/' -and $remote -contains $_ -and $Data -notcontains $_) }

$tree = foreach ($f in $files) {
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root $f)))
    $blob = GH Post '/git/blobs' @{ content = $b64; encoding = 'base64' }
    @{ path = $f; mode = '100644'; type = 'blob'; sha = $blob.sha }
}
$newTree = GH Post '/git/trees' @{ base_tree = $baseTree; tree = @($tree) }
if ($newTree.sha -eq $baseTree) { 'No changes.' } else {
    $commit = GH Post '/git/commits' @{ message = $Message; tree = $newTree.sha; parents = @($head) }
    GH Patch '/git/refs/heads/main' @{ sha = $commit.sha } | Out-Null
    "Committed $($files.Count) files: $($commit.sha.Substring(0,7))"
}

# GitHub Pages from main, with the custom domain
try { $pages = GH Get '/pages' } catch { $pages = $null }
try {
    if (-not $pages) {
        GH Post '/pages' @{ source = @{ branch = 'main'; path = '/' } } | Out-Null
        'Turned on GitHub Pages.'
    }
    if (-not $pages -or $pages.cname -ne $domain) {
        GH Put '/pages' @{ cname = $domain; source = @{ branch = 'main'; path = '/' } } | Out-Null
        "Pages domain set to $domain."
    }
} catch {
    "Couldn't change the Pages settings with this token. In the repo: Settings > Pages > Deploy from a branch > main, / (root); custom domain $domain."
}
