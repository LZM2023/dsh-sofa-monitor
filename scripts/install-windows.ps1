param(
  [Parameter(Mandatory=$true)][string]$DesktopEntry,
  [Parameter(Mandatory=$true)][string]$DshHome,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Profile,
  [Parameter(Mandatory=$true)][string]$PackagePath,
  [string]$TemplatePackagePath,
  [switch]$Upgrade
)
$ErrorActionPreference='Stop'
$sofaEntry=(Resolve-Path -LiteralPath $DesktopEntry).Path
$sofaPackage=(Resolve-Path -LiteralPath $PackagePath).Path
$sofaHome=(Resolve-Path -LiteralPath $DshHome).Path
if([IO.Path]::GetFileName($sofaEntry) -ne 'desktop-cli.js'){throw 'DesktopEntry 须为已安装 DSH Desktop 的 lib/desktop-cli.js'}
if([IO.Path]::GetExtension($sofaPackage) -ne '.tgz'){throw 'PackagePath 须为本地 tgz 安装包'}
$sofaProfileDir=Join-Path (Join-Path $sofaHome 'profiles') $Profile
$sofaManifest=Join-Path $sofaProfileDir 'package.json'
if(!(Test-Path -LiteralPath $sofaManifest)){throw '目标 profile 不存在；请在 DSH 中确认活动 profile'}
$sofaManifestBefore=Get-Content -Raw -LiteralPath $sofaManifest | ConvertFrom-Json
$sofaExists=$sofaManifestBefore.dependencies.PSObject.Properties.Name -contains 'dsh-sofa-monitor'
if($sofaExists -and !$Upgrade){throw '插件已存在；确认升级时须显式传入 -Upgrade。升级保留 .sofa-monitor 中的用户数据'}
if($Upgrade -and !$sofaExists){throw '目标 profile 尚未安装 SofaMonitor；首次安装请移除 -Upgrade'}
# Backups belong to the plugin data directory, not the profile root.
$sofaBackupTime=[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow,'China Standard Time')
$sofaBackupRoot=Join-Path (Join-Path $sofaProfileDir '.sofa-monitor') 'backups/install'
$sofaBackupDay=Join-Path $sofaBackupRoot $sofaBackupTime.ToString('yyyy-MM-dd')
$sofaBackup=Join-Path $sofaBackupDay ($sofaBackupTime.ToString('HHmmssfff')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $sofaBackup -Force | Out-Null
foreach($sofaName in @('package.json','pnpm-lock.yaml','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml')){
  $sofaSource=Join-Path $sofaProfileDir $sofaName
  if(Test-Path -LiteralPath $sofaSource){Copy-Item -LiteralPath $sofaSource -Destination (Join-Path $sofaBackup $sofaName)}
}
$sofaPreviousHome=$env:DSH_HOME
try{
  $env:DSH_HOME=$sofaHome
  $sofaPackages=@('file:'+$sofaPackage.Replace('\','/'))
  if($TemplatePackagePath){
    $sofaTemplates=(Resolve-Path -LiteralPath $TemplatePackagePath).Path
    if([IO.Path]::GetExtension($sofaTemplates) -ne '.tgz'){throw 'TemplatePackagePath 须为本地 tgz 安装包'}
    $sofaPackages+=('file:'+$sofaTemplates.Replace('\','/'))
  }
  & node $sofaEntry plugin --profile $Profile add @sofaPackages --save-exact
  if($LASTEXITCODE -ne 0){throw ('DSH 安装失败，退出码 '+$LASTEXITCODE+'；备份保留在 '+$sofaBackup)}
  $sofaAfter=Get-Content -Raw -LiteralPath $sofaManifest | ConvertFrom-Json
  if(!($sofaAfter.dependencies.PSObject.Properties.Name -contains 'dsh-sofa-monitor')){throw '安装后未找到插件依赖，请检查 DSH 日志'}
  if(!($sofaAfter.dsh.profile.bundles -contains 'dsh-sofa-monitor')){throw '插件未注册为 profile bundle，请检查 DSH 日志'}
  if($TemplatePackagePath -and (!($sofaAfter.dependencies.PSObject.Properties.Name -contains 'dsh-sofa-card-templates') -or !($sofaAfter.dsh.profile.bundles -contains 'dsh-sofa-card-templates'))){throw '规格卡模板插件未完成注册，请检查 DSH 日志'}
  Write-Output ('安装包已写入 profile；备份：'+$sofaBackup)
  $sofaAdapter=Join-Path $PSScriptRoot 'repair-desktop.mjs'
  if(Test-Path -LiteralPath $sofaAdapter){
    $sofaAppRoot=Split-Path -Parent (Split-Path -Parent $sofaEntry)
    & node $sofaAdapter --app-root $sofaAppRoot --apply
    if($LASTEXITCODE -ne 0){Write-Warning '插件已安装；桌面文件未通过适配校验，未强制覆盖。请保留诊断结果，外部助手与内嵌接口状态独立。'}
  }
  $sofaHelperRepair=Join-Path $PSScriptRoot 'repair-browser-helper.mjs'
  if(Test-Path -LiteralPath $sofaHelperRepair){
    & node $sofaHelperRepair --profile-root $sofaProfileDir --apply
    if($LASTEXITCODE -ne 0){Write-Warning '浏览器助手兼容适配未通过校验；请保留诊断，不强制覆盖未知版本。'}
  }
  Write-Output '尚未验证运行中加载。请保存当前工作，再按 DSH 提示重新加载并检查 SofaMonitor。'
}finally{
  if($null -eq $sofaPreviousHome){Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue}else{$env:DSH_HOME=$sofaPreviousHome}
}
