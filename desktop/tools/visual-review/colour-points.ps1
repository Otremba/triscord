# Compares the colour at named points of a Discord capture and a triscord capture of the same state.
# Points are "name:x,y" in client-area coordinates (1280x900 window captures are cropped to 1264x892 first).
# Reports the largest per-channel difference (0-255). It measures surface colours, not shapes or text.
param(
  [Parameter(Mandatory)][string]$Reference,
  [Parameter(Mandatory)][string]$Implementation,
  [Parameter(Mandatory)][string]$Points,  # "name:x,y;name:x,y"
  [int]$Tolerance = 6
)
Add-Type -AssemblyName System.Drawing
function Open-Client([string]$path) {
  $bmp = New-Object Drawing.Bitmap (Resolve-Path $path).Path
  if ($bmp.Width -eq 1280 -and $bmp.Height -eq 900) {
    $crop = $bmp.Clone((New-Object Drawing.Rectangle 8, 0, 1264, 892), $bmp.PixelFormat); $bmp.Dispose(); return $crop
  }
  return $bmp
}
$a = Open-Client $Reference; $b = Open-Client $Implementation
$rows = foreach ($p in $Points.Split(";")) {
  $name, $xy = $p.Split(':'); $x, $y = $xy.Split(',') | ForEach-Object { [int]$_ }
  $c1 = $a.GetPixel($x, $y); $c2 = $b.GetPixel($x, $y)
  $d = [math]::Max([math]::Abs($c1.R - $c2.R), [math]::Max([math]::Abs($c1.G - $c2.G), [math]::Abs($c1.B - $c2.B)))
  [pscustomobject]@{
    Point = $name; At = "$x,$y"
    Discord = ('#{0:x2}{1:x2}{2:x2}' -f $c1.R, $c1.G, $c1.B); Triscord = ('#{0:x2}{1:x2}{2:x2}' -f $c2.R, $c2.G, $c2.B)
    MaxDiff = $d; Within = $(if ($d -le $Tolerance) { 'sim' } else { 'não' })
  }
}
$rows | Format-Table -AutoSize
$ok = ($rows | Where-Object Within -eq 'sim').Count
"Dentro da tolerância ($Tolerance): $ok de $($rows.Count)"
