param([string]$LinuxContainerImage)

$ErrorActionPreference = 'Stop'
$compilerRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $compilerRoot
try {
    if (!$LinuxContainerImage) { & ./service/runner/build.ps1 }
    Add-Type -AssemblyName System.IO.Compression
    $outputDirectory = Join-Path $PSScriptRoot 'output'
    New-Item -ItemType Directory -Force $outputDirectory | Out-Null
    function Invoke-Compiler([string]$source, [string]$device, [string]$gwc, [string]$report) {
        if ($LinuxContainerImage) {
            $sourceDirectory = Split-Path $source
            $outputDirectory = Split-Path $gwc
            $identity = "$(id -u):$(id -g)"
            & docker run --rm --network none --memory 512m --cpus 1 --user $identity --read-only `
                --cap-drop ALL --security-opt no-new-privileges `
                --mount "type=bind,source=$sourceDirectory,target=/input,readonly" `
                --mount "type=bind,source=$outputDirectory,target=/output" `
                $LinuxContainerImage "/input/$(Split-Path -Leaf $source)" $device `
                "/output/$(Split-Path -Leaf $gwc)" "/output/$(Split-Path -Leaf $report)"
        } else {
            & ./bin/Release/CompilerJob.exe $source $device $gwc $report
        }
    }
    $sourceDirectory = Join-Path $outputDirectory 'input'
    $outputDirectory = Join-Path $outputDirectory 'results'
    New-Item -ItemType Directory -Force $outputDirectory | Out-Null
    New-Item -ItemType Directory -Force $sourceDirectory | Out-Null
    function Write-TestPackage([string]$name, [string]$lua, [byte[]]$image) {
        $packagePath = Join-Path $sourceDirectory ($name + '.gwz')
        $packageStream = [System.IO.File]::Open($packagePath, [System.IO.FileMode]::Create)
        $packageZip = [System.IO.Compression.ZipArchive]::new($packageStream, [System.IO.Compression.ZipArchiveMode]::Create)
        $packageWriter = [System.IO.StreamWriter]::new($packageZip.CreateEntry('cartridge.lua').Open())
        $packageWriter.Write($lua)
        $packageWriter.Dispose()
        if ($image) {
            $imageEntry = $packageZip.CreateEntry('poster.bmp').Open()
            $imageEntry.Write($image, 0, $image.Length)
            $imageEntry.Dispose()
        }
        $packageZip.Dispose()
        $packageStream.Dispose()
        return $packagePath
    }
    # These tests execute only the trusted Lua below. Never use this command on
    # user uploads: those must run in the network-isolated container.
    $trustedLua = 'require "Wherigo"; local cart = Wherigo.ZCartridge(); cart.Id = "0e8bc5ec-fdf1-44f5-b17a-7985e9861b69"; cart.Name = "Compiler smoke test"; cart.Description = "Trusted test fixture"; cart.Activity = "Tour guide"; cart.Author = "Wherigo"; cart.StartingLocation=false; cart.Media=false; cart.Icon=false; return cart'
    # Create a 400 x 40, 24-bit BMP and attach it as the cartridge poster.
    $image = [byte[]]::new(54 + 400 * 40 * 3)
    $image[0] = 0x42
    $image[1] = 0x4d
    [BitConverter]::GetBytes($image.Length).CopyTo($image, 2)
    $image[10] = 54
    $image[14] = 40
    [BitConverter]::GetBytes(400).CopyTo($image, 18)
    [BitConverter]::GetBytes(40).CopyTo($image, 22)
    $image[26] = 1
    $image[28] = 24
    $trustedLua = $trustedLua.Replace('cart.Media=false;', 'local poster = Wherigo.ZMedia(cart); poster.Resources = {{Filename="poster.bmp", Type="bmp", Directives={}}}; cart.Media = poster;')
    $sourcePackage = Write-TestPackage 'valid' $trustedLua $image
    $devices = @('Emulator','Garmin','iPad','iPhone','OpenWIG','PPC2003','WFPlayer','WhereYouGo','XMarksTheSpot')
    foreach ($device in $devices) {
        $gwc = Join-Path $outputDirectory ($device + '.gwc')
        $report = Join-Path $outputDirectory ($device + '.json')
        Invoke-Compiler $sourcePackage $device $gwc $report
        $result = Get-Content -Raw $report | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or !$result.ok) { throw ($device + ': ' + ($result.messages -join '; ')) }
        $bytes = [System.IO.File]::ReadAllBytes($gwc)
        if ([BitConverter]::ToString($bytes,0,7) -ne '02-0A-43-41-52-54-00') { throw 'Invalid GWC signature' }
        $chunkOffset = [BitConverter]::ToInt32($bytes,11)
        if ([BitConverter]::ToString($bytes,$chunkOffset+4,12) -ne '1B-4C-75-61-51-00-01-04-04-04-08-00') { throw 'Invalid Win32-compatible Lua 5.1 bytecode' }
        if ($device -in 'Garmin', 'iPhone', 'iPad') {
            $mediaOffset = [BitConverter]::ToInt32($bytes, 17)
            if ($bytes[$mediaOffset] -ne 1 -or [BitConverter]::ToInt32($bytes, $mediaOffset + 1) -ne 3 -or
                [BitConverter]::ToString($bytes, $mediaOffset + 9, 2) -ne 'FF-D8') {
                throw "$device did not convert the BMP poster to JPEG"
            }
        }
        Write-Output "PASS: $device GWC header and Lua bytecode"
    }
    foreach ($lua in @('this is invalid lua', "local value = 1`nif true then")) {
        $badSource = Write-TestPackage 'invalid' $lua
        $report = Join-Path $outputDirectory 'invalid.json'
        Invoke-Compiler $badSource 'Garmin' (Join-Path $outputDirectory 'invalid.gwc') $report
        $result = Get-Content -Raw $report | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -or $result.ok -or $result.messages[0] -notmatch 'line') { throw 'Lua error diagnostics failed' }
        if (($result.messages -join ' ') -match 'Index was outside') { throw 'Lua diagnostic indexing regressed' }
        Write-Output 'PASS: Lua syntax error retains line diagnostics'
    }
    # Expected negative tests return 1 from the adapter. GitHub's pwsh wrapper
    # otherwise propagates that last native exit code despite successful checks.
    $global:LASTEXITCODE = 0
} finally { Pop-Location }
