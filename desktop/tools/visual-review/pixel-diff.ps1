# Pixel comparison of named regions between a Discord capture and a triscord capture of the same state.
# For each region it reports the share of pixels whose largest channel difference is within the tolerance
# and writes a side-by-side (Discord | triscord | difference) image. 1280x900 window captures are cropped to
# the 1264x892 client area first. It is a measurement, not a judgement: text, avatars and emoji differ by design.
param(
  [Parameter(Mandatory)][string]$Reference,
  [Parameter(Mandatory)][string]$Implementation,
  [Parameter(Mandatory)][string]$Regions,   # "name:x,y,w,h;name:x,y,w,h"
  [int]$Tolerance = 8,
  [string]$OutDir = ''
)
Add-Type -AssemblyName System.Drawing
function Open-Client([string]$path) {
  $bmp = New-Object Drawing.Bitmap (Resolve-Path $path).Path
  if ($bmp.Width -eq 1280 -and $bmp.Height -eq 900) {
    $crop = $bmp.Clone((New-Object Drawing.Rectangle 8, 0, 1264, 892), [Drawing.Imaging.PixelFormat]::Format32bppArgb); $bmp.Dispose(); return $crop
  }
  return $bmp.Clone((New-Object Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height), [Drawing.Imaging.PixelFormat]::Format32bppArgb)
}
$a = Open-Client $Reference; $b = Open-Client $Implementation
$rows = foreach ($r in $Regions.Split(';')) {
  $name, $box = $r.Split(':'); $x, $y, $w, $h = $box.Split(',') | ForEach-Object { [int]$_ }
  $diff = New-Object Drawing.Bitmap $w, $h; $same = 0
  for ($j = 0; $j -lt $h; $j++) { for ($i = 0; $i -lt $w; $i++) {
    $p = $a.GetPixel($x + $i, $y + $j); $q = $b.GetPixel($x + $i, $y + $j)
    $d = [math]::Max([math]::Abs($p.R - $q.R), [math]::Max([math]::Abs($p.G - $q.G), [math]::Abs($p.B - $q.B)))
    if ($d -le $Tolerance) { $same++; $diff.SetPixel($i, $j, [Drawing.Color]::FromArgb(40, 40, 40)) } else { $diff.SetPixel($i, $j, [Drawing.Color]::FromArgb(255, [math]::Min(255, 80 + $d), 40, 40)) }
  } }
  if ($OutDir) {
    $sheet = New-Object Drawing.Bitmap ($w * 3 + 8), $h; $g = [Drawing.Graphics]::FromImage($sheet); $g.Clear([Drawing.Color]::Gray)
    $g.DrawImage($a, (New-Object Drawing.Rectangle 0, 0, $w, $h), (New-Object Drawing.Rectangle $x, $y, $w, $h), [Drawing.GraphicsUnit]::Pixel)
    $g.DrawImage($b, (New-Object Drawing.Rectangle ($w + 4), 0, $w, $h), (New-Object Drawing.Rectangle $x, $y, $w, $h), [Drawing.GraphicsUnit]::Pixel)
    $g.DrawImage($diff, ($w * 2 + 8), 0); $sheet.Save((Join-Path $OutDir "pixeldiff-$name.png"))
  }
  [pscustomobject]@{ Region = $name; Box = "$x,$y ${w}x$h"; Pixels = $w * $h; Identical = $same; Percent = [math]::Round(100.0 * $same / ($w * $h), 1) }
}
$rows | Format-Table -AutoSize
