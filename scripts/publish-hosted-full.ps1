param(
  [string]$Repository = 'tanhaoyu646-bit/rail-demo',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$distRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'dist-hosted')).Path
if (-not $distRoot.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝发布项目目录之外的文件：$distRoot"
}

$publishFiles = Get-ChildItem -LiteralPath $distRoot -Recurse -File
if ($publishFiles.Extension -contains '.map') { throw '完整托管包中存在 source map，停止发布。' }
$bundleText = ($publishFiles | Where-Object Extension -in '.js', '.css', '.html' |
  ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }) -join "`n"
if (([regex]::Matches($bundleText, '谭浩宇工作室').Count) -lt 1) { throw '左上角工作室水印检查未通过。' }
if ($bundleText -match 'right-hand-pinch-reference|uploaded-hand-photo-reference') { throw '检测到已废弃的二维手部资源。' }
$requiredAssets = @(
  'assets/models/hands/uploaded-hand-20260831.glb',
  'assets/models/railway-uniform-dispatcher-lite.glb',
  'assets/models/props/ic-card-lite.glb',
  'assets/models/props/work-card-lite.glb'
)
foreach ($asset in $requiredAssets) {
  if (-not (Test-Path -LiteralPath (Join-Path $distRoot $asset))) { throw "完整资产缺失：$asset" }
}

$credentialOutput = "protocol=https`nhost=github.com`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw 'GitHub 凭据不可用，请先在 GitHub Desktop 中完成登录。' }
$credential = @{}
foreach ($line in ($credentialOutput -split "`r?`n")) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { $credential[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
}
$token = $credential['password']
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Git Credential Manager 未返回 GitHub 访问凭据。' }
$headers = @{
  Accept = 'application/vnd.github+json'
  Authorization = "Bearer $token"
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent' = 'rail-full-hosted-publisher'
}
$apiRoot = "https://api.github.com/repos/$Repository"

function Invoke-GitHubJson {
  param([string]$Method, [string]$Uri, $Body = $null)
  $parameters = @{ Method = $Method; Uri = $Uri; Headers = $headers }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  Invoke-RestMethod @parameters
}

$reference = Invoke-GitHubJson -Method Get -Uri "$apiRoot/git/ref/heads/$Branch"
$parentSha = $reference.object.sha
$treeElements = [System.Collections.Generic.List[object]]::new()
$completed = 0
foreach ($file in $publishFiles) {
  $relativePath = [IO.Path]::GetRelativePath($distRoot, $file.FullName).Replace('\', '/')
  $blob = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/blobs" -Body @{
    content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))
    encoding = 'base64'
  }
  $treeElements.Add(@{ path = $relativePath; mode = '100644'; type = 'blob'; sha = $blob.sha })
  $completed += 1
  Write-Progress -Activity '上传完整网页版' -Status "$completed / $($publishFiles.Count)" -PercentComplete ($completed * 100 / $publishFiles.Count)
}

$readmeText = @"
# 出勤虚拟仿真 · 完整交互托管版

在线体验：<https://tanhaoyu646-bit.github.io/rail-demo/>

此仓库保存浏览器可运行的构建结果。网页加载的三维模型和图片可被浏览器下载；正式源码仍保存在私人仓库。

© 2026 谭浩宇工作室。保留所有权利；未经许可不得复制、再发布或用于商业用途。
"@
$readmeBlob = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/blobs" -Body @{
  content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($readmeText))
  encoding = 'base64'
}
$treeElements.Add(@{ path = 'README.md'; mode = '100644'; type = 'blob'; sha = $readmeBlob.sha })

$tree = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/trees" -Body @{ tree = $treeElements }
$commit = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/commits" -Body @{
  message = '发布完整交互托管版'
  tree = $tree.sha
  parents = @($parentSha)
}
[void](Invoke-GitHubJson -Method Patch -Uri "$apiRoot/git/refs/heads/$Branch" -Body @{ sha = $commit.sha; force = $false })

$token = $null
$credentialOutput = $null
Write-Progress -Activity '上传完整网页版' -Completed
Write-Output ([pscustomobject]@{
  Repository = $Repository
  Branch = $Branch
  Commit = $commit.sha
  PublishedFiles = $publishFiles.Count + 1
  PublicBytes = ($publishFiles | Measure-Object Length -Sum).Sum
})
