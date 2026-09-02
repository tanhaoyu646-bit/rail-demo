param(
  [string]$Repository = 'tanhaoyu646-bit/rail-demo',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$distRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'dist-public')).Path
$auditPath = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'reports/public-demo-audit.json')).Path
if (-not $distRoot.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝发布项目目录之外的文件：$distRoot"
}

$audit = Get-Content -Raw -LiteralPath $auditPath | ConvertFrom-Json
if ($audit.forbidden.Count -or $audit.sourceMaps.Count -or $audit.leakedAnswerFragments.Count -or $audit.requiredWatermarkCount -lt 1) {
  throw "公开版泄露审计未通过：$auditPath"
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'git'
$startInfo.ArgumentList.Add('credential')
$startInfo.ArgumentList.Add('fill')
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.UseShellExecute = $false
$credentialProcess = [System.Diagnostics.Process]::new()
$credentialProcess.StartInfo = $startInfo
[void]$credentialProcess.Start()
$credentialProcess.StandardInput.Write("protocol=https`nhost=github.com`n`n")
$credentialProcess.StandardInput.Close()
$credentialOutput = $credentialProcess.StandardOutput.ReadToEnd()
$credentialProcess.WaitForExit()
if ($credentialProcess.ExitCode -ne 0) { throw 'GitHub 凭据不可用，请先在 GitHub Desktop 中完成登录。' }

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
  'User-Agent' = 'rail-public-demo-publisher'
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

try {
  $reference = Invoke-GitHubJson -Method Get -Uri "$apiRoot/git/ref/heads/$Branch"
} catch {
  if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
  $readme = @"
# 出勤虚拟仿真 · 公开轻量体验版

本仓库只保存可公开访问的减量构建结果，不包含私人正式版源码、高精三维模型、正式题库、答案或评分规则。

© 2026 谭浩宇工作室。保留所有权利；未经许可不得复制、再发布或用于商业用途。
"@
  $initial = @{
    message = '初始化公开轻量体验版'
    content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($readme))
  }
  [void](Invoke-GitHubJson -Method Put -Uri "$apiRoot/contents/README.md" -Body $initial)
  $reference = Invoke-GitHubJson -Method Get -Uri "$apiRoot/git/ref/heads/$Branch"
}

$parentSha = $reference.object.sha
$treeElements = [System.Collections.Generic.List[object]]::new()
$publishFiles = Get-ChildItem -LiteralPath $distRoot -Recurse -File
foreach ($file in $publishFiles) {
  $relativePath = [IO.Path]::GetRelativePath($distRoot, $file.FullName).Replace('\', '/')
  $blob = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/blobs" -Body @{
    content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))
    encoding = 'base64'
  }
  $treeElements.Add(@{ path = $relativePath; mode = '100644'; type = 'blob'; sha = $blob.sha })
}

$readmeText = @"
# 出勤虚拟仿真 · 公开轻量体验版

在线体验：<https://tanhaoyu646-bit.github.io/rail-demo/>

本仓库只保存可公开访问的减量构建结果，不包含私人正式版源码、高精三维模型、正式题库、答案或评分规则。

© 2026 谭浩宇工作室。保留所有权利；未经许可不得复制、再发布或用于商业用途。
"@
$readmeBlob = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/blobs" -Body @{
  content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($readmeText))
  encoding = 'base64'
}
$treeElements.Add(@{ path = 'README.md'; mode = '100644'; type = 'blob'; sha = $readmeBlob.sha })

$tree = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/trees" -Body @{ tree = $treeElements }
$commit = Invoke-GitHubJson -Method Post -Uri "$apiRoot/git/commits" -Body @{
  message = '发布公开轻量体验版'
  tree = $tree.sha
  parents = @($parentSha)
}
[void](Invoke-GitHubJson -Method Patch -Uri "$apiRoot/git/refs/heads/$Branch" -Body @{ sha = $commit.sha; force = $false })

$token = $null
$credentialOutput = $null
Write-Output ([pscustomobject]@{
  Repository = $Repository
  Branch = $Branch
  Commit = $commit.sha
  PublishedFiles = $publishFiles.Count + 1
  PublicBytes = $audit.totalBytes
})
