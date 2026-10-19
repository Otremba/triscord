# Automatic layout comparison between a Discord capture and a triscord capture of the same state.
# Extracts long straight edges (borders, dividers, card and panel edges) from both images and reports which
# lines of the reference have a counterpart within 1px in the implementation. Colours, fonts and the black
# theme do not matter; content differences (names, avatars) do not create lines. It measures layout geometry
# only: it is not a pixel-identity proof.
param(
  [Parameter(Mandatory)][string]$Reference,
  [Parameter(Mandatory)][string]$Implementation,
  [int]$MinRun = 60,
  [string]$Json = '',
  # Optional "x,y,w,h": only lines that start inside this region of the client area are compared.
  [string]$Region = ''
)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
public struct Line { public int Pos, A, B; }
public static class Layout {
  static float[] Luma(string path, out int w, out int h) {
    using (var bmp = new Bitmap(path)) {
      // A 1280x900 window capture has 8px invisible borders at left, right and bottom; compare the client area.
      int ox = 0;
      w = bmp.Width; h = bmp.Height;
      if (w == 1280 && h == 900) { ox = 8; w = 1264; h = 892; }
      var rect = new Rectangle(ox, 0, w, h);
      var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var bytes = new byte[data.Stride * h];
      System.Runtime.InteropServices.Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
      bmp.UnlockBits(data);
      var l = new float[w * h];
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int i = y * data.Stride + x * 4;
        l[y * w + x] = 0.2126f * bytes[i + 2] + 0.7152f * bytes[i + 1] + 0.0722f * bytes[i];
      }
      return l;
    }
  }
  // Lines: horizontal (vertical = false): Pos = y, [A,B] = x range; vertical: Pos = x, [A,B] = y range.
  public static List<Line> Extract(string path, bool vertical, int minRun, out int w, out int h) {
    var l = Luma(path, out w, out h);
    // Edge strength across the line direction; threshold is relative to the image so the black theme
    // (lower contrast) is compared with the same sensitivity as the lighter Discord surfaces.
    var grad = new float[w * h];
    var all = new List<float>();
    for (int y = 1; y < h - 1; y++) for (int x = 1; x < w - 1; x++) {
      float g = vertical ? Math.Abs(l[y * w + x + 1] - l[y * w + x - 1]) : Math.Abs(l[(y + 1) * w + x] - l[(y - 1) * w + x]);
      grad[y * w + x] = g; if (g > 0) all.Add(g);
    }
    all.Sort();
    float p = all.Count == 0 ? 0 : all[(int)(all.Count * 0.97)];
    float thr = Math.Max(3f, Math.Min(p * 0.5f, 6f));
    var lines = new List<Line>();
    int outer = vertical ? w : h, inner = vertical ? h : w;
    for (int a = 1; a < outer - 1; a++) {
      int start = -1, gaps = 0;
      for (int b = 0; b <= inner; b++) {
        bool on = b < inner && (vertical ? grad[b * w + a] : grad[a * w + b]) >= thr;
        if (on) { if (start < 0) start = b; gaps = 0; }
        else if (start >= 0) {
          gaps++;
          if (gaps > 2 || b == inner) {
            int end = b - gaps;
            if (end - start + 1 >= minRun) lines.Add(new Line { Pos = a, A = start, B = end });
            start = -1; gaps = 0;
          }
        }
      }
    }
    // Merge adjacent positions (a 2px-thick edge is one line).
    lines.Sort((x, y) => x.Pos != y.Pos ? x.Pos.CompareTo(y.Pos) : x.A.CompareTo(y.A));
    var merged = new List<Line>();
    foreach (var ln in lines) {
      bool joined = false;
      for (int i = merged.Count - 1; i >= 0 && ln.Pos - merged[i].Pos <= 1; i--) {
        var m = merged[i];
        if (Math.Min(m.B, ln.B) - Math.Max(m.A, ln.A) > 0.5 * Math.Min(m.B - m.A, ln.B - ln.A)) {
          m.A = Math.Min(m.A, ln.A); m.B = Math.Max(m.B, ln.B); merged[i] = m; joined = true; break;
        }
      }
      if (!joined) merged.Add(ln);
    }
    return merged;
  }
  public static bool Matches(Line r, List<Line> others, int tol) {
    foreach (var o in others) {
      if (Math.Abs(o.Pos - r.Pos) > tol) continue;
      int overlap = Math.Min(o.B, r.B) - Math.Max(o.A, r.A);
      if (overlap > 0.5 * (r.B - r.A) || overlap > 0.5 * (o.B - o.A)) return true;
    }
    return false;
  }
}
"@ -ReferencedAssemblies System.Drawing
$out = @()
foreach ($vertical in @($false, $true)) {
  $w1 = 0; $h1 = 0; $w2 = 0; $h2 = 0
  $ref = [Layout]::Extract((Resolve-Path $Reference), $vertical, $MinRun, [ref]$w1, [ref]$h1)
  $imp = [Layout]::Extract((Resolve-Path $Implementation), $vertical, $MinRun, [ref]$w2, [ref]$h2)
  if ($Region) {
    $rx, $ry, $rw, $rh = $Region.Split(',') | ForEach-Object { [int]$_ }
    $keep = { param($l) if ($vertical) { $l.Pos -ge $rx -and $l.Pos -lt $rx + $rw -and $l.B -ge $ry -and $l.A -lt $ry + $rh } else { $l.Pos -ge $ry -and $l.Pos -lt $ry + $rh -and $l.B -ge $rx -and $l.A -lt $rx + $rw } }
    $ref = @($ref | Where-Object { & $keep $_ }); $imp = @($imp | Where-Object { & $keep $_ })
  }
  $matched = 0; $missing = @(); $extra = @()
  foreach ($r in $ref) { if ([Layout]::Matches($r, $imp, 1)) { $matched++ } else { $missing += $r } }
  foreach ($i in $imp) { if (-not [Layout]::Matches($i, $ref, 1)) { $extra += $i } }
  $out += [pscustomobject]@{
    Direction = $(if ($vertical) { 'vertical' } else { 'horizontal' }); Size = "${w1}x${h1} / ${w2}x${h2}"
    RefLines = $ref.Count; ImpLines = $imp.Count; Matched = $matched
    Recall = $(if ($ref.Count) { [math]::Round(100.0 * $matched / $ref.Count, 1) } else { 100 })
    Missing = ($missing | Select-Object -First 8 | ForEach-Object { "$($_.Pos)[$($_.A)-$($_.B)]" }) -join ' '
    Extra = ($extra | Select-Object -First 8 | ForEach-Object { "$($_.Pos)[$($_.A)-$($_.B)]" }) -join ' '
  }
}
$out | Format-List
if ($Json) { $out | ConvertTo-Json | Set-Content -LiteralPath $Json -Encoding utf8 }
