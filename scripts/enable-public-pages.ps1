param(
  [string]$Repository = 'tanhaoyu646-bit/rail-demo',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
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
  'User-Agent' = 'rail-public-demo-pages'
}
$pagesUri = "https://api.github.com/repos/$Repository/pages"
$source = @{ branch = $Branch; path = '/' }

try {
  $pages = Invoke-RestMethod -Method Get -Uri $pagesUri -Headers $headers
  if ($pages.source.branch -ne $Branch -or $pages.source.path -ne '/') {
    Invoke-RestMethod -Method Put -Uri $pagesUri -Headers $headers -ContentType 'application/json' -Body (@{
      build_type = 'legacy'; source = $source; https_enforced = $true
    } | ConvertTo-Json -Depth 4 -Compress)
  }
} catch {
  if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
  $pages = Invoke-RestMethod -Method Post -Uri $pagesUri -Headers $headers -ContentType 'application/json' -Body (@{
    build_type = 'legacy'; source = $source
  } | ConvertTo-Json -Depth 4 -Compress)
}

$token = $null
$credentialOutput = $null
Start-Sleep -Seconds 2
$pages = Invoke-RestMethod -Method Get -Uri $pagesUri -Headers $headers
Write-Output ([pscustomobject]@{
  Url = $pages.html_url
  Status = $pages.status
  Branch = $pages.source.branch
  Path = $pages.source.path
  HttpsEnforced = $pages.https_enforced
})
